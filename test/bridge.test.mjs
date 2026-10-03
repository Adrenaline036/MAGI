#!/usr/bin/env node
// Tests for dsh-collabridge. No DSH process, no network beyond loopback, no cost.
//
// The plugin is exercised through a FAKE cordis context: `apply()` is called with a
// minimal `agents` registry and an effect collector, so the real HTTP surface, the real
// routing, the real admission decision, and the real audit log all run for real. That
// proves the plugin's logic without loading it into a profile.

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { readSessionEvents, sessionLogFile, sessionsRoot, usageFromEvents, toolResultContent, toolCallsFromEvents } from '../lib/session-log.mjs'
import { markAnswer } from '../tools/transport/push-to-codex.mjs'
import {
  REVIEW_TIMEOUT_DEFAULT_MS,
  REVIEW_TIMEOUT_MAX_MS,
  TEST_TIMEOUT_DEFAULT_MS,
  TEST_TIMEOUT_MAX_MS,
  asSeconds,
  reviewTimeoutMs,
  testTimeoutMs,
} from '../lib/budgets.mjs'

let passed = 0
const failures = []
function check(name, condition, detail = '') {
  if (condition) {
    passed += 1
    return
  }
  failures.push(`${name}${detail ? ` -- ${detail}` : ''}`)
}

// A session directory exists from creation, but its log file appears only on the first flush.
// Reading in that window must yield an empty event list, not ENOENT: in the review path a throw
// here fails the whole package for a session that is perfectly healthy.
{
  const emptySession = mkdtempSync(join(tmpdir(), 'collab-empty-session-'))
  let threw = null
  let result = null
  try {
    result = readSessionEvents(emptySession)
  } catch (error) {
    threw = error
  }
  check('sessionlog: a session with no log yet does not throw', threw === null, threw?.message)
  check('sessionlog: it reports zero events', result?.events?.length === 0)
  check('sessionlog: it reports zero bytes', result?.bytes === 0)
  rmSync(emptySession, { recursive: true, force: true })

  const missingDir = join(tmpdir(), 'collab-definitely-absent-session-dir')
  let missingThrew = null
  try {
    readSessionEvents(missingDir)
  } catch (error) {
    missingThrew = error
  }
  check('sessionlog: a missing directory is treated as an empty log too', missingThrew === null)
}

// The log filename is generational (`session.v<N>.jsonl.zstd`) and older generations sit on
// disk under the legacy name. Reading a fixed name makes a whole generation of sessions look
// EMPTY rather than unreadable, which is the silent version of the failure: telemetry reads as
// zero model calls and a dead reviewer turn reports "no error was recorded". These checks fail
// if the reader ever goes back to one hard-coded filename.
{
  const frame = (event) => zstdCompressSync(Buffer.from(`${JSON.stringify(event)}\n`, 'utf8'))

  const v4Dir = mkdtempSync(join(tmpdir(), 'collab-v4-session-'))
  const v4Event = { type: 'assistant/message', seq: 7, data: { usage: { inputTokens: 10, outputTokens: 4, cacheReadTokens: 2, totalTokens: 16 } } }
  writeFileSync(join(v4Dir, 'session.v4.jsonl.zstd'), frame(v4Event))
  const v4 = readSessionEvents(v4Dir)
  check('sessionlog: a current-generation session.v4 log is read, not treated as empty', v4.events.length === 1, `got ${v4.events.length}`)
  check('sessionlog: it reports the file it read', v4.file === 'session.v4.jsonl.zstd', String(v4.file))
  check('sessionlog: it resolves the highest generation present', sessionLogFile(v4Dir)?.name === 'session.v4.jsonl.zstd')
  check('sessionlog: model calls are counted from the current usage shape', usageFromEvents(v4.events).modelCalls === 1)
  check(
    'sessionlog: the current usage shape reports its token fields',
    usageFromEvents(v4.events).totalTokens === 16 && usageFromEvents(v4.events).cacheHitRatio === Number((2 / 12).toFixed(4)),
  )
  rmSync(v4Dir, { recursive: true, force: true })

  const legacyDir = mkdtempSync(join(tmpdir(), 'collab-legacy-session-'))
  writeFileSync(
    join(legacyDir, 'session.jsonl.zstd'),
    frame({ type: 'assistant/chunk', data: { chunk: { type: 'usage', usage: { inputTokens: 5, outputTokens: 1, cacheReadTokens: 0, totalTokens: 6 } } } }),
  )
  const legacy = readSessionEvents(legacyDir)
  check('sessionlog: the legacy unversioned log is still read', legacy.events.length === 1 && legacy.file === 'session.jsonl.zstd', String(legacy.file))
  check('sessionlog: the legacy usage shape is still counted', usageFromEvents(legacy.events).modelCalls === 1)
  check('sessionlog: the unversioned name counts as the oldest generation', sessionLogFile(legacyDir)?.version === 0)
  rmSync(legacyDir, { recursive: true, force: true })

  const bothDir = mkdtempSync(join(tmpdir(), 'collab-both-session-'))
  writeFileSync(join(bothDir, 'session.jsonl.zstd'), frame(legacy.events[0]))
  writeFileSync(join(bothDir, 'session.v4.jsonl.zstd'), frame(v4Event))
  check('sessionlog: the newest generation wins when both are present', sessionLogFile(bothDir)?.name === 'session.v4.jsonl.zstd')
  check('sessionlog: the winner is the one actually read', readSessionEvents(bothDir).events[0]?.type === 'assistant/message')
  rmSync(bothDir, { recursive: true, force: true })

  const plainDir = mkdtempSync(join(tmpdir(), 'collab-plain-session-'))
  writeFileSync(join(plainDir, 'session.v4.jsonl'), `${JSON.stringify(v4Event)}\n${JSON.stringify({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })}\n`)
  const plain = readSessionEvents(plainDir)
  check('sessionlog: an uncompressed jsonl generation is read too', plain.events.length === 2, `got ${plain.events.length}`)
  rmSync(plainDir, { recursive: true, force: true })

  const noiseDir = mkdtempSync(join(tmpdir(), 'collab-noise-session-'))
  writeFileSync(join(noiseDir, 'session.lock'), '')
  writeFileSync(join(noiseDir, 'notes.txt'), 'not a session log')
  check('sessionlog: lock and unrelated files resolve to no log', sessionLogFile(noiseDir) === null)
  check('sessionlog: a directory with no log reads as zero events', readSessionEvents(noiseDir).events.length === 0)
  rmSync(noiseDir, { recursive: true, force: true })

  const dupEvents = [
    { type: 'assistant/message', data: { message: { id: 'm1' }, usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, totalTokens: 2 } } },
    { type: 'assistant/message', data: { message: { id: 'm1' }, usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, totalTokens: 2 } } },
  ]
  check('sessionlog: a replayed assistant message is not billed twice', usageFromEvents(dupEvents).modelCalls === 1)

  // A legacy-generation log carries BOTH shapes for the same call: the streaming chunk report and
  // the finished message. 827 of 864 session directories on this machine are of that kind, so
  // counting per-shape instead of per-call doubled every legacy session's tokens and call count.
  const bothShapesOneCall = [
    { type: 'assistant/chunk', data: { turn: 1, step: 1, chunk: { type: 'usage', usage: { inputTokens: 5, outputTokens: 2, cacheReadTokens: 3, totalTokens: 10 } } } },
    { type: 'assistant/message', data: { turn: 1, step: 1, message: { id: 'm-1a' }, usage: { inputTokens: 5, outputTokens: 2, cacheReadTokens: 3, totalTokens: 10 } } },
  ]
  const bothReported = usageFromEvents(bothShapesOneCall)
  check('sessionlog: one call recorded in both shapes is counted once', bothReported.modelCalls === 1, JSON.stringify(bothReported))
  check('sessionlog: and its tokens are not doubled', bothReported.inputTokens === 5 && bothReported.cacheReadTokens === 3, JSON.stringify(bothReported))

  // A call whose message has not been written yet still counts from its chunk, and a replayed
  // duplicate of an already-counted call still does not.
  const inFlight = [
    { type: 'assistant/chunk', data: { turn: 1, step: 1, chunk: { type: 'usage', usage: { inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, totalTokens: 1 } } } },
    { type: 'assistant/message', data: { turn: 1, step: 1, message: { id: 'm-1' }, usage: { inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, totalTokens: 1 } } },
    { type: 'assistant/chunk', data: { turn: 1, step: 2, chunk: { type: 'usage', usage: { inputTokens: 2, outputTokens: 0, cacheReadTokens: 0, totalTokens: 2 } } } },
    { type: 'assistant/chunk', data: { turn: 1, step: 2, chunk: { type: 'usage', usage: { inputTokens: 2, outputTokens: 0, cacheReadTokens: 0, totalTokens: 2 } } } },
  ]
  const inFlightReported = usageFromEvents(inFlight)
  check('sessionlog: an in-flight call counts from its chunk and a replay does not', inFlightReported.modelCalls === 2 && inFlightReported.totalTokens === 3, JSON.stringify(inFlightReported))
}

// Tool results, in both shapes the harness has written. The legacy shape nests the text under a
// wrapper block; the current one does not, and puts isError on the message. Reading only the
// nested path returns null for every current result, which loses the workflow's return value --
// the whole point of a review -- while leaving the run looking healthy. These checks fail if the
// reader goes back to one shape.
{
  const legacyShape = {
    role: 'tool',
    source: { kind: 'tool', callId: 'call-legacy' },
    content: [{ type: 'tool-result', content: [{ type: 'text', text: 'legacy body', isError: true }] }],
  }
  const currentShape = {
    role: 'tool',
    source: { kind: 'tool', callId: 'call-current' },
    content: [{ type: 'text', text: 'current body' }],
    isError: false,
  }
  check('tools: the legacy nested result shape still reads', toolResultContent(legacyShape).text === 'legacy body')
  check('tools: the legacy nested error flag still reads', toolResultContent(legacyShape).isError === true)
  check('tools: the current flat result shape reads', toolResultContent(currentShape).text === 'current body')
  check('tools: the current shape takes isError from the message', toolResultContent(currentShape).isError === false)
  check('tools: a message with no text yields null rather than throwing', toolResultContent({ content: [{ type: 'image' }] }).text === null)

  const call = { type: 'tool/call', seq: 1, data: { callId: 'call-current', name: 'workflow', arguments: '{}' } }
  const result = { type: 'tool/result', seq: 2, data: { message: currentShape } }
  const joined = toolCallsFromEvents([call, result])[0]
  check('tools: a current-shape result is joined to its call', joined?.resultText === 'current body' && joined?.isError === false, JSON.stringify(joined))

  // The marker the shell-command telemetry parses lives inside that text, so losing the text
  // also loses every exit code.
  const shellCall = { type: 'tool/call', seq: 3, data: { callId: 'call-shell', name: 'pwsh', arguments: '{"command":"exit 1"}' } }
  const shellResult = { type: 'tool/result', seq: 4, data: { message: { role: 'tool', source: { kind: 'tool', callId: 'call-shell' }, content: [{ type: 'text', text: 'boom\n[exit code: 1]' }], isError: true } } }
  const shell = toolCallsFromEvents([shellCall, shellResult])[0]
  check('tools: the exit-code marker survives in the current shape', /\[exit code: 1\]/.test(shell?.resultText ?? ''), String(shell?.resultText))
}

// --- isolated DSH_HOME -------------------------------------------------------
const home = mkdtempSync(join(tmpdir(), 'collabridge-home-'))
process.env.DSH_HOME = home

// Sessions must be looked up under the ACTIVE home. A hardcoded legacy home
// (%APPDATA%\dsh-desktop\harness) made the bridge read another installation's sessions and report
// "the conductor never called the workflow tool" for a review whose conductor had run fine.
check('sessionlog: the sessions root follows the active home, not a legacy path', sessionsRoot() === join(home, 'sessions'), sessionsRoot())
check('sessionlog: the sessions root is not the retired %APPDATA% home', !/dsh-desktop/i.test(sessionsRoot()), sessionsRoot())

const PROJECT = 'D:\\Examples\\Demo'
const OTHER_PROJECT = 'D:\\Examples\\Other'
const slug = (p) => `--${p.replace(/:/g, '').replace(/[\\/]/g, '-')}--`
mkdirSync(join(home, 'sessions', slug(PROJECT)), { recursive: true })
mkdirSync(join(home, 'sessions', slug(PROJECT), 'session-inferred-0001'), { recursive: true })
mkdirSync(join(home, 'sessions', slug(OTHER_PROJECT)), { recursive: true })

const { apply, inject, name } = await import('../lib/index.js')
const routing = await import('../lib/routing.js')

// --- fake cordis context -----------------------------------------------------
const disposers = []
const warnings = []
const agentsById = new Map()

function makeAgent(id) {
  const received = []
  return {
    id,
    status: 'idle',
    options: { cwd: PROJECT },
    received,
    followup: (message) => received.push({ mode: 'followup', message }),
    steer: (message) => received.push({ mode: 'steer', message }),
    inject: (message) => received.push({ mode: 'inject', message }),
  }
}

const liveAgent = makeAgent('session-live-0001')
agentsById.set(liveAgent.id, liveAgent)

const fakeCtx = {
  agents: {
    get: (id) => agentsById.get(id),
    roots: () => [...agentsById.values()],
  },
  effect: (fn) => {
    disposers.push(fn())
  },
  logger: { info: () => {}, warn: (...args) => warnings.push(args.join(' ')) },
}

apply(fakeCtx)

const discoveryFile = join(home, 'collab-bridge.json')
for (let i = 0; i < 200 && !existsSync(discoveryFile); i += 1) {
  await new Promise((r) => setTimeout(r, 25))
}
check('plugin: writes a discovery file', existsSync(discoveryFile))

const discovery = JSON.parse(readFileSync(discoveryFile, 'utf8'))
check('plugin: discovery carries a loopback port', Number.isInteger(discovery.port) && discovery.port > 0)
check('plugin: discovery carries a 64-hex token', /^[0-9a-f]{64}$/.test(discovery.token ?? ''))
check('plugin: binds loopback only', discovery.host === '127.0.0.1')
check('plugin: exports the cordis shape', name === 'collabridge' && Array.isArray(inject) && inject.includes('agents'))

async function call(pathname, { method = 'GET', body, token = discovery.token } = {}) {
  const response = await fetch(`http://127.0.0.1:${discovery.port}${pathname}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: response.status, body: JSON.parse(await response.text()) }
}

const textOf = (entry) => entry.message.content.map((block) => block.text ?? '').join('')

// --- routing resolution ------------------------------------------------------
check('routing: workspace slug matches the session directory convention', routing.workspaceSlug(PROJECT) === slug(PROJECT))
check('routing: normalises case and separators', routing.normaliseProject('D:\\Examples\\Demo\\') === 'd:/examples/demo')

const inferred = routing.resolveCollabSession({ project: PROJECT })
check('routing: infers the newest session when nothing is configured', inferred.session_id === 'session-inferred-0001', JSON.stringify(inferred))
check('routing: marks inference as unconfigured', inferred.configured === false && inferred.resolved_by === 'newest-session-for-workspace')

const unresolved = routing.resolveCollabSession({ project: 'D:\\Examples\\Nowhere' })
check('routing: never guesses an unresolved project', unresolved.session_id === null && unresolved.resolved_by === 'unresolved')

routing.setRoute({ project: PROJECT, node: 'bridge-design', sessionId: 'session-live-0001' })
const routed = routing.resolveCollabSession({ project: PROJECT })
check('routing: an explicit node route wins over inference', routed.session_id === 'session-live-0001' && routed.resolved_by === 'routes[bridge-design]')

// --- HTTP surface ------------------------------------------------------------
check('http: /health answers without a token', (await call('/health')).status === 200)

// /health's version is the "did the host half actually reload?" signal, so it must be the value
// captured when the module was loaded. Re-reading the manifest inside the handler reported the
// file on disk instead, which made the deployment check circular: it "confirmed" a version that
// the running process had never loaded. These checks pin the read to module load.
{
  const health = (await call('/health')).body
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  check('http: /health reports the packaged version', health.version === manifest.version, `${health.version} vs ${manifest.version}`)
  const indexSource = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  check(
    'http: /health reports the version captured at module load',
    /const PLUGIN_VERSION = readPluginVersion\(\)/.test(indexSource) && /version: PLUGIN_VERSION/.test(indexSource),
  )
  // Check the handler BODY, not one spelling of the bug: any filesystem read or any call into a
  // *Version() helper re-introduces the circular check under a different name.
  const healthAt = indexSource.indexOf("path === '/health'")
  const healthBlock = healthAt === -1 ? '' : indexSource.slice(healthAt, indexSource.indexOf('if (path ===', healthAt + 1))
  check('http: the health handler was located in the source', healthBlock.length > 0)
  check('http: the health handler does no filesystem read', !/readFileSync|readFile\(/.test(healthBlock), healthBlock.slice(0, 200))
  check('http: the health handler calls no version helper', !/Version\(\)/.test(healthBlock), healthBlock.slice(0, 200))
  check('http: /health reports the module the process actually loaded', typeof health.module_url === 'string' && health.module_url.endsWith('/lib/index.js'))
}
check('http: token-protected route rejects a missing token', (await call('/sessions', { token: null })).status === 401)
check('http: token-protected route rejects a wrong token', (await call('/sessions', { token: 'deadbeef' })).status === 401)

const sessionsResult = await call('/sessions')
check('http: /sessions lists live agents', sessionsResult.status === 200 && sessionsResult.body.live_sessions[0]?.id === 'session-live-0001')

// Admission: routed, live -> delivered
const delivered = await call('/ask', { method: 'POST', body: { project: PROJECT, question: '四阶段契约在方向讨论里还成立吗？', codex_thread: 'thread-xyz' } })
check('ask: accepts and reports 202', delivered.status === 202 && delivered.body.ok === true, JSON.stringify(delivered.body))
check('ask: reports the routed session', delivered.body.session_id === 'session-live-0001')
check('ask: reports the resolving rule', delivered.body.resolved_by === 'routes[bridge-design]')
check('ask: defaults to followup', delivered.body.mode === 'followup')
check('ask: issues a question id', /^[0-9a-f-]{36}$/.test(delivered.body.question_id ?? ''))

const entry = liveAgent.received.at(-1)
check('delivery: the live agent actually received a followup', entry?.mode === 'followup')

// The source is what decides whether the harness accepts the injected message at all. The
// retired V3 wrapper `{ kind: 'plugin', … }` is refused while the delivered message is encoded
// for the session log — "format v4 message requires a producer-owned source kind" — and that
// refusal lands AFTER admission, so the audit log recorded `admitted`, no byte reached the
// session file, and the receiving conversation reported 本轮运行失败. Every check below fails
// on that shape. `plugin:collabridge` is also what the V3→V4 migration writes for this
// producer's older rows, so these pin injected text to one kind across the migration.
const injectedSource = entry?.message?.source
check('delivery: the message carries a source object', injectedSource !== null && typeof injectedSource === 'object')
check('delivery: it carries a user-role identity', entry?.message?.role === 'user')
check('delivery: it carries the message id the inbox requires', typeof entry?.message?.id === 'string' && entry.message.id.length > 0, JSON.stringify(entry?.message?.id))
check(
  'delivery: the source kind is producer-owned, not the retired plugin wrapper',
  typeof injectedSource?.kind === 'string' && injectedSource.kind.length > 0 && injectedSource.kind !== 'plugin',
  JSON.stringify(injectedSource),
)
check('delivery: the source kind is the one the migration writes for this producer', injectedSource?.kind === 'plugin:collabridge', JSON.stringify(injectedSource))
check('delivery: the source still names the plugin for readers that look there', injectedSource?.plugin === 'collabridge')

const framing = textOf(entry)
// ORDER, both directions: the relayed text IS the message, so it comes first; the marks that say
// who is talking to whom, and that nothing was rewritten, are provenance and come last — that is
// where a reader looks when the question is where the text came from. A visible [CODEX→DSH]
// banner at the top made every reader start on metadata instead of on the question.
check(
  'delivery: the question is the first thing in the message',
  framing.startsWith('<<<QUESTION\n四阶段契约在方向讨论里还成立吗？\nQUESTION\n>>>'),
  framing.slice(0, 120),
)
check('delivery: framing is marked', framing.includes('[CODEX→DSH]'))
// `[CODEX→DSH]` also appears inside the delivery contract ("这条约定只约束本次 [CODEX→DSH] 投递"),
// so the order check has to look at the LAST occurrence: that one is the provenance block.
check(
  'delivery: the provenance block comes after the contract',
  framing.lastIndexOf('[CODEX→DSH]') > framing.indexOf('这只是方向咨询'),
)
check(
  'delivery: the provenance block closes the message',
  framing.trimEnd().endsWith('回答会由协调者用 codex queue 推回对应的 Codex 线程，并带 [DSH] 标记。'),
  framing.slice(-120),
)
check('delivery: the question passes through verbatim', framing.includes('四阶段契约在方向讨论里还成立吗？'))
check('delivery: framing names the project', framing.includes('d:/examples/demo'))
check('delivery: framing names the node', framing.includes('bridge-design'))
check('delivery: framing carries the codex thread', framing.includes('thread-xyz'))
check('delivery: framing carries the question id', framing.includes(delivered.body.question_id))

// The consultation is a discussion, not a gate, and the framing has to shape the answer accordingly.
// The recipient does not see Codex's conversation, so it has to be told what is worth producing:
// which premise it would attack, what would kill each option, and how far its confidence is earned.
check('delivery: framing says this is direction discussion, not a gate', framing.includes('定方向阶段的讨论'))
check('delivery: framing asks which premise to attack', framing.includes('会攻击哪个前提'))
check('delivery: framing asks for the falsifier of each option', framing.includes('什么证据会杀掉它'))
check('delivery: framing separates confidence from evidence', framing.includes('信心与证据层级分开写'))
check('delivery: framing forbids padding with unverified options', framing.includes('未被验证的推测不要写成结论'))
check('delivery: framing repeats that this is not review evidence', framing.includes('不是审查证据'))
check('delivery: framing still forbids ask_user_question', framing.includes('不要调用 ask_user_question'))

// The outbound push (tools/transport/push-to-codex.mjs) is read in the Codex thread and follows
// the same rule as the inbound framing: DSH's own words first, the [DSH] provenance line last.
{
  const marked = markAnswer({ answer: '第一行正文。\n\n第二段。', questionId: 'q-1', basis: '说明' })
  check('push: the answer body starts the message', marked.startsWith('第一行正文。'), marked.slice(0, 80))
  check('push: the marker is present', marked.includes('[DSH] 以上是 DSH 协作会话的回答原文，未经 Codex 改写。'))
  check('push: the marker comes after the body', marked.indexOf('[DSH]') > marked.indexOf('第二段。'))
  check('push: the basis line carries the question id and the basis', marked.includes('依据：提问 ID q-1；说明'))
  check('push: the basis line is last', marked.trimEnd().endsWith('依据：提问 ID q-1；说明'), marked.slice(-80))
  check('push: a body already carrying the footer is not marked twice', markAnswer({ answer: marked, questionId: 'q-1' }) === marked)
  check('push: an old prefix-format message is still left alone', markAnswer({ answer: '[DSH] 旧格式正文' }) === '[DSH] 旧格式正文')
  check('push: a missing question id degrades to 本次对话', markAnswer({ answer: '正文' }).includes('依据：本次对话'))
}

// Delivery mode selection
await call('/ask', { method: 'POST', body: { project: PROJECT, question: 'steer this', mode: 'steer' } })
check('delivery: mode steer reaches agent.steer', liveAgent.received.at(-1)?.mode === 'steer')

// A routed session that is not live is refused, not silently dropped
routing.setRoute({ project: PROJECT, node: 'cold-node', sessionId: 'session-cold-9999' })
routing.setCurrentNode({ project: PROJECT, node: 'cold-node' })
const cold = await call('/ask', { method: 'POST', body: { project: PROJECT, question: 'anyone home?' } })
check('ask: refuses a routed session that is not live', cold.status === 409 && cold.body.code === 'target_not_live', JSON.stringify(cold.body))
check('ask: the refusal lists live sessions so the caller can re-route', Array.isArray(cold.body.live_sessions) && cold.body.live_sessions.includes('session-live-0001'))

// Switching the node is enough to move routing
routing.setRoute({ project: PROJECT, node: 'live-node', sessionId: 'session-live-0001' })
const nodeSwitch = await call('/node', { method: 'POST', body: { project: PROJECT, node: 'live-node' } })
check('http: /node switches the current node', nodeSwitch.status === 200 && nodeSwitch.body.entry.node === 'live-node', JSON.stringify(nodeSwitch.body))
const afterSwitch = await call('/ask', { method: 'POST', body: { project: PROJECT, question: 'after the milestone' } })
check('ask: follows a node switch', afterSwitch.status === 202 && afterSwitch.body.node === 'live-node', JSON.stringify(afterSwitch.body))

// Inference path through HTTP for a project with no explicit route
const otherResult = await call('/ask', { method: 'POST', body: { project: OTHER_PROJECT, question: 'x' } })
check('ask: an unconfigured project with no sessions is refused', otherResult.status === 409 && otherResult.body.code === 'no_session_routed')

// Bad input
check('ask: rejects a missing question', (await call('/ask', { method: 'POST', body: { project: PROJECT } })).status === 400)
check('ask: rejects a missing project', (await call('/ask', { method: 'POST', body: { question: 'x' } })).status === 400)
const malformed = await fetch(`http://127.0.0.1:${discovery.port}/ask`, {
  method: 'POST',
  headers: { authorization: `Bearer ${discovery.token}`, 'content-type': 'application/json' },
  body: '{not json',
})
check('ask: rejects malformed JSON', malformed.status === 400)
check('http: an unknown path is 404', (await call('/nope')).status === 404)

// Route mutation through HTTP
const routeResult = await call('/route', { method: 'POST', body: { project: OTHER_PROJECT, node: 'n1', session: 'session-other-0001' } })
check('http: /route registers a route', routeResult.status === 200 && routeResult.body.entry.routes.n1 === 'session-other-0001')
check('http: /routes exposes the registry', (await call('/routes')).status === 200)

// Audit log
const auditLines = readFileSync(join(home, 'collab-bridge.log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
const admitted = auditLines.filter((l) => l.event === 'admitted')
const refused = auditLines.filter((l) => l.event === 'refused')
check('audit: every successful admission is recorded', admitted.length === 3, `admitted=${admitted.length}`)
check('audit: records the question id and session', admitted.some((l) => l.session_id === 'session-live-0001' && /^[0-9a-f-]{36}$/.test(l.question_id)))
check('audit: records route mutations', auditLines.some((l) => l.event === 'route_set') && auditLines.some((l) => l.event === 'node_switched'))
check('audit: never records the question body', !JSON.stringify(auditLines).includes('四阶段契约'))

// Refusals must leave a trace: otherwise "why was this never delivered?" is unanswerable.
const refusedCodes = refused.map((l) => l.code)
check('audit: an unauthenticated request is recorded', refusedCodes.includes('unauthorized'), JSON.stringify(refusedCodes))
check('audit: a missing project is recorded', refusedCodes.includes('project_required'))
check('audit: a missing question is recorded', refusedCodes.includes('question_required'))
check('audit: a non-live target is recorded', refusedCodes.includes('target_not_live'))
check('audit: an unresolved project is recorded', refusedCodes.includes('no_session_routed'))
check('audit: a refusal names the project when one was supplied', refused.some((l) => l.code === 'no_session_routed' && l.project === 'd:/examples/other'))
check('audit: a refusal never records the question body', !JSON.stringify(refused).includes('四阶段契约') && !JSON.stringify(refused).includes('anyone home'))

// --- MCP wrapper -------------------------------------------------------------
function runMcp(messages, env = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [join(import.meta.dirname, '..', 'lib', 'mcp-server.mjs')], {
      env: { ...process.env, DSH_HOME: home, ...env },
      windowsHide: true,
    })
    let out = ''
    child.stdout.on('data', (c) => {
      out += c
    })
    child.stdin.write(`${messages.map((m) => JSON.stringify(m)).join('\n')}\n`)
    child.stdin.end()
    child.on('close', () => {
      resolvePromise(out.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)))
    })
  })
}

const mcpResponses = await runMcp([
  { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } },
  { jsonrpc: '2.0', method: 'notifications/initialized' },
  { jsonrpc: '2.0', id: 2, method: 'tools/list' },
])
check('mcp: initialize echoes the client protocol version', mcpResponses[0]?.result?.protocolVersion === '2025-06-18', JSON.stringify(mcpResponses[0]))
check('mcp: initialize names the server', mcpResponses[0]?.result?.serverInfo?.name === 'dsh-collabridge')
check('mcp: a notification draws no response', mcpResponses.length === 2, `responses=${mcpResponses.length}`)
check('mcp: tools/list exposes both tools', mcpResponses[1]?.result?.tools?.length === 2, JSON.stringify(mcpResponses[1]?.result?.tools?.map((t) => t.name)))
const tools = mcpResponses[1]?.result?.tools ?? []
const tool = tools.find((t) => t.name === 'ask_dsh')
const reviewTool = tools.find((t) => t.name === 'dsh_review')
check('mcp: ask_dsh is exposed', Boolean(tool))
check('mcp: dsh_review is exposed', Boolean(reviewTool))
check('mcp: ask_dsh requires project and question', tool?.inputSchema?.required?.join(',') === 'project,question')
check('mcp: ask_dsh rejects extra fields at the schema level', tool?.inputSchema?.additionalProperties === false)
check('mcp: the ask_dsh description warns against rewording', /verbatim|unchanged/i.test(tool?.description ?? ''))

// The consultation contract: ask_dsh is a discussion channel, so the description has to say when to
// use it, what to put in the question, and what its answer is worth. A bare "is X right?" wastes the
// exchange, and asking at the decision point means the reply arrives after the choice is committed.
const askDescription = tool?.description ?? ''
check('mcp: ask_dsh states it is fire-and-forget', /fire-and-forget/.test(askDescription))
check('mcp: ask_dsh says to ask early, not at the decision point', /Ask EARLY/.test(askDescription))
check('mcp: ask_dsh asks for the fixed constraints', /fixed constraints/.test(askDescription))
check('mcp: ask_dsh asks for options already rejected', /already considered and rejected/.test(askDescription))
check('mcp: ask_dsh asks for the pending decision', /decision actually pending/.test(askDescription))
check('mcp: ask_dsh asks which premise to attack', /premise you should attack first/.test(askDescription))
check('mcp: ask_dsh warns that its answer is hypotheses, not conclusions', /hypotheses to test/.test(askDescription))
check('mcp: ask_dsh says it cannot close a checkpoint', /cannot close a checkpoint/.test(askDescription))
check('mcp: the question field description carries the same brief', /already rejected/.test(tool?.inputSchema?.properties?.question?.description ?? ''))

// dsh_review's schema is the four-stage contract, so assert it rather than assume it.
check('mcp: dsh_review requires the package fields', reviewTool?.inputSchema?.required?.join(',') === 'project,stage,objective,obligations,evidence')
check('mcp: dsh_review restricts the stage set', reviewTool?.inputSchema?.properties?.stage?.enum?.join(',') === 'PHASE0,RED,GREEN,FINAL')
check('mcp: dsh_review rejects extra fields at the schema level', reviewTool?.inputSchema?.additionalProperties === false)
check('mcp: dsh_review obligations carry id and clause', reviewTool?.inputSchema?.properties?.obligations?.items?.required?.join(',') === 'id,clause')
check('mcp: dsh_review tells the caller the evidence is its own claim', /your claim/i.test(reviewTool?.description ?? ''))
check('mcp: dsh_review tells the caller findings are untrusted', /UNTRUSTED/i.test(reviewTool?.description ?? ''))

// Budgets appear twice: once as prose the caller reads, once as the number the bridge enforces.
// They drifted apart once (the text promised a 420 s default while the code used 600 s) and a
// caller who trusts the text is killed mid-review. These two checks are the anti-drift invariant:
// the rendered description must quote the same constants the clamping uses.
{
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const reviewProps = reviewTool?.inputSchema?.properties ?? {}
  const timeoutText = reviewProps.timeout_ms?.description ?? ''
  const testTimeoutText = reviewProps.test_timeout_ms?.description ?? ''
  const testCommandText = reviewProps.test_command?.description ?? ''
  check(
    'mcp: the quoted reviewer budget is the enforced default',
    timeoutText.includes(String(REVIEW_TIMEOUT_DEFAULT_MS)) && timeoutText.includes(String(REVIEW_TIMEOUT_MAX_MS)),
    timeoutText,
  )
  check(
    'mcp: the quoted test budget is the enforced default',
    testTimeoutText.includes(String(TEST_TIMEOUT_DEFAULT_MS)) && testTimeoutText.includes(String(TEST_TIMEOUT_MAX_MS)),
    testTimeoutText,
  )
  check('mcp: the test_command description quotes the enforced test budget', testCommandText.includes(asSeconds(TEST_TIMEOUT_DEFAULT_MS)), testCommandText.slice(0, 400))
  check('mcp: the retired reviewer-budget figures are gone', !/420000|900000/.test(timeoutText), timeoutText)
  check('mcp: the retired test-budget figure is gone', !/90 s by default/.test(testCommandText), testCommandText.slice(0, 400))
  check('mcp: the advertised server version is the packaged one', mcpResponses[0]?.result?.serverInfo?.version === manifest.version, `${mcpResponses[0]?.result?.serverInfo?.version} vs ${manifest.version}`)
  check('mcp: the clamping helpers agree with the quoted defaults', reviewTimeoutMs(undefined) === REVIEW_TIMEOUT_DEFAULT_MS && testTimeoutMs(undefined) === TEST_TIMEOUT_DEFAULT_MS)
  check('mcp: a request above the ceiling is clamped, not honoured', reviewTimeoutMs(REVIEW_TIMEOUT_MAX_MS + 1) === REVIEW_TIMEOUT_MAX_MS)

  // A structural limit raised for the FIRST time has no history, so it must not be described with
  // the wording that belongs to a re-send. Both states hold the gate, but only one of them has
  // "no new evidence since it was first raised".
  const serverSource = readFileSync(new URL('../lib/mcp-server.mjs', import.meta.url), 'utf8')
  check('mcp: a first-time structural limit is not described as a re-send', !/NOT YET ADDRESSED on this candidate — no new evidence/.test(serverSource))
  check('mcp: first-time and re-sent limits are reported separately', /raised for the first time by this review/.test(serverSource) && /you have re-sent the same evidence for these/.test(serverSource))
}

// Input validation must fail locally, before any reviewer is spawned and any cost incurred.
const badReview = await runMcp([
  { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
  { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'dsh_review', arguments: { project: PROJECT, stage: 'GREEN' } } },
])
const badReviewText = badReview.find((r) => r.id === 2)?.result?.content?.[0]?.text ?? ''
check('mcp: dsh_review rejects an incomplete package', badReview.find((r) => r.id === 2)?.result?.isError === true)
check('mcp: dsh_review names every missing field', ['objective', 'obligations', 'evidence'].every((f) => badReviewText.includes(f)), badReviewText)

const badStage = await runMcp([
  { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
  {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: {
      name: 'dsh_review',
      arguments: { project: PROJECT, stage: 'ALPHA', objective: 'a long enough objective', obligations: [{ id: 'OB-A', clause: 'x' }], evidence: 'e' },
    },
  },
])
check('mcp: dsh_review rejects an unknown stage', (badStage.find((r) => r.id === 2)?.result?.content?.[0]?.text ?? '').includes('stage must be'))

const missingRoot = await runMcp([
  { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
  {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: {
      name: 'dsh_review',
      arguments: { project: join(home, 'does-not-exist'), stage: 'GREEN', objective: 'a long enough objective', obligations: [{ id: 'OB-A', clause: 'x' }], evidence: 'e', test_command: 'x' },
    },
  },
])
check('mcp: dsh_review refuses a candidate root that does not exist', (missingRoot.find((r) => r.id === 2)?.result?.content?.[0]?.text ?? '').includes('does not exist'))

// A GREEN verdict without a runnable test command is not evidence, so it is refused locally.
const greenWithoutCommand = await runMcp([
  { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
  {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: {
      name: 'dsh_review',
      arguments: { project: PROJECT, stage: 'GREEN', objective: 'a long enough objective', obligations: [{ id: 'OB-A', clause: 'x' }], evidence: 'claim of a passing suite' },
    },
  },
])
const greenText = greenWithoutCommand.find((r) => r.id === 2)?.result?.content?.[0]?.text ?? ''
check('mcp: dsh_review refuses GREEN without test_command', greenWithoutCommand.find((r) => r.id === 2)?.result?.isError === true && greenText.includes('test_command'), greenText)

const phase0WithoutCommand = await runMcp([
  { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
  {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: {
      name: 'dsh_review',
      arguments: { project: PROJECT, stage: 'PHASE0', objective: 'a long enough objective', obligations: [{ id: 'OB-A', clause: 'x' }], evidence: 'design text' },
    },
  },
])
const phase0Text = phase0WithoutCommand.find((r) => r.id === 2)?.result?.content?.[0]?.text ?? ''
check('mcp: PHASE0 does not require test_command', !phase0Text.includes('test_command requires'), phase0Text.slice(0, 200))

const unknownTool = await runMcp([
  { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
  { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'nope', arguments: {} } },
])
check('mcp: an unknown tool is rejected', (unknownTool.find((r) => r.id === 2)?.result?.content?.[0]?.text ?? '').includes('unknown tool'))

// Live call through the MCP wrapper, with the bridge running in this process
const callResponses = await runMcp([
  { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
  { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'ask_dsh', arguments: { project: PROJECT, question: 'via MCP' } } },
])
const callResult = callResponses.find((r) => r.id === 2)?.result
check('mcp: a live tool call succeeds', callResult?.isError === undefined, JSON.stringify(callResult))
check('mcp: the result names the routed session', callResult?.content?.[0]?.text?.includes('session-live-0001'))
check('mcp: the result says not to wait inline', /do not wait for it inline/i.test(callResult?.content?.[0]?.text ?? ''))
check('mcp: the question reached the live agent', liveAgent.received.at(-1) && textOf(liveAgent.received.at(-1)).includes('via MCP'))

// An unreachable plugin must be reported as a tool error, not a transport failure
const missingHome = mkdtempSync(join(tmpdir(), 'collabridge-missing-'))
const offline = await runMcp(
  [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'ask_dsh', arguments: { project: PROJECT, question: 'x' } } },
  ],
  { DSH_HOME: missingHome },
)
const offlineResult = offline.find((r) => r.id === 2)?.result
check('mcp: reports an unreachable bridge as a tool error', offlineResult?.isError === true, JSON.stringify(offlineResult))
check('mcp: the error explains how to fix it', /not running/i.test(offlineResult?.content?.[0]?.text ?? ''))
rmSync(missingHome, { recursive: true, force: true })

// --- teardown ----------------------------------------------------------------
for (const dispose of disposers) {
  try {
    await dispose()
  } catch {
    // ignore
  }
}
check('plugin: removes the discovery file on unload', !existsSync(discoveryFile))
rmSync(home, { recursive: true, force: true })

console.log(`passed: ${passed}`)
if (failures.length > 0) {
  console.log(`failed: ${failures.length}`)
  for (const failure of failures) console.log(`  - ${failure}`)
  process.exitCode = 1
} else {
  console.log('all collaboration-bridge checks passed')
}
