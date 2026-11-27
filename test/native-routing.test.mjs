import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const entry = process.argv[2] ? resolve(process.argv[2], 'lib/message.mjs') : fileURLToPath(new URL('../lib/message.mjs', import.meta.url))
const home = mkdtempSync(join(tmpdir(), 'magi-native-'))
const configDir = join(home, '.magi')
mkdirSync(configDir)
const transport = join(home, 'transport.cjs')
writeFileSync(transport, [
  "const fs = require('node:fs')",
  "const request = JSON.parse(fs.readFileSync(0, 'utf8'))",
  "fs.appendFileSync(process.env.REQUEST_LOG, JSON.stringify(request) + '\\n')",
  "console.log(JSON.stringify({accepted: true}))"
].join('\n'))
const session = randomUUID()
const sender = 'session-' + randomUUID()
const env = { ...process.env, HOME: home, USERPROFILE: home, DSH_SESSION_ID: sender,
  CODEX_THREAD_ID: randomUUID(), REQUEST_LOG: join(home, 'requests.jsonl') }
writeFileSync(join(configDir, 'antigravity-windows.json'), JSON.stringify({
  python: process.execPath, transport, helper: 'win-send.py', sessions: [session]
}))
function send(target, source) {
  return spawnSync(process.execPath, [entry, 'send', 'antigravity/' + target,
    '原生路由验收', source, home], {env, encoding: 'utf8'})
}
const source = 'dsh/' + sender
const success = send(session, source)
assert.equal(success.status, 0, success.stderr)
const receipt = JSON.parse(success.stdout)
assert.equal(receipt.from, source)
assert.equal(receipt.status, 'accepted')
const wrongSender = send(session, 'codex/' + env.CODEX_THREAD_ID)
assert.notEqual(wrongSender.status, 0)
assert.match(wrongSender.stderr, /发送地址与宿主会话不一致/)
const unregistered = send(randomUUID(), source)
assert.notEqual(unregistered.status, 0)
assert.match(unregistered.stderr, /尚未登记/)
const delivery = JSON.parse(readFileSync(env.REQUEST_LOG, 'utf8').trim())
assert.equal(delivery.session, session)
assert.ok(delivery.body.startsWith('[DSH-Antigravity]\n原生路由验收\n'))
assert.ok(delivery.body.includes('python "win-send.py" reply ' + receipt.id))
console.log('通过：Windows 定向投递、宿主来源、未登记目标、原信回程')
