// dsh-collabridge — host half.
//
// Purpose: let an external caller (Codex) hand a question to a LIVE DeepSeek Harness
// collaboration session, routed by project and development node.
//
// Why a plugin and not an external process: every Host RPC and WebSocket stream requires
// the browser session cookie, and DSH's HTTP carrier accepts no query or header token
// outside the `GET /?token=...` exchange. An external process therefore cannot reach
// `session/prompt`. A plugin lives inside the trusted composition, so it can call the
// agent API directly and own its own loopback surface with its own token.
//
// Delivery uses the agent API, not a new session:
//   agent.steer(message)     claimed at the next step boundary  (default)
//   agent.followup(message)  queued as the turn after any work in flight
//   agent.inject(message)    placed into the pending context without waking the driver
//
// Why steer leads. The harness inbox has two lanes (dsh-agent-loop): `followup` writes `next-turn`,
// which the turn ALREADY RUNNING never reads, so the question is answered only after that turn ends,
// as a whole extra turn of latency and tokens. `steer` writes `next-step`, and every step boundary
// claims that lane, so the turn in flight picks the question up at its next step. Steer cannot strand
// a message on an idle session either: a wake while idle always opens a turn boundary, and that
// turn's first step claims `next-step` together with one `next-turn`, so the question is delivered
// and answered. Callers who positively want the question held until the current work finishes pass
// mode `followup`.
//
// Discovery: the chosen port and token are written to $DSH_HOME/collab-bridge.json so a
// thin client (the MCP wrapper Codex talks to) can find this endpoint.
// Audit: every admission is appended to $DSH_HOME/collab-bridge.log.jsonl.

import { randomBytes, randomUUID } from 'node:crypto'
import { appendFileSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  dshHome,
  loadRegistry,
  resolveCollabSession,
  routingPath,
  sessionsForProject,
  setCurrentNode,
  setRoute,
} from './routing.js'
import { sessionSlug, sessionSummary, sessionsRoot } from './session-log.mjs'

/** Cordis function-plugin name. */
const name = 'collabridge'

/** The agent registry is the only service this plugin needs. */
const inject = ['agents']

const MAX_BODY_BYTES = 1024 * 1024
/**
 * Default delivery: enter the turn that is running instead of queueing behind it.
 *
 * A queued question is not slow by a little: `followup` is not read by the turn in flight at all, so
 * every relayed question costs the remainder of that turn before the answer can even start, and the
 * answer then occupies a turn of its own. Steering delivers into the step boundary that is about to
 * happen, which is what an interactive reader expects when they type into a busy conversation.
 */
const DEFAULT_MODE = 'steer'
const MODES = ['followup', 'steer', 'inject']

/**
 * The version this process actually loaded, so a stale in-process copy is detectable.
 *
 * Read ONCE, at module load. Re-reading the manifest inside the request handler reported the
 * version of the file on disk instead — the exact value this is supposed to be distinguishable
 * from — which made the deployment check circular: `/health` "confirmed" a new version because a
 * new package.json was on disk, not because the process had loaded it. The host half only changes
 * behaviour on a DSH restart, so the whole point of this field is to say whether that happened.
 */
function readPluginVersion() {
  try {
    const here = fileURLToPath(new URL('.', import.meta.url))
    return JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')).version ?? null
  } catch {
    return null
  }
}

const PLUGIN_VERSION = readPluginVersion()

function discoveryPath() {
  return join(dshHome(), 'collab-bridge.json')
}

function auditPath() {
  return join(dshHome(), 'collab-bridge.log.jsonl')
}

/**
 * The producer-owned source every injected message carries.
 *
 * `kind` must be a non-empty string that is NOT the literal `'plugin'`. That spelling is the
 * retired V3 wrapper: the current session format refuses it while the delivered message is
 * encoded for the log —
 * `SessionFormatError: format v4 message requires a producer-owned source kind` — and the
 * refusal happens after admission, so the audit log records `admitted` while the receiving
 * conversation reports 本轮运行失败 and nothing at all reaches the session file.
 *
 * `plugin:<name>` is the third-party producer convention (first-party kinds are the closed
 * `MessageSourceMap` set), and it is exactly what the V3→V4 migration rewrites this
 * producer's older rows into, so injected text keeps one single kind across that migration.
 * `kind` alone is what the format checks; `plugin` is kept for readers that still look at it.
 */
const MESSAGE_SOURCE = Object.freeze({ kind: 'plugin:collabridge', plugin: 'collabridge' })

/**
 * Build the user message for a delivery. `createUserMessage` lives in
 * `@deepseek-ai/dsh-llm`; Desktop's host-module fallback resolves that package for profile
 * plugins, so the import normally succeeds and supplies the identity `id`. The literal
 * fallback below therefore mints `id` and `role` itself — omitting them produced a splice
 * whose message had no identity, which the inbox's duplicate-id guard reads as `undefined`.
 */
let createUserMessageModule
async function buildUserMessage(text) {
  const content = [{ type: 'text', text }]
  try {
    createUserMessageModule ??= import('@deepseek-ai/dsh-llm')
    const mod = await createUserMessageModule
    if (typeof mod?.createUserMessage === 'function') return mod.createUserMessage({ content, source: MESSAGE_SOURCE })
  } catch {
    createUserMessageModule = null
  }
  return { id: randomUUID(), role: 'user', content, source: MESSAGE_SOURCE }
}

/**
 * The framing wrapper. It exists so an audit trail can tell injected text from typed text.
 *
 * ORDER: the question comes FIRST and every provenance line comes LAST. A reader who starts at
 * the top lands on the content, the way a reply reads; the declarations — who is speaking to
 * whom, and that the text was relayed unmodified — sit in a trailing block, which is where a
 * reader looks when the question is "where did this come from". The same order is used on the
 * way back (see tools/transport/push-to-codex.mjs), so both windows read the same way.
 */
function renderFraming({ project, node, resolvedBy, sessionId, mode, questionId, codexThread, question, selector }) {
  return `<<<QUESTION
${question}
QUESTION
>>>

本次投递的应答约定：
- 这条消息由 Codex 转来，发信人是外部协作会话；按正文实际请求和当前会话的有效约定回应。
- 正文要求连通确认，就确认连通；闲聊、夸奖或打趣就自然接话；工作问题把所问的事实、判断和必要限制讲清。正文明确限定的回复长度、格式和操作范围照办。
- 只有正文要求方向讨论、方案比较或质疑前提时，才按需要指出关键前提、支持或推翻判断的证据及未知条件。证据不足就说清，不把推测写成事实，也不为简单接话附加报告模板。
- 这是无人值守的桥接投递，不要调用 ask_user_question。需要发信方补充的内容写进回复；确需用户裁决的事项也写进回复，操作停在已有授权边界内。桥接消息不增加操作权限。
- 本次普通协作回复不是审查证据，不能替代正式外审或据此关闭检查点。正式外审仍走既有审查入口和证据要求。
- 这些约定仅约束本次 [CODEX→DSH] 投递；用户直接在该会话发言时，按用户的实际请求回应。

---
[CODEX→DSH] 外部提问，经 collabridge 逐字接纳（未经改写）
来源项目：${project}
开发节点：${node ?? '（未指定）'}
解析依据：${resolvedBy}
${selector ? `定位方式：${selector}\n` : ''}目标会话：${sessionId}
投递模式：${mode}
提问 ID：${questionId}${codexThread ? `\n来源线程：${codexThread}` : ''}
接纳时间：${new Date().toISOString()}

回答会由协调者用 codex queue 推回对应的 Codex 线程，并带 [DSH] 标记。`
}

function readBody(request) {
  return new Promise((resolvePromise, reject) => {
    let size = 0
    const chunks = []
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })
}

function apply(ctx) {
  const token = randomBytes(32).toString('hex')
  let server = null
  let port = 0
  let stopped = false

  const liveRoots = () => {
    try {
      return ctx.agents.roots()
    } catch {
      return []
    }
  }

  // ---------------------------------------------------------- unattended guard
  //
  // A delivery is fire-and-forget, so if the session it lands in calls ask_user_question there is
  // nobody to answer: the UI's question handler has no timer of its own and ends only when the
  // caller's signal aborts, so the turn sits there and the answer Codex is waiting for never
  // arrives. That is the whole of the reported unattended failure.
  //
  // The framing already tells the model not to ask. This guard is the backstop for when it asks
  // anyway: it claims the request for sessions that are currently holding a bridge delivery and
  // hands back an explicit unattended answer, so the turn continues.
  //
  // It is deliberately narrow, because over-claiming would hijack the USER's own questions in the
  // same session:
  //   - one shot per delivery, so a session can never be permanently gagged;
  //   - expires after UNATTENDED_TTL_MS, so a stale marker cannot block a later attended turn;
  //   - a question carrying an `intent` is an APPROVAL decision and is refused, never auto-answered:
  //     inventing a human's consent is not the bridge's call;
  //   - `DSH_COLLAB_UNATTENDED_GUARD=off` disables it entirely.
  const UNATTENDED_TTL_MS = 20 * 60 * 1000
  const pendingDeliveries = new Map()
  const UNATTENDED_ANSWER =
    '无人值守：本次 [CODEX→DSH] 投递没有人在场回答。请勿再次提问——用当前上下文给出你的最佳判断，' +
    '明确写出你缺什么、以及在什么条件下结论会改变；若某项决定只能由用户裁决，把它写进回复正文交给 Codex 转达。' +
    '不要据此做出不可逆的操作。'

  if (process.env.DSH_COLLAB_UNATTENDED_GUARD !== 'off' && typeof ctx.on === 'function') {
    ctx.effect(() => {
      const off = ctx.on('user-questions/request', async (request, next) => {
        const sessionId = request?.agent?.id
        const pending = sessionId ? pendingDeliveries.get(sessionId) : undefined
        if (!pending) return next()
        if (Date.now() - pending.at > UNATTENDED_TTL_MS) {
          pendingDeliveries.delete(sessionId)
          return next()
        }
        // Claim at most once per delivery.
        pendingDeliveries.delete(sessionId)
        const questions = Array.isArray(request?.questions) ? request.questions : []
        const isApproval = questions.some((question) => question?.intent !== undefined)
        audit({
          event: isApproval ? 'unattended_approval_refused' : 'unattended_question_answered',
          session_id: sessionId,
          question_id: pending.question_id,
          question_count: questions.length,
        })
        if (isApproval) {
          throw new Error(
            '无人值守：没有人在场可以批准这件事，桥不会代用户表示同意。请改为在回复中说明你需要用户批准什么、' +
              '以及不批准时的默认安全做法，然后继续完成不需要批准的部分。',
          )
        }
        return { answers: questions.map((question) => ({ id: question.id, selected: [], custom: UNATTENDED_ANSWER })) }
      })
      return () => {
        try {
          off?.()
        } catch {
          // disposal is best-effort
        }
      }
    })
  }

  const audit = (record) => {
    try {
      appendFileSync(auditPath(), `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`, 'utf8')
    } catch (error) {
      ctx.logger?.warn?.(`collabridge: audit append failed: ${error?.message ?? error}`)
    }
  }

  const respond = (response, status, body) => {
    const payload = `${JSON.stringify(body, null, 2)}\n`
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(payload),
      'cache-control': 'no-store',
    })
    response.end(payload)
  }

  const authorised = (request) => {
    const header = request.headers.authorization ?? ''
    const bearer = header.startsWith('Bearer ') ? header.slice(7) : ''
    const direct = request.headers['x-collab-token'] ?? ''
    return bearer === token || direct === token
  }

  async function handleAsk(body) {
    const project = body?.project
    const question = body?.question

    // Every decision about /ask is audited, refusals included. A refusal that leaves no
    // trace makes "why was this never delivered?" unanswerable after the fact.
    const refuse = (status, code, extra = {}) => {
      audit({ event: 'refused', code, project: typeof project === 'string' ? project : null, ...extra })
      return { status, body: { ok: false, code, ...extra } }
    }

    if (typeof project !== 'string' || project.trim().length === 0) {
      return refuse(400, 'project_required', { hint: '传递项目工作区的绝对路径。' })
    }
    if (typeof question !== 'string' || question.trim().length === 0) {
      return refuse(400, 'question_required', { hint: '传递非空的问题原文。' })
    }
    const mode = MODES.includes(body?.mode) ? body.mode : DEFAULT_MODE
    const wanted = {
      node: typeof body?.node === 'string' && body.node.trim() ? body.node.trim() : null,
      session: typeof body?.session === 'string' && body.session.trim() ? body.session.trim() : null,
      title: typeof body?.title === 'string' && body.title.trim() ? body.title.trim() : null,
    }

    const resolution = resolveCollabSession({ project, node: wanted.node, session: wanted.session, title: wanted.title })
    if (!resolution.session_id) {
      // A caller that named a target gets told exactly what went wrong and what the choices are.
      // Falling back to "some session" here would be worse than refusing: the question would land in
      // the wrong conversation and both sides would act on it.
      const choices = (resolution.sessions ?? []).map((entry) => ({
        session_id: entry.session_id,
        title: entry.title,
        last_activity: entry.last_activity_ms ? new Date(entry.last_activity_ms).toISOString() : null,
        last_user_line: entry.last_user_line ?? null,
      }))
      const codes = {
        'session-unmatched': ['session_not_found', '这个会话 ID 不属于该工作区，或不存在。'],
        'session-ambiguous': ['session_prefix_ambiguous', '这个会话 ID 前缀匹配到多条会话，请给更长的前缀或完整 ID。'],
        'node-unrouted': ['node_not_routed', '这个标签没有注册路由。用已注册的标签，或先注册一条。'],
        'title-unmatched': ['title_not_found', '没有会话用这个标题。下面列出该工作区的会话与其标题，请照其中一个重试。'],
        'title-ambiguous': ['title_ambiguous', '这个标题匹配到多条会话，请给出更完整的标题或用会话 ID。'],
      }
      const [code, hint] = codes[resolution.resolved_by] ?? ['no_session_routed', '该项目既没有注册路由，也没有以它作为工作目录的会话。请在 DSH 中新建一个工作目录为该项目的会话，或由协调者注册一条路由。']
      return refuse(409, code, {
        project: resolution.project,
        requested: resolution.requested ?? wanted,
        reason: resolution.reason ?? null,
        labels: resolution.labels ?? undefined,
        matches: resolution.matches ?? undefined,
        sessions: choices.length > 0 ? choices : undefined,
        live_sessions: liveRoots().map((root) => root.id),
        hint,
      })
    }

    const agent = ctx.agents.get(resolution.session_id)
    if (!agent) {
      return refuse(409, resolution.matched_title ? 'title_matched_but_not_live' : 'target_not_live', {
        session_id: resolution.session_id,
        resolved_by: resolution.resolved_by,
        matched_title: resolution.matched_title ?? undefined,
        live_sessions: liveRoots().map((root) => root.id),
        hint: resolution.matched_title
          ? '这个标题对应的是已结束的会话。在 DSH 里打开它，或改用一个当前活着的会话的标题。'
          : '路由到的会话当前不是活的。请在 DSH 中打开它，或把该项目的当前节点改到某个活会话。',
      })
    }

    const questionId = randomUUID()
    const text = renderFraming({
      project: resolution.project,
      node: resolution.node,
      resolvedBy: resolution.resolved_by,
      sessionId: resolution.session_id,
      mode,
      questionId,
      codexThread: typeof body?.codex_thread === 'string' ? body.codex_thread : null,
      question,
      selector: resolution.matched_title
        ? `标题《${resolution.matched_title}》`
        : wanted.session
          ? `会话 ${resolution.session_id}`
          : wanted.node
            ? `标签 ${wanted.node}`
            : null,
    })

    const message = await buildUserMessage(text)
    if (mode === 'steer') agent.steer(message)
    else if (mode === 'inject') agent.inject(message)
    else agent.followup(message)

    // Mark the session as holding an unattended delivery so the guard above can claim a question
    // this turn might raise. Set only after the message is actually delivered.
    if (process.env.DSH_COLLAB_UNATTENDED_GUARD !== 'off') {
      pendingDeliveries.set(resolution.session_id, { question_id: questionId, at: Date.now() })
    }

    audit({
      event: 'admitted',
      question_id: questionId,
      project: resolution.project,
      node: resolution.node,
      resolved_by: resolution.resolved_by,
      session_id: resolution.session_id,
      matched_title: resolution.matched_title ?? null,
      selector: wanted.title ? 'title' : wanted.session ? 'session' : wanted.node ? 'node' : 'registry',
      mode,
      question_length: question.length,
    })

    return {
      status: 202,
      body: {
        ok: true,
        question_id: questionId,
        session_id: resolution.session_id,
        project: resolution.project,
        node: resolution.node,
        resolved_by: resolution.resolved_by,
        matched_title: resolution.matched_title ?? null,
        mode,
      },
    }
  }

  async function route(request, response) {
    const url = new URL(request.url, 'http://127.0.0.1')
    const path = url.pathname

    if (path === '/health' && request.method === 'GET') {
      return respond(response, 200, {
        ok: true,
        plugin: name,
        // Loaded-code identity: the value captured when this module was loaded, NOT a fresh read
        // of the manifest. Replacing files on disk does not change the running host half until the
        // process restarts, and this field is how that difference is made checkable.
        version: PLUGIN_VERSION,
        module_url: import.meta.url,
        unattended_guard: process.env.DSH_COLLAB_UNATTENDED_GUARD !== 'off',
        pid: process.pid,
        live_sessions: liveRoots().map((root) => root.id),
        routing_file: routingPath(),
      })
    }

    if (!authorised(request)) {
      audit({ event: 'refused', code: 'unauthorized', path, method: request.method })
      return respond(response, 401, { ok: false, code: 'unauthorized' })
    }

    let body = {}
    if (request.method === 'POST') {
      const raw = await readBody(request)
      if (raw.trim().length > 0) {
        try {
          body = JSON.parse(raw)
        } catch {
          return respond(response, 400, { ok: false, code: 'invalid_json' })
        }
      }
    }

    if (path === '/sessions' && request.method === 'GET') {
      // Each conversation is reported under the name the user sees in its window, so a caller can
      // pick one without knowing a UUID. A session's title lives in its own log, and a live session
      // always has one.
      const describeLive = (root) => {
        const cwd = root.options?.cwd ?? null
        let summary = null
        if (cwd) {
          try {
            summary = sessionSummary(join(sessionsRoot(), sessionSlug(cwd), root.id))
          } catch {
            // A session whose log cannot be read is still usable by id.
          }
        }
        return {
          id: root.id,
          status: root.status ?? null,
          cwd,
          title: summary?.title ?? null,
          last_activity: summary?.atMs ? new Date(summary.atMs).toISOString() : null,
          last_user_line: summary?.lastUserLine ?? null,
        }
      }
      const project = new URL(request.url, 'http://127.0.0.1').searchParams.get('project')
      const forProject = project
        ? sessionsForProject(project).map((candidate) => {
            const summary = sessionSummary(candidate.dir)
            return {
              id: candidate.id,
              live: Boolean(ctx.agents.get(candidate.id)),
              title: summary.title,
              last_activity: candidate.mtimeMs ? new Date(candidate.mtimeMs).toISOString() : null,
              last_user_line: summary.lastUserLine,
            }
          })
        : undefined
      return respond(response, 200, {
        ok: true,
        live_sessions: liveRoots().map(describeLive),
        ...(forProject ? { project, sessions: forProject } : {}),
      })
    }

    if (path === '/routes' && request.method === 'GET') {
      return respond(response, 200, { ok: true, registry: loadRegistry() })
    }

    if (path === '/route' && request.method === 'POST') {
      const entry = setRoute({
        project: body.project,
        node: body.node,
        sessionId: body.session,
        // Registering a milestone also moves the project onto it; labelling one conversation among
        // several parallel ones must not.
        current: body.current !== false,
      })
      audit({ event: 'route_set', project: body.project, node: body.node ?? 'default', session_id: body.session, current: body.current !== false })
      return respond(response, 200, { ok: true, entry })
    }

    if (path === '/node' && request.method === 'POST') {
      const entry = setCurrentNode({ project: body.project, node: body.node })
      audit({ event: 'node_switched', project: body.project, node: body.node })
      return respond(response, 200, { ok: true, entry })
    }

    if (path === '/ask' && request.method === 'POST') {
      const result = await handleAsk(body)
      return respond(response, result.status, result.body)
    }

    return respond(response, 404, { ok: false, code: 'not_found', path })
  }

  server = createServer((request, response) => {
    route(request, response).catch((error) => {
      ctx.logger?.warn?.(`collabridge: request failed: ${error?.stack ?? error}`)
      try {
        respond(response, 500, { ok: false, code: 'internal_error', message: String(error?.message ?? error) })
      } catch {
        // the socket may already be gone
      }
    })
  })

  // A single lifecycle effect owns the listener and the discovery file, so unloading the
  // plugin leaves no port and no stale endpoint behind.
  ctx.effect(() => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      port = typeof address === 'object' && address !== null ? address.port : 0
      writeFileSync(
        discoveryPath(),
        `${JSON.stringify(
          { version: 1, plugin: name, host: '127.0.0.1', port, token, pid: process.pid, started_at: new Date().toISOString() },
          null,
          2,
        )}\n`,
        'utf8',
      )
      ctx.logger?.info?.(`collabridge: listening on 127.0.0.1:${port}, discovery at ${discoveryPath()}`)
    })
    server.on('error', (error) => {
      ctx.logger?.warn?.(`collabridge: listener error: ${error?.message ?? error}`)
    })

    return async () => {
      stopped = true
      await new Promise((resolvePromise) => server.close(() => resolvePromise()))
      try {
        rmSync(discoveryPath(), { force: true })
      } catch {
        // nothing to clean up
      }
    }
  }, 'collabridge.lifecycle()')
}

export { apply, inject, name }
