#!/usr/bin/env node
// Tests for dsh-collabridge. No DSH process, no network beyond loopback, no cost.
//
// The plugin is exercised through a FAKE cordis context: `apply()` is called with a
// minimal `agents` registry and an effect collector, so the real HTTP surface, the real
// routing, the real admission decision, and the real audit log all run for real. That
// proves the plugin's logic without loading it into a profile.

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import {
  readSessionEvents,
  sessionActivityMs,
  sessionLogFile,
  sessionSummary,
  sessionsRoot,
  usageFromEvents,
  toolResultContent,
  toolCallsFromEvents,
} from '../lib/session-log.mjs'
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

// --- naming a conversation instead of a route --------------------------------
// The app writes a conversation's title as a durable `session/title` event, first from the opening
// prompt and refined afterwards, so the last one is what the window shows. Reading it lets a caller
// address a conversation by the name the user knows. What must hold:
//   * the LAST title wins, not the first
//   * the identifying line is something the user actually typed: not a harness wrapper, not a
//     bridge injection
//   * a stale, cached title is never served after the log changes
//   * naming something that matches nothing, or more than one conversation, is refused with the
//     choices rather than guessed at

function writeSessionLog(sessionDir, frames) {
  mkdirSync(sessionDir, { recursive: true })
  const parts = frames.map((events) => zstdCompressSync(Buffer.from(`${events.map((e) => JSON.stringify(e)).join('\n')}\n`, 'utf8')))
  writeFileSync(join(sessionDir, 'session.v4.jsonl.zstd'), Buffer.concat(parts))
}

const NAMED_PROJECT = 'D:\\Examples\\Named'
const namedRoot = join(home, 'sessions', slug(NAMED_PROJECT))
const alpha = join(namedRoot, 'session-alpha-0001')
const beta = join(namedRoot, 'session-beta-0002')
const gamma = join(namedRoot, 'session-gamma-0003')

writeSessionLog(alpha, [
  [
    { type: 'session', data: { id: 'session-alpha-0001' } },
    { type: 'session/title', data: { title: '第一个标题', titleProvider: 'session-title-first-prompt-llm' } },
    { type: 'user/message', data: { content: [{ type: 'text', text: '<system-reminder> a harness wrapper, not the user' }] } },
  ],
  [
    { type: 'session/title', data: { title: '示例项目维护' } },
    { type: 'user/message', data: { content: [{ type: 'text', text: '这句是用户说的' }] } },
  ],
  [
    { type: 'user/message', data: { source: { kind: 'plugin:collabridge' }, content: [{ type: 'text', text: 'a relayed question, not the user' }] } },
    { type: 'user/message', data: { content: [{ type: 'text', text: '开工吧' }] } },
  ],
])
writeSessionLog(beta, [
  [
    { type: 'session/title', data: { title: '恢复 Ctrl+Enter 示例功能' } },
    { type: 'user/message', data: { content: [{ type: 'text', text: '该清的都可以清掉了' }] } },
  ],
])
// Two conversations whose titles share a phrase, plus one that repeats another title exactly: both
// are what "the user named something ambiguous" looks like in practice.
writeSessionLog(gamma, [
  [
    { type: 'session/title', data: { title: '示例功能的另一件事' } },
    { type: 'user/message', data: { content: [{ type: 'text', text: '这条也提到示例功能' }] } },
  ],
])
const epsilon = join(namedRoot, 'session-epsilon-0006')
writeSessionLog(epsilon, [
  [
    { type: 'session/title', data: { title: '示例功能的另一件事' } },
    { type: 'user/message', data: { content: [{ type: 'text', text: '和上一条同名' }] } },
  ],
])

const alphaSummary = sessionSummary(alpha)
check('summary: the LAST title wins', alphaSummary.title === '示例项目维护', JSON.stringify(alphaSummary.title))
check('summary: the identifying line is the user\'s, not a wrapper', alphaSummary.lastUserLine === '开工吧', JSON.stringify(alphaSummary.lastUserLine))
check('summary: a bridge-injected message is not the user\'s line', alphaSummary.lastUserLine !== 'a relayed question, not the user')
const betaSummary = sessionSummary(beta)
check('summary: a conversation with one title reports it', betaSummary.title === '恢复 Ctrl+Enter 示例功能')

// A stale title must not survive the log it came from. This session exists only for that check, so
// rewriting it cannot disturb the titles the selection checks depend on.
const delta = join(namedRoot, 'session-delta-0007')
writeSessionLog(delta, [
  [
    { type: 'session/title', data: { title: '缓存之前的标题' } },
    { type: 'user/message', data: { content: [{ type: 'text', text: '第一句' }] } },
  ],
])
const cachedFirst = sessionSummary(delta).title
writeSessionLog(delta, [
  [
    { type: 'session/title', data: { title: '缓存之前的标题' } },
    { type: 'user/message', data: { content: [{ type: 'text', text: '第一句' }] } },
  ],
  [{ type: 'session/title', data: { title: '改过的标题' } }],
])
const afterChange = sessionSummary(delta).title
check('summary: a changed log is not served from cache', cachedFirst === '缓存之前的标题' && afterChange === '改过的标题', `${cachedFirst} -> ${afterChange}`)

// Recency is the newest entry inside the session directory: the directory's own mtime only moves when
// entries are added or removed, so it reports the moment a conversation was created.
const staleDir = join(namedRoot, 'session-stale-0004')
const freshDir = join(namedRoot, 'session-fresh-0005')
writeSessionLog(staleDir, [[{ type: 'session/title', data: { title: '旧会话' } }]])
writeSessionLog(freshDir, [[{ type: 'session/title', data: { title: '新会话' } }]])
const old = new Date(Date.now() - 6 * 60 * 60 * 1000)
utimesSync(join(freshDir, 'session.v4.jsonl.zstd'), old, old)   // its DIR mtime stays recent
utimesSync(freshDir, new Date(), new Date())
utimesSync(join(staleDir, 'session.v4.jsonl.zstd'), new Date(), new Date())  // its FILE is recent
utimesSync(staleDir, old, old)                                   // while its DIR mtime is old
check(
  'recency: the newest entry decides, not the directory mtime',
  sessionActivityMs(staleDir) > sessionActivityMs(freshDir),
  `${sessionActivityMs(staleDir)} vs ${sessionActivityMs(freshDir)}`,
)
const ordered = routing.sessionsForProject(NAMED_PROJECT)
const staleAt = ordered.findIndex((s) => s.id === 'session-stale-0004')
const freshAt = ordered.findIndex((s) => s.id === 'session-fresh-0005')
check(
  'recency: the session with a recent file outranks one whose directory looks recent',
  staleAt >= 0 && freshAt >= 0 && staleAt < freshAt,
  JSON.stringify(ordered.map((s) => s.id)),
)

// --- choosing a conversation -------------------------------------------------
const byExact = routing.resolveCollabSession({ project: NAMED_PROJECT, title: '示例项目维护' })
check('select: an exact title resolves', byExact.session_id === 'session-alpha-0001' && byExact.resolved_by === 'title', JSON.stringify(byExact))
check('select: an exact title is reported as exact', byExact.matched_exactly === true && byExact.matched_title === '示例项目维护')

const byFragment = routing.resolveCollabSession({ project: NAMED_PROJECT, title: 'Ctrl+Enter' })
check('select: a unique fragment resolves and is marked inexact', byFragment.session_id === 'session-beta-0002' && byFragment.matched_exactly === false, JSON.stringify(byFragment))

const byAmbiguous = routing.resolveCollabSession({ project: NAMED_PROJECT, title: '示例功能' })
check('select: a fragment matching several conversations is refused', byAmbiguous.session_id === null && byAmbiguous.resolved_by === 'title-ambiguous', JSON.stringify(byAmbiguous))
check('select: the refusal lists every match', (byAmbiguous.matches ?? []).length === 3, JSON.stringify(byAmbiguous.matches))
check('select: every listed match carries a title', (byAmbiguous.matches ?? []).every((m) => typeof m.title === 'string' && m.title.length > 0))

const byDuplicate = routing.resolveCollabSession({ project: NAMED_PROJECT, title: '示例功能的另一件事' })
check('select: two conversations sharing a full title are refused', byDuplicate.session_id === null && byDuplicate.resolved_by === 'title-ambiguous', JSON.stringify(byDuplicate))

const byNothing = routing.resolveCollabSession({ project: NAMED_PROJECT, title: '没有任何会话叫这个' })
check('select: an unmatched title is refused as unmatched', byNothing.session_id === null && byNothing.reason === 'title_not_found')
check('select: the refusal lists every conversation with its title', (byNothing.sessions ?? []).some((s) => s.title === '示例项目维护'))
check('select: the listed conversations carry the user\'s own line', (byNothing.sessions ?? []).some((s) => s.last_user_line === '开工吧'))

const byId = routing.resolveCollabSession({ project: NAMED_PROJECT, session: 'session-gamma-0003' })
check('select: a full session id resolves', byId.session_id === 'session-gamma-0003' && byId.resolved_by === 'session')
const byPrefix = routing.resolveCollabSession({ project: NAMED_PROJECT, session: 'session-gamma' })
check('select: a unique session id prefix resolves', byPrefix.session_id === 'session-gamma-0003')
const byNoId = routing.resolveCollabSession({ project: NAMED_PROJECT, session: 'session-absent-9999' })
check('select: an unknown session id is refused', byNoId.session_id === null && byNoId.reason === 'session_not_in_workspace')
const byBadPrefix = routing.resolveCollabSession({ project: NAMED_PROJECT, session: 'session-' })
check('select: an ambiguous session id prefix is refused', byBadPrefix.session_id === null && byBadPrefix.reason === 'session_prefix_ambiguous')

routing.setRoute({ project: NAMED_PROJECT, node: 'parallel-a', sessionId: 'session-alpha-0001', current: false })
const byLabel = routing.resolveCollabSession({ project: NAMED_PROJECT, node: 'parallel-a' })
check('select: a registered label resolves', byLabel.session_id === 'session-alpha-0001' && byLabel.resolved_by === 'routes[parallel-a]')
const notCurrent = routing.loadRegistry().projects[routing.normaliseProject(NAMED_PROJECT)]
check('select: labelling without --current leaves the project node alone', notCurrent.node === null, JSON.stringify(notCurrent.node))
const byBadLabel = routing.resolveCollabSession({ project: NAMED_PROJECT, node: 'no-such-label' })
check('select: an unregistered label is refused', byBadLabel.session_id === null && byBadLabel.reason === 'node_not_routed')
check('select: the refusal lists the registered labels', (byBadLabel.labels ?? []).includes('parallel-a'))

const inferredStill = routing.resolveCollabSession({ project: NAMED_PROJECT })
check('select: no selector keeps the previous behaviour', inferredStill.resolved_by === 'newest-session-for-workspace', JSON.stringify(inferredStill))

// --- the outbound side: finding a Codex thread by its title -------------------
// Same rules as the inbound side. Two facts about the source make it less trivial than a lookup: a
// thread is RENAMED while in use and `session_index.jsonl` keeps one line per write, so the same id
// appears with several names and only the newest `updated_at` is current; and a rename can land with
// an empty name before the new one is written.
{
  const push = await import('../tools/transport/push-to-codex.mjs')
  const codexHome = mkdtempSync(join(tmpdir(), 'collabridge-codex-'))
  const codexSessions = join(codexHome, 'sessions', '2026', '10', '05')
  mkdirSync(codexSessions, { recursive: true })

  const threads = [
    { id: '11111111-1111-4111-8111-111111111111', cwd: 'D:\\Examples\\Workspace', names: [['2026-10-05T20:00:00Z', '示例项目旧标题'], ['2026-10-05T21:35:00Z', '示例项目维护']] },
    { id: '22222222-2222-4222-8222-222222222222', cwd: 'D:\\Examples\\Workspace', names: [['2026-10-05T20:59:00Z', '闲聊']] },
    { id: '33333333-3333-4333-8333-333333333333', cwd: 'D:\\Examples\\Other', names: [['2026-10-05T19:00:00Z', '示例功能的另一件事']] },
    { id: '44444444-4444-4444-8444-444444444444', cwd: 'D:\\Examples\\Other', names: [['2026-10-05T18:00:00Z', '示例功能收尾']] },
    { id: '55555555-5555-4555-8555-555555555555', cwd: 'D:\\Examples\\Silent', names: [['2026-10-05T21:00:00Z', ''], ['2026-10-05T21:10:00Z', '无名线程的旧名字']] },
  ]
  const indexLines = []
  for (const thread of threads) {
    for (const [updatedAt, name] of thread.names) {
      indexLines.push(JSON.stringify({ id: thread.id, thread_name: name, updated_at: updatedAt }))
      // The rollout filename has to match the real convention: `rollout-<ISO without punctuation>-<uuid>`.
      const stamp = updatedAt.replace(/[:.]/g, '-').replace(/Z$/, '')
      const file = join(codexSessions, `rollout-${stamp}-${thread.id}.jsonl`)
      writeFileSync(file, `${JSON.stringify({ type: 'session_meta', payload: { cwd: thread.cwd } })}\n{"type":"event_msg"}\n`)
    }
  }
  writeFileSync(join(codexHome, 'session_index.jsonl'), `${indexLines.join('\n')}\n`)

  const titles = push.readThreadTitles(codexHome)
  check('outbound: a renamed thread keeps its newest title', titles.get(threads[0].id)?.title === '示例项目维护', JSON.stringify(titles.get(threads[0].id)))
  check('outbound: an empty newest name falls back to the newest real name', titles.get(threads[4].id)?.title === '无名线程的旧名字', JSON.stringify(titles.get(threads[4].id)))

  // The index's timestamps are not all written at the same precision (the writer trims trailing
  // zeros), so the same second can appear as .283917 and .2839177. Compared as strings the first wins
  // because 'Z' sorts above '7', which served the title from BEFORE the rename.
  const mixedHome = mkdtempSync(join(tmpdir(), 'collabridge-codex-mixed-'))
  const mixedId = '66666666-6666-4666-8666-666666666666'
  mkdirSync(join(mixedHome, 'sessions', '2026', '10', '05'), { recursive: true })
  writeFileSync(
    join(mixedHome, 'session_index.jsonl'),
    [
      JSON.stringify({ id: mixedId, thread_name: '改名前的名字', updated_at: '2026-10-05T21:35:13.283917Z' }),
      JSON.stringify({ id: mixedId, thread_name: '改名后的名字', updated_at: '2026-10-05T21:35:13.2839177Z' }),
    ].join('\n') + '\n',
  )
  writeFileSync(join(mixedHome, 'sessions', '2026', '10', '05', `rollout-2026-10-05T21-35-13-${mixedId}.jsonl`), `${JSON.stringify({ type: 'session_meta', payload: { cwd: 'D:\\Examples\\Mixed' } })}\n`)
  check(
    'outbound: a later write with more fractional digits is the newer one',
    push.readThreadTitles(mixedHome).get(mixedId)?.title === '改名后的名字',
    JSON.stringify(push.readThreadTitles(mixedHome).get(mixedId)?.title),
  )
  check(
    'outbound: the pre-rename name does not match even at mixed precision',
    push.resolveCodexThreadByTitle({ title: '改名前的名字', codexHome: mixedHome }).ok === false,
  )
  check(
    'outbound: the current name resolves at mixed precision',
    push.resolveCodexThreadByTitle({ title: '改名后的名字', codexHome: mixedHome }).ok === true,
  )
  rmSync(mixedHome, { recursive: true, force: true })

  const exact = push.resolveCodexThreadByTitle({ title: '示例项目维护', codexHome })
  check('outbound: an exact title resolves', exact.ok === true && exact.thread.id === threads[0].id, JSON.stringify(exact))
  check('outbound: the resolution reports the title it matched', exact.thread?.title === '示例项目维护')
  check('outbound: an exact title is marked exact', exact.thread?.titleMatchedExactly === true)

  const fragment = push.resolveCodexThreadByTitle({ title: '闲聊', codexHome })
  check('outbound: a unique fragment resolves', fragment.ok === true && fragment.thread.id === threads[1].id)

  const renamed = push.resolveCodexThreadByTitle({ title: '示例项目旧标题', codexHome })
  check('outbound: the name from before a rename no longer matches', renamed.ok === false && renamed.reason === 'title_not_found', JSON.stringify(renamed.reason))
  check('outbound: the candidates show the current title instead', (renamed.candidates ?? []).some((c) => c.thread_id === threads[0].id && c.title === '示例项目维护'))

  const ambiguous = push.resolveCodexThreadByTitle({ title: '示例功能', codexHome })
  check('outbound: a fragment matching two threads is refused', ambiguous.ok === false && ambiguous.reason === 'title_ambiguous', JSON.stringify(ambiguous.reason))
  check('outbound: the refusal lists both matches', (ambiguous.matches ?? []).length === 2, JSON.stringify(ambiguous.matches))

  const nothing = push.resolveCodexThreadByTitle({ title: '没有任何线程叫这个', codexHome })
  check('outbound: an unmatched title is refused with candidates', nothing.ok === false && nothing.reason === 'title_not_found' && (nothing.candidates ?? []).length >= 3)
  check('outbound: candidates carry the thread id, title and activity', (nothing.candidates ?? []).every((c) => typeof c.thread_id === 'string' && typeof c.last_activity === 'string'))
  check('outbound: an empty title is refused before searching', push.resolveCodexThreadByTitle({ title: '   ', codexHome }).reason === 'title_required')

  // The flag layer decides whether a named title reaches the resolver at all. A flag with no value, or
  // one whose value is the next flag, must NOT resolve as "no title was named": that would fall back to
  // the project's newest thread and deliver DSH's words to a thread the caller never named.
  const parsedBare = push.parseFlags(['--project', 'P', '--message', 'hi', '--title'])
  check('outbound: a valueless flag is recorded as present, not as a value', parsedBare.title === true, JSON.stringify(parsedBare))
  const parsedSwallow = push.parseFlags(['--title', '--dry-run', '--message', 'hi'])
  check('outbound: a flag does not swallow the next flag as its value', parsedSwallow.title === true && parsedSwallow['dry-run'] === true, JSON.stringify(parsedSwallow))
  const parsedValue = push.parseFlags(['--title', '某个标题', '--dry-run'])
  check('outbound: a real value is still taken', parsedValue.title === '某个标题' && parsedValue['dry-run'] === true, JSON.stringify(parsedValue))

  // `--name=value` is what a shell writes for `--name="$VAR"`, and an unset variable makes it
  // `--name=`. Keeping the `=` inside the key recorded `{"title=": true}`, so the named title never
  // reached the resolver and the call fell through to project targeting.
  const equalsEmpty = push.parseFlags(['--project', 'P', '--title='])
  check('outbound: --title= records an empty title, not a new key', equalsEmpty.title === '' && !('title=' in equalsEmpty), JSON.stringify(equalsEmpty))
  const equalsValue = push.parseFlags(['--title=某个标题', '--dry-run'])
  check('outbound: --title=value records the value', equalsValue.title === '某个标题' && equalsValue['dry-run'] === true, JSON.stringify(equalsValue))
  const equalsRefused = push.resolveTarget({ flags: push.parseFlags(['--title=', '--project', 'D:\\Examples\\Workspace']), codexHome })
  check('outbound: --title= is refused rather than resolved by project', equalsRefused.ok === false && equalsRefused.reason === 'title_required', JSON.stringify(equalsRefused))
  const equalsResolved = push.resolveTarget({ flags: push.parseFlags(['--title=闲聊']), codexHome })
  check('outbound: --title=value resolves by title', equalsResolved.ok === true && equalsResolved.resolvedBy === 'title' && equalsResolved.thread.id === threads[1].id, JSON.stringify(equalsResolved))
  const equalsWithThread = push.resolveTarget({ flags: push.parseFlags(['--thread=' + threads[1].id, '--title=']), codexHome })
  check('outbound: an empty --title is refused even next to an explicit thread', equalsWithThread.ok === false && equalsWithThread.reason === 'title_required', JSON.stringify(equalsWithThread))
  const threadEquals = push.resolveTarget({ flags: push.parseFlags(['--thread=' + threads[1].id]), codexHome })
  check('outbound: an explicit thread still works in the equals form', threadEquals.ok === true && threadEquals.thread.id === threads[1].id, JSON.stringify(threadEquals))

  const bareTitle = push.resolveTarget({ flags: { title: true, project: 'D:\\Examples\\Workspace' }, codexHome })
  check('outbound: a valueless --title is refused, not resolved by project', bareTitle.ok === false && bareTitle.reason === 'title_required', JSON.stringify(bareTitle))
  const blankTitle = push.resolveTarget({ flags: { title: '   ', project: 'D:\\Examples\\Workspace' }, codexHome })
  check('outbound: a blank --title is refused too', blankTitle.ok === false && blankTitle.reason === 'title_required')
  const explicitWins = push.resolveTarget({ flags: { thread: threads[1].id, title: '示例项目维护' }, codexHome })
  check('outbound: an explicit thread id wins over a title', explicitWins.ok === true && explicitWins.thread.id === threads[1].id && explicitWins.resolvedBy === 'explicit', JSON.stringify(explicitWins))
  const titledTarget = push.resolveTarget({ flags: { title: '示例项目维护' }, codexHome })
  check('outbound: a title resolves through the policy', titledTarget.ok === true && titledTarget.resolvedBy === 'title' && titledTarget.thread.id === threads[0].id, JSON.stringify(titledTarget))
  const noTarget = push.resolveTarget({ flags: { project: 'D:\\Examples\\Nobody' }, codexHome })
  check('outbound: an unmatched project is refused', noTarget.ok === false && noTarget.reason === 'no_codex_thread_for_project', JSON.stringify(noTarget))

  rmSync(codexHome, { recursive: true, force: true })
}


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
check('ask: defaults to steer', delivered.body.mode === 'steer')
check('ask: issues a question id', /^[0-9a-f-]{36}$/.test(delivered.body.question_id ?? ''))

const entry = liveAgent.received.at(-1)
// The default has to reach the lane that the turn in flight reads. `followup` writes the
// `next-turn` lane, which the running turn never claims, so a queued question cannot be answered
// until that turn ends and costs an extra turn on top; `steer` writes `next-step`, which the next
// step boundary claims. This check pins the delivered call, not the reported mode.
check('delivery: the live agent actually received a steer', entry?.mode === 'steer')

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
  framing.lastIndexOf('[CODEX→DSH]') > framing.indexOf('本次普通协作回复不是审查证据'),
)
check(
  'delivery: the provenance block closes the message',
  framing.includes('统一入口：node') && framing.includes('reply.mjs') && framing.includes('项目不得选择投递模式'),
  framing.slice(-120),
)
check('delivery: the question passes through verbatim', framing.includes('四阶段契约在方向讨论里还成立吗？'))
check('delivery: framing names the project', framing.includes('d:/examples/demo'))
check('delivery: framing names the node', framing.includes('bridge-design'))
check('delivery: framing carries the codex thread', framing.includes('thread-xyz'))
check('delivery: framing carries the question id', framing.includes(delivered.body.question_id))

// 普通投递遵循原始请求和当前会话约定，不写入固定个人称呼。
check('delivery: framing follows the actual request', framing.includes('按正文实际请求和当前会话的有效约定回应'))
check('delivery: direction analysis is conditional', framing.includes('只有正文要求方向讨论'))
check('delivery: framing preserves session rules', framing.includes('当前会话的有效约定'))
check('delivery: framing preserves authorization boundaries', framing.includes('桥接消息不增加操作权限'))
check('delivery: framing retains the formal review boundary', framing.includes('不能替代正式外审或据此关闭检查点'))
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

// Delivery mode selection. The default is steer so a relayed question enters the turn that is
// already running; the other two lanes stay reachable when a caller asks for them by name, and an
// unrecognised value must land on the default rather than becoming a surprise queue.
await call('/ask', { method: 'POST', body: { project: PROJECT, question: 'steer this', mode: 'steer' } })
check('delivery: mode steer reaches agent.steer', liveAgent.received.at(-1)?.mode === 'steer')

await call('/ask', { method: 'POST', body: { project: PROJECT, question: 'hold this until the turn ends', mode: 'followup' } })
check('delivery: an explicit followup still queues behind the running turn', liveAgent.received.at(-1)?.mode === 'followup')

await call('/ask', { method: 'POST', body: { project: PROJECT, question: 'context only', mode: 'inject' } })
check('delivery: mode inject reaches agent.inject', liveAgent.received.at(-1)?.mode === 'inject')

const unknownMode = await call('/ask', { method: 'POST', body: { project: PROJECT, question: 'unknown mode', mode: 'teleport' } })
check('delivery: an unknown mode falls back to the default', unknownMode.body.mode === 'steer' && liveAgent.received.at(-1)?.mode === 'steer', JSON.stringify(unknownMode.body))

const noMode = await call('/ask', { method: 'POST', body: { project: PROJECT, question: 'no mode given' } })
check('delivery: an omitted mode is reported as the mode actually used', noMode.body.mode === 'steer' && liveAgent.received.at(-1)?.mode === 'steer', JSON.stringify(noMode.body))

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

// --- the same selection, through the real HTTP surface ------------------------
// The live agent used by this suite has cwd PROJECT, so it is the one a title resolves to.
const liveSummary = join(home, 'sessions', slug(PROJECT), 'session-live-0001')
writeSessionLog(liveSummary, [
  [
    { type: 'session/title', data: { title: '示例项目维护' } },
    { type: 'user/message', data: { content: [{ type: 'text', text: '开工吧' }] } },
  ],
])

const byTitle = await call('/ask', { method: 'POST', body: { project: PROJECT, title: '示例项目维护', question: 'by title' } })
check('http: /ask delivers by title', byTitle.status === 202 && byTitle.body.session_id === 'session-live-0001', JSON.stringify(byTitle.body))
check('http: the acceptance names the matched title', byTitle.body.matched_title === '示例项目维护', JSON.stringify(byTitle.body))
const deliveredByTitle = liveAgent.received.at(-1)?.message?.content?.[0]?.text ?? ''
check('http: the delivered framing says how it was addressed', deliveredByTitle.includes('标题《示例项目维护》'), deliveredByTitle.slice(0, 200))

const byFragmentHttp = await call('/ask', { method: 'POST', body: { project: PROJECT, title: '项目维护', question: 'by fragment' } })
check('http: /ask delivers by a unique title fragment', byFragmentHttp.status === 202 && byFragmentHttp.body.session_id === 'session-live-0001')

const unknownTitle = await call('/ask', { method: 'POST', body: { project: PROJECT, title: '根本没有这个标题', question: 'x' } })
check('http: an unknown title is refused', unknownTitle.status === 409 && unknownTitle.body.code === 'title_not_found', JSON.stringify(unknownTitle.body))
check('http: the refusal offers the conversations', (unknownTitle.body.sessions ?? []).some((s) => s.title === '示例项目维护'))
check('http: the refusal offers the last thing the user said', (unknownTitle.body.sessions ?? []).some((s) => s.last_user_line === '开工吧'))

const unknownLabel = await call('/ask', { method: 'POST', body: { project: PROJECT, node: 'not-a-label', question: 'x' } })
check('http: an unregistered label is refused', unknownLabel.status === 409 && unknownLabel.body.code === 'node_not_routed', JSON.stringify(unknownLabel.body))
check('http: the refusal offers the registered labels', (unknownLabel.body.labels ?? []).includes('live-node'))

const unknownSession = await call('/ask', { method: 'POST', body: { project: PROJECT, session: 'session-nowhere-1234', question: 'x' } })
check('http: an unknown session id is refused', unknownSession.status === 409 && unknownSession.body.code === 'session_not_found', JSON.stringify(unknownSession.body))

const sessionsForProjectResult = await call(`/sessions?project=${encodeURIComponent(PROJECT)}`)
check('http: /sessions can list one project', sessionsForProjectResult.status === 200 && Array.isArray(sessionsForProjectResult.body.sessions))
check(
  'http: a project listing carries titles and liveness',
  (sessionsForProjectResult.body.sessions ?? []).some((s) => s.title === '示例项目维护' && s.live === true),
  JSON.stringify(sessionsForProjectResult.body.sessions),
)
check(
  'http: a live session is described by its title',
  (sessionsForProjectResult.body.live_sessions ?? []).some((s) => s.id === 'session-live-0001' && s.title === '示例项目维护'),
  JSON.stringify(sessionsForProjectResult.body.live_sessions),
)

// A title that names a conversation which is not live must say so, not fall back to another one.
writeSessionLog(join(home, 'sessions', slug(PROJECT), 'session-closed-0002'), [
  [{ type: 'session/title', data: { title: '已经关闭的会话' } }],
])
const closedTitle = await call('/ask', { method: 'POST', body: { project: PROJECT, title: '已经关闭的会话', question: 'x' } })
check('http: a title naming a closed conversation is refused distinctly', closedTitle.status === 409 && closedTitle.body.code === 'title_matched_but_not_live', JSON.stringify(closedTitle.body))


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
// Every delivery made above is recorded; the exact number follows the cases this suite runs, so the
// assertion is about the deliveries it made rather than a fixed count.
check('audit: every successful admission is recorded', admitted.length >= 3, `admitted=${admitted.length}`)
check('audit: records the question id and session', admitted.some((l) => l.session_id === 'session-live-0001' && /^[0-9a-f-]{36}$/.test(l.question_id)))
check('audit: records which selector chose the target', admitted.some((l) => l.selector === 'title' && l.matched_title === '示例项目维护'), JSON.stringify(admitted.map((l) => l.selector)))
check('audit: records route mutations', auditLines.some((l) => l.event === 'route_set') && auditLines.some((l) => l.event === 'node_switched'))
// The row is the only place a delivery's lane can be checked after the fact: the session log shows
// the inbox splice, and this names the call that produced it.
check('audit: records the delivery mode that was used', admitted.some((l) => l.mode === 'steer'), JSON.stringify(admitted.map((l) => l.mode)))
check('audit: distinguishes an explicitly requested queue', admitted.some((l) => l.mode === 'followup'))
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
check('mcp: tools/list exposes every tool', mcpResponses[1]?.result?.tools?.length === 3, JSON.stringify(mcpResponses[1]?.result?.tools?.map((t) => t.name)))
const tools = mcpResponses[1]?.result?.tools ?? []
const tool = tools.find((t) => t.name === 'ask_dsh')
const reviewTool = tools.find((t) => t.name === 'dsh_review')
const sessionsTool = tools.find((t) => t.name === 'dsh_sessions')
check('mcp: ask_dsh is exposed', Boolean(tool))
check('mcp: dsh_review is exposed', Boolean(reviewTool))
check('mcp: dsh_sessions is exposed', Boolean(sessionsTool))
check(
  'mcp: ask_dsh accepts the three selectors',
  ['title', 'node', 'session'].every((key) => Boolean(tool?.inputSchema?.properties?.[key])),
  JSON.stringify(Object.keys(tool?.inputSchema?.properties ?? {})),
)
check('mcp: dsh_sessions only needs a project', JSON.stringify(Object.keys(sessionsTool?.inputSchema?.properties ?? {})) === '["project"]')
check('mcp: ask_dsh requires project and question', tool?.inputSchema?.required?.join(',') === 'project,question')
check('mcp: ask_dsh rejects extra fields at the schema level', tool?.inputSchema?.additionalProperties === false)
check('mcp: the ask_dsh description warns against rewording', /逐字|不要改写/.test(tool?.description ?? ''))

// The consultation contract: ask_dsh is a discussion channel, so the description has to say when to
// use it, what to put in the question, and what its answer is worth. A bare "is X right?" wastes the
// exchange, and asking at the decision point means the reply arrives after the choice is committed.
const askDescription = tool?.description ?? ''
check('mcp: ask_dsh states it is fire-and-forget', /受理后立即返回/.test(askDescription))
check('mcp: ask_dsh says to ask early, not at the decision point', /尽早提问/.test(askDescription))
check('mcp: ask_dsh asks for the fixed constraints', /固定约束/.test(askDescription))
check('mcp: ask_dsh asks for options already rejected', /已经考虑并排除的方案/.test(askDescription))
check('mcp: ask_dsh asks for the pending decision', /尚待决定的事项/.test(askDescription))
check('mcp: ask_dsh asks which premise to attack', /最应质疑的前提/.test(askDescription))
check('mcp: ask_dsh warns that its answer is hypotheses, not conclusions', /待验证假设/.test(askDescription))
check('mcp: ask_dsh says it cannot close a checkpoint', /不能据此关闭检查点/.test(askDescription))
check('mcp: the question field description carries the same brief', /已经排除的方案/.test(tool?.inputSchema?.properties?.question?.description ?? ''))

// dsh_review's schema is the four-stage contract, so assert it rather than assume it.
check('mcp: dsh_review requires the package fields', reviewTool?.inputSchema?.required?.join(',') === 'project,stage,objective,obligations,evidence')
check('mcp: dsh_review restricts the stage set', reviewTool?.inputSchema?.properties?.stage?.enum?.join(',') === 'PHASE0,RED,GREEN,FINAL')
check('mcp: dsh_review rejects extra fields at the schema level', reviewTool?.inputSchema?.additionalProperties === false)
check('mcp: dsh_review obligations carry id and clause', reviewTool?.inputSchema?.properties?.obligations?.items?.required?.join(',') === 'id,clause')
check('mcp: dsh_review tells the caller the evidence is its own claim', /调用方声明/.test(reviewTool?.description ?? ''))
check('mcp: dsh_review tells the caller findings are untrusted', /不可信输入/.test(reviewTool?.description ?? ''))

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
