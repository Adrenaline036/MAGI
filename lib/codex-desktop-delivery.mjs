import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const clientVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i
const homeDefault = () => process.env.CODEX_HOME || join(process.env.USERPROFILE, '.codex')

export function callerThread(metadata = {}, env = process.env) {
  metadata ??= {}
  let turn = metadata['x-codex-turn-metadata']
  if (typeof turn === 'string') { try { turn = JSON.parse(turn) } catch { turn = null } }
  const id = turn?.thread_id ?? metadata['codex/threadId'] ?? metadata['openai/threadId'] ??
    metadata.thread_id ?? env.MAGI_CODEX_THREAD ?? env.CODEX_THREAD_ID
  return typeof id === 'string' && UUID.test(id) ? id : null
}

function appToolsServer(home) {
  const root = join(home, 'plugins', 'cache', 'openai-bundled', 'codex-app-tools')
  const versions = readdirSync(root).filter(x => /^\d+\.\d+\.\d+$/.test(x))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
  const file = versions.map(v => join(root, v, 'server.mjs')).find(existsSync)
  if (!file) throw new Error('Codex desktop app-tools MCP is not installed')
  return file
}

// Each endpoint receipt is immutable. A restart produces a new receipt; no live config is edited.
export function registerDesktopTarget({ thread, env = process.env, home = homeDefault() }) {
  if (!thread || !UUID.test(thread)) throw new Error('an exact Codex thread UUID is required')
  const pipe = env.CODEX_APP_TOOLS_PIPE_PATH
  if (!pipe) return null
  const server = appToolsServer(home)
  const root = join(home, 'magi-desktop-targets', thread)
  mkdirSync(root, { recursive: true })
  const key = createHash('sha256').update(pipe + '\n' + server).digest('hex')
  const file = join(root, key + '.json')
  const receipt = { thread, pipe, server, registeredAt: new Date().toISOString() }
  if (!existsSync(file)) {
    try { writeFileSync(file, JSON.stringify(receipt, null, 2), { flag: 'wx', mode: 0o600 }) }
    catch (error) { if (error.code !== 'EEXIST') throw error }
    const saved = JSON.parse(readFileSync(file, 'utf8'))
    if (saved.thread !== thread || saved.pipe !== pipe || saved.server !== server) throw new Error('endpoint readback mismatch')
  }
  return file
}

export function desktopTarget(thread, home = homeDefault()) {
  if (!UUID.test(thread)) throw new Error('an exact Codex thread UUID is required for steering')
  const root = join(home, 'magi-desktop-targets', thread)
  if (!existsSync(root)) throw new Error('No desktop endpoint for this thread; register it from its Codex environment first. Nothing was queued.')
  const entries = readdirSync(root).filter(x => /^[a-f0-9]{64}\.json$/.test(x))
    .map(x => JSON.parse(readFileSync(join(root, x), 'utf8')))
    .filter(x => x.thread === thread && typeof x.pipe === 'string' && typeof x.server === 'string')
    .sort((a, b) => Date.parse(b.registeredAt) - Date.parse(a.registeredAt))
  if (!entries[0]) throw new Error('No valid desktop endpoint for this thread. Nothing was queued.')
  return entries[0]
}

// Reuse the installed app-tools MCP. The app chooses steer for an active turn and starts an idle one.
// Failure after submission has an unknown delivery outcome: never retry or fall back to a queue.
export function sendDesktopMessage({ thread, message, target = desktopTarget(thread), timeoutMs = 30000, spawnImpl = spawn }) {
  if (target.thread !== thread || !UUID.test(thread)) throw new Error('desktop endpoint thread mismatch')
  if (typeof message !== 'string' || !message.trim()) throw new Error('a non-empty message is required')
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('timeoutMs must be finite and positive')
  return new Promise((resolve, reject) => {
    const child = spawnImpl(process.execPath, [target.server], {
      env: { ...process.env, CODEX_APP_TOOLS_PIPE_PATH: target.pipe }, windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let buffer = '', settled = false, submitted = false
    const finish = (error, result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.stdin.end()
      child.kill()
      error ? reject(error) : resolve(result)
    }
    const fail = reason => finish(new Error(`${reason}. ${submitted ? 'Delivery outcome may be unknown; inspect the target before retrying.' : 'No message submitted.'} Nothing was queued.`))
    const timer = setTimeout(() => fail('Desktop delivery timed out'), timeoutMs)
    const send = value => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n')
    child.on('error', error => fail(error.message))
    child.on('exit', () => { if (!settled) fail('App-tools MCP exited before acknowledgement') })
    child.stdin.on('error', error => fail(error.message))
    child.stderr.on('data', () => {})
    child.stdout.on('data', chunk => {
      buffer += chunk
      if (buffer.length > 8 * 1024 * 1024) return fail('App-tools response too large')
      let end
      while (!settled && (end = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1)
        let reply
        try { reply = JSON.parse(line) } catch { return fail('Invalid MCP response') }
        if (reply.id === 1) {
          if (submitted) continue
          if (reply.error) return fail('App-tools initialization failed')
          send({ method: 'notifications/initialized' })
          submitted = true
          send({ id: 2, method: 'tools/call', params: {
            name: 'send_message_to_thread', arguments: { threadId: thread, prompt: message },
            _meta: { 'x-codex-turn-metadata': { thread_id: thread }, 'openai/toolCallId': 'magi-' + randomUUID() },
          } })
        } else if (reply.id === 2) {
          if (!submitted || reply.error || reply.result?.isError || !Array.isArray(reply.result?.content)) return fail('Desktop send was not acknowledged')
          finish(null, { code: 0, stdout: JSON.stringify(reply.result), stderr: '', transport: 'codex-app-tools', delivery: 'accepted' })
        }
      }
    })
    send({ id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'magi', version: clientVersion } } })
  })
}
