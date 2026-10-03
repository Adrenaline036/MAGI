#!/usr/bin/env node
// Decode a persisted DSH session log into events, usage accounting, and a
// verifiable list of the shell commands the agent actually executed.
//
// Two facts about the format drive this module:
//   1. A session log is zstd JSONL flushed in segments, so the file holds many
//      concatenated zstd frames. zstdDecompressSync returns only the first frame,
//      which is the bare session header; frames must be located and decoded one
//      by one.
//   2. The harness writes the log itself, so tool calls recorded here are evidence
//      about what the agent did, independent of anything the agent claims.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { zstdDecompressSync } from 'node:zlib'
import { dshHome } from './home.mjs'

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const BARE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// The log's filename is GENERATIONAL, not fixed. DSH writes one file per session-format
// generation — `<name>.v<N>.jsonl.zstd` — and older generations are left on disk beside it,
// under the pre-versioning name `session.jsonl.zstd` (a directory contains 840 of those and
// 20 `session.v4.*` ones at the time of writing). Hard-coding one name therefore reads
// nothing at all for sessions of the other generation, and because a log that has not been
// flushed yet is a legitimate empty state, that failure is SILENT: usage reads as zero model
// calls, and a dead reviewer turn is reported as "no turn-level error was recorded" instead
// of naming the provider rejection that killed it. Resolve the file that is actually there.
const LOG_FILENAME = /^session(?:\.v(\d+))?\.jsonl(\.zstd)?$/

// The log file to read for one session directory, or null when none has been flushed yet.
// Highest format generation wins; the legacy unversioned name counts as the oldest. When a
// generation exists in both encodings, the compressed one is preferred because that is what
// the harness writes by default.
export function sessionLogFile(sessionDir) {
  let entries
  try {
    entries = readdirSync(sessionDir)
  } catch {
    return null
  }
  const candidates = []
  for (const name of entries) {
    const match = LOG_FILENAME.exec(name)
    if (!match) continue
    candidates.push({
      name,
      path: join(sessionDir, name),
      version: match[1] ? Number(match[1]) : 0,
      compressed: match[2] === '.zstd',
    })
  }
  if (candidates.length === 0) return null
  candidates.sort((a, b) => b.version - a.version || Number(b.compressed) - Number(a.compressed))
  return candidates[0]
}

// Sessions live under the ACTIVE home, resolved in one place (./home.mjs).
//
// This used to hardcode `%APPDATA%\dsh-desktop\harness\sessions`, which was right until dsh
// 0.2.0-rc.2 moved the home to `~/.dsh`. The failure mode was silent and expensive: the bridge
// listed ANOTHER installation's sessions, found no session of its own, and reported
// REVIEW_WORKFLOW_NOT_CALLED ("the conductor never called the workflow tool") while the conductor
// and its reviewer had in fact run correctly for ninety seconds. Every telemetry field was empty
// in the same archive, which is what gives it away.
export function sessionsRoot() {
  return join(dshHome(), 'sessions')
}

export function sessionSlug(cwd) {
  return `--${cwd.replace(/:/g, '').replace(/[\\/]/g, '-')}--`
}

// A root session directory is named `session-<uuid>`; a delegated child agent gets a
// directory named by its bare childId. Filtering on the `session-` prefix alone makes
// every workflow-spawned agent invisible, which silently destroys command telemetry.
export function listSessions(cwd) {
  const root = join(sessionsRoot(), sessionSlug(cwd))
  let names
  try {
    names = readdirSync(root)
  } catch {
    return []
  }
  return names
    .filter((name) => name.startsWith('session-') || BARE_UUID.test(name))
    .map((name) => ({
      id: name,
      dir: join(root, name),
      mtimeMs: statSync(join(root, name)).mtimeMs,
      kind: name.startsWith('session-') ? 'root' : 'child',
    }))
    .sort((a, b) => a.mtimeMs - b.mtimeMs)
}

// Session ids present now. A caller snapshots this before launching a reviewer and
// diffs it afterwards, which binds the review to its own session without relying on
// timestamps or ordering.
export function sessionIds(cwd) {
  return listSessions(cwd).map((session) => session.id)
}

export function readSessionEvents(sessionDir) {
  // A session directory exists from the moment the runtime creates the session, but the log file
  // appears only on the first flush. Reading in that window used to throw ENOENT, and in the review
  // path that turned a healthy session into a failed package. An empty log is a valid state that
  // carries zero events, not an error.
  const file = sessionLogFile(sessionDir)
  if (!file) return { events: [], frames: 0, brokenFrames: 0, bytes: 0, file: null }

  let buf
  try {
    buf = readFileSync(file.path)
  } catch (error) {
    if (error?.code === 'ENOENT') return { events: [], frames: 0, brokenFrames: 0, bytes: 0, file: null }
    throw error
  }

  if (!file.compressed) {
    // The harness can be configured to write plain JSONL instead of its default zstd segments.
    const events = []
    for (const line of buf.toString('utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        events.push(JSON.parse(line))
      } catch {
        // Same tolerance as the compressed path: an unparseable line carries no event.
      }
    }
    return { events, frames: 1, brokenFrames: 0, bytes: buf.length, file: file.name }
  }

  const offsets = []
  let index = buf.indexOf(ZSTD_MAGIC)
  while (index !== -1) {
    offsets.push(index)
    index = buf.indexOf(ZSTD_MAGIC, index + 4)
  }
  const events = []
  let brokenFrames = 0
  for (const [i, start] of offsets.entries()) {
    const end = i + 1 < offsets.length ? offsets[i + 1] : buf.length
    let text
    try {
      text = zstdDecompressSync(buf.subarray(start, end)).toString('utf8')
    } catch {
      brokenFrames += 1
      continue
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        events.push(JSON.parse(line))
      } catch {
        // A segment flush can split a JSONL line; the fragment carries no event.
      }
    }
  }
  return { events, frames: offsets.length, brokenFrames, bytes: buf.length, file: file.name }
}

// Provider usage. The harness has written this in two shapes, and a legacy-generation log carries
// BOTH for the same call:
//   legacy:  a top-level `assistant/chunk` event whose chunk is a `usage` report
//   current: the finished `assistant/message` carries `data.usage` directly, and no
//            `assistant/chunk` events are emitted at all (session format v4)
// Counting both shapes therefore double-counted every legacy session -- measured on this machine,
// 827 of 864 session directories hold both shapes with identical per-call turn/step keys and
// identical token totals, so a 2-call session reported modelCalls=4 and twice every token sum.
// Identity must be shared across the two branches, not tracked inside one of them.
export function usageFromEvents(events) {
  const calls = []
  const seen = new Set()
  // One model call is one step of one turn. Both shapes record that pair; a message id is only a
  // fallback for a record that lacks it, because the two shapes do not share ids.
  const callKey = (data, message) => {
    if (Number.isFinite(data?.turn) && Number.isFinite(data?.step)) return `call:${data.turn}/${data.step}`
    if (typeof message?.id === 'string' && message.id.length > 0) return `msg:${message.id}`
    return null
  }
  const accept = (key) => {
    if (key === null) return true
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }

  for (const event of events) {
    if (event?.type === 'assistant/message' && event.data?.usage) {
      if (!accept(callKey(event.data, event.data.message))) continue
      calls.push(usageFields(event.data.usage))
      continue
    }
    if (event?.type !== 'assistant/chunk') continue
    const chunk = event.data?.chunk
    if (chunk?.type !== 'usage' || !chunk.usage) continue
    if (!accept(callKey(event.data, event.data.message))) continue
    calls.push(usageFields(chunk.usage))
  }
  const sum = (key) => calls.reduce((acc, call) => acc + (call[key] ?? 0), 0)
  const inputTokens = sum('inputTokens')
  const cacheReadTokens = sum('cacheReadTokens')
  const promptLike = inputTokens + cacheReadTokens
  return {
    modelCalls: calls.length,
    inputTokens,
    cacheReadTokens,
    outputTokens: sum('outputTokens'),
    reasoningTokens: sum('reasoningTokens'),
    totalTokens: sum('totalTokens'),
    // Share of prompt-side tokens served from cache, from provider numbers only.
    cacheHitRatio: promptLike > 0 ? Number((cacheReadTokens / promptLike).toFixed(4)) : null,
  }
}

function usageFields(usage) {
  return {
    inputTokens: usage.inputTokens ?? 0,
    cacheReadTokens: usage.cacheReadTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    reasoningTokens: usage.reasoningTokens ?? 0,
    totalTokens: usage.totalTokens ?? 0,
  }
}

// The text and error flag of one tool result, in both shapes the harness has written:
//   legacy: message.content = [{ type: 'tool-result', content: [{ type: 'text', text, isError }] }]
//   current: message.content = [{ type: 'text', text }] with isError on the message itself
// Only the legacy path is nested, and reading it alone yields `null` for every result of the
// current shape — which is how a whole review's return value goes missing while every count
// still looks plausible. Measured on this machine: 3076 of 3076 recorded tool results use the
// flat shape and all 3076 carry `message.isError`.
export function toolResultContent(message) {
  const blocks = Array.isArray(message?.content) ? message.content : []
  const messageIsError = typeof message?.isError === 'boolean' ? message.isError : null
  for (const block of blocks) {
    const nested = Array.isArray(block?.content) ? block.content.find((entry) => typeof entry?.text === 'string') : null
    if (nested) {
      return { text: nested.text, isError: typeof nested.isError === 'boolean' ? nested.isError : messageIsError }
    }
    if (typeof block?.text === 'string') {
      return { text: block.text, isError: typeof block.isError === 'boolean' ? block.isError : messageIsError }
    }
  }
  return { text: null, isError: messageIsError }
}

// Every tool call the agent made, joined to its result. `arguments` arrives as a
// JSON string. This is evidence, not a self-report.
export function toolCallsFromEvents(events) {
  const byCallId = new Map()
  for (const event of events) {
    const data = event?.data
    if (!data || typeof data !== 'object') continue
    if (event.type === 'tool/call') {
      let args = null
      try {
        args = typeof data.arguments === 'string' ? JSON.parse(data.arguments) : (data.arguments ?? null)
      } catch {
        args = null
      }
      byCallId.set(data.callId, { callId: data.callId, seq: event.seq ?? null, tool: data.name ?? null, args, isError: null, resultText: null })
      continue
    }
    if (event.type === 'tool/result') {
      const callId = data.message?.source?.callId
      const entry = byCallId.get(callId)
      if (!entry) continue
      const result = toolResultContent(data.message)
      entry.isError = result.isError
      entry.resultText = result.text
    }
  }
  return [...byCallId.values()].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
}

// Child agents a workflow run spawned, from the parent's own progress events. This
// binds telemetry to a specific run rather than to "whatever appeared meanwhile".
export function workflowChildIds(events) {
  const ids = new Set()
  for (const event of events) {
    if (event?.type !== 'tool-workflow/agent-start') continue
    const childId = event.data?.childId
    if (typeof childId === 'string' && childId.length > 0) ids.add(childId)
  }
  return [...ids]
}

// The effective sandbox mode recorded by the harness, as direct evidence that a
// delegation really ran read-only rather than merely being told to.
export function sandboxModesFromEvents(events) {
  const modes = []
  for (const event of events) {
    if (event?.type === 'sandbox/mode') modes.push(event.data?.mode ?? null)
    if (event?.type === 'permission/preset') modes.push(`preset:${event.data?.preset ?? 'unknown'}`)
  }
  return modes
}

// Shell commands only, with the harness-reported exit marker when present.
export function shellCommandsFromEvents(events) {  const commands = []
  for (const call of toolCallsFromEvents(events)) {
    if (!call.tool || !/pwsh|bash|shell|terminal/i.test(call.tool)) continue
    const command = call.args?.command ?? call.args?.cmd ?? null
    if (typeof command !== 'string') continue
    const marker = call.resultText?.match(/\[exit code:\s*(\d+)\]/i)
    commands.push({
      seq: call.seq,
      tool: call.tool,
      command,
      isError: call.isError,
      exitCode: marker ? Number(marker[1]) : null,
    })
  }
  return commands
}

function main() {
  const cwd = process.argv[2]
  if (!cwd) throw new Error('usage: node session-log.mjs <cwd> [sessionIdFragment]')
  const sessions = listSessions(cwd)
  console.log(`sessions for ${cwd}: ${sessions.length}`)
  const selected = process.argv[3] ? sessions.filter((s) => s.id.includes(process.argv[3])) : sessions
  for (const session of selected) {
    const { events, frames, brokenFrames, bytes } = readSessionEvents(session.dir)
    const usage = usageFromEvents(events)
    const commands = [...shellCommandsFromEvents(events)]
    console.log(`\n${session.id}`)
    console.log(`  bytes=${bytes} frames=${frames} brokenFrames=${brokenFrames} events=${events.length}`)
    console.log(
      `  usage: modelCalls=${usage.modelCalls} input=${usage.inputTokens} cacheRead=${usage.cacheReadTokens} ` +
        `output=${usage.outputTokens} reasoning=${usage.reasoningTokens} cacheHitRatio=${usage.cacheHitRatio}`,
    )
    console.log(`  shell commands executed (harness-recorded): ${commands.length}`)
    for (const command of commands.slice(0, 8)) {
      console.log(`    [exit=${command.exitCode} err=${command.isError}] ${command.command.slice(0, 120)}`)
    }
  }
}

// Why an agent stopped, when it stopped because of an error rather than finishing.
//
// A reviewer whose turn dies mid-flight makes the workflow's `agent()` resolve null, and the only
// thing a null return says is "no result" -- which the bridge then reported as "the returned value
// is not a JSON object", sending everyone after a formatting defect that did not exist. The real
// reason is recorded here, in the failing turn: a provider rejection (HTTP 400 "Content Exists
// Risk" is one seen in practice), a context overflow, or a transport error. Naming it converts an
// opaque malformed-return report into something the coordinator can act on or escalate.
export function turnFailureFromEvents(events) {
  for (const event of events) {
    if (event?.type !== 'turn/end') continue
    const reason = event.data?.reason
    if (reason?.kind === 'error' && reason.error) {
      return {
        message: reason.error.message ?? null,
        code: reason.error.code ?? null,
        status: reason.error.status ?? null,
        step: null,
      }
    }
  }
  // A turn may lack a clean end record if the process was cut off; the failing step still carries
  // the provider's finish reason.
  for (const event of events) {
    if (event?.type !== 'assistant/chunk') continue
    const reason = event.data?.chunk?.reason
    if (event.data?.chunk?.type === 'finish' && reason?.kind === 'error' && reason.failure) {
      return {
        message: reason.failure.message ?? null,
        code: reason.failure.code ?? null,
        status: reason.failure.status ?? null,
        step: event.data?.step ?? null,
      }
    }
  }
  return null
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) main()
