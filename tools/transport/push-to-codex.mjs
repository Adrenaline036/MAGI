#!/usr/bin/env node
// Push a DSH answer back into the Codex thread that asked.
//
// Until now this was a manual step: find which Codex thread belongs to the project, then
// queue the message. This automates the lookup by matching the newest rollout whose
// recorded cwd is the project, and it does the queueing in Node so long messages with
// punctuation never pass through a shell.
//
// The message is delivered as a normal user turn, which is the point: Codex receives DSH's
// words, not Codex's summary of them.

import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, openSync, readSync, closeSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const codexHome = join(process.env.USERPROFILE, '.codex')
const sessionsRoot = join(codexHome, 'sessions')

// Resolve the Codex CLI's JS entry instead of its .cmd shim: spawning a .cmd from Node
// needs a shell, and a shell reintroduces the argument-quoting problem this avoids.
function resolveCodexEntry() {
  const candidates = [
    join(process.env.APPDATA, 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js'),
    join(process.env.USERPROFILE, 'AppData', 'Roaming', 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js'),
  ]
  for (const candidate of candidates) if (existsSync(candidate)) return candidate
  throw new Error('could not locate the codex CLI entry; set CODEX_CLI_ENTRY')
}

// Read only the head of a rollout: session_meta sits at the top, and these files can reach
// hundreds of megabytes.
function readSessionMeta(file) {
  const size = statSync(file).size
  const want = Math.min(size, 256 * 1024)
  const buffer = Buffer.allocUnsafe(want)
  const fd = openSync(file, 'r')
  readSync(fd, buffer, 0, want, 0)
  closeSync(fd)
  const text = buffer.toString('utf8')
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const record = JSON.parse(line)
      if (record.type === 'session_meta') return record.payload ?? {}
    } catch {
      // a truncated final line in the window is expected
    }
  }
  return null
}

function walkRollouts(dir, out = []) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      walkRollouts(full, out)
      continue
    }
    if (!entry.name.endsWith('.jsonl') || !entry.name.startsWith('rollout-')) continue
    const match = entry.name.match(/^rollout-(\d{4}-\d{2}-\d{2}T[\d-]+)-([0-9a-f-]{36})\.jsonl$/)
    if (!match) continue
    out.push({ file: full, id: match[2], mtimeMs: statSync(full).mtimeMs, size: statSync(full).size })
  }
  return out
}

function normalise(path) {
  return String(path).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/**
 * Find the Codex thread a project's messages belong to: the most recently written rollout
 * whose recorded cwd is that project. `maxAgeMinutes` guards against answering into a
 * conversation that went cold hours ago.
 */
export function resolveCodexThread({ project, maxAgeMinutes = 120, sessionsDir = sessionsRoot }) {
  const target = normalise(project)
  const candidates = walkRollouts(sessionsDir)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, 60)
  for (const candidate of candidates) {
    const meta = readSessionMeta(candidate.file)
    if (!meta?.cwd) continue
    if (normalise(meta.cwd) !== target) continue
    const ageMinutes = (Date.now() - candidate.mtimeMs) / 60000
    return {
      id: candidate.id,
      file: candidate.file,
      cwd: meta.cwd,
      mtimeMs: candidate.mtimeMs,
      ageMinutes: Number(ageMinutes.toFixed(2)),
      fresh: ageMinutes <= maxAgeMinutes,
    }
  }
  return null
}

/**
 * Thread titles, one per thread: the name the Codex window shows.
 *
 * Two facts make this less trivial than reading a map. A thread is renamed while it is in use, and
 * `session_index.jsonl` keeps one line per write, so the SAME id appears several times with different
 * names; the newest `updated_at` is the current one. A rename can also land with an empty name before
 * the new one is written, so an empty newest name falls back to the newest non-empty one.
 */
export function readThreadTitles(codexHome = join(process.env.USERPROFILE, '.codex')) {
  const indexPath = join(codexHome, 'session_index.jsonl')
  const titles = new Map()
  if (!existsSync(indexPath)) return titles
  for (const line of readFileSync(indexPath, 'utf8').split('\n')) {
    if (!line.trim()) continue
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      // A partially written line carries no title.
      continue
    }
    if (typeof entry.id !== 'string' || entry.id.length === 0) continue
    const updatedAt = typeof entry.updated_at === 'string' ? entry.updated_at : ''
    const name = typeof entry.thread_name === 'string' ? entry.thread_name.trim() : ''
    const current = titles.get(entry.id) ?? { title: '', updatedAt: '', lastNamedAt: '' }
    if (updatedAt >= current.updatedAt) current.updatedAt = updatedAt
    if (name.length > 0 && updatedAt >= current.lastNamedAt) {
      current.title = name
      current.lastNamedAt = updatedAt
    }
    titles.set(entry.id, current)
  }
  return titles
}

export function normaliseTitle(title) {
  return String(title ?? '').replace(/\s+/g, ' ').trim().toLowerCase()
}

/**
 * Find the thread whose title the caller named.
 *
 * Same rules as the inbound side, deliberately: an exact title wins; otherwise a title containing
 * the text wins if it is the only one; several matches or none return the candidates instead of a
 * guess. A wrong thread receives DSH's words as if they belonged there, which is worse than making
 * the caller look at the list.
 */
export function resolveCodexThreadByTitle({ title, codexHome = join(process.env.USERPROFILE, '.codex'), sessionsDir = join(codexHome, 'sessions'), maxCandidates = 20 } = {}) {
  const wanted = normaliseTitle(title)
  if (wanted.length === 0) return { ok: false, reason: 'title_required', matches: [] }
  const titles = readThreadTitles(codexHome)
  const seenThreads = new Set()
  const candidates = walkRollouts(sessionsDir)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    // One thread can own several rollout files: a resumed or forked conversation gets another one. The
    // newest rollout is the live view of it, so the older ones must not turn into duplicate candidates.
    .filter((candidate) => {
      if (seenThreads.has(candidate.id)) return false
      seenThreads.add(candidate.id)
      return true
    })
    .map((candidate) => {
      const meta = readSessionMeta(candidate.file)
      const record = titles.get(candidate.id)
      return {
        id: candidate.id,
        title: record?.title ?? '',
        mtimeMs: candidate.mtimeMs,
        cwd: meta?.cwd ?? null,
      }
    })
  const named = candidates.filter((candidate) => candidate.title.length > 0)
  const exact = named.filter((candidate) => normaliseTitle(candidate.title) === wanted)
  const partial = exact.length > 0 ? exact : named.filter((candidate) => normaliseTitle(candidate.title).includes(wanted))
  const describe = (candidate) => ({
    thread_id: candidate.id,
    title: candidate.title,
    last_activity: new Date(candidate.mtimeMs).toISOString(),
    cwd: candidate.cwd,
  })
  if (partial.length !== 1) {
    return {
      ok: false,
      reason: partial.length > 1 ? 'title_ambiguous' : 'title_not_found',
      requested: title,
      matches: partial.slice(0, maxCandidates).map(describe),
      candidates: named.slice(0, maxCandidates).map(describe),
    }
  }
  const hit = partial[0]
  const ageMinutes = (Date.now() - hit.mtimeMs) / 60000
  return {
    ok: true,
    thread: {
      id: hit.id,
      title: hit.title,
      cwd: hit.cwd,
      mtimeMs: hit.mtimeMs,
      ageMinutes: Number(ageMinutes.toFixed(2)),
      fresh: ageMinutes <= 120,
      resolvedBy: 'title',
      titleMatchedExactly: exact.length === 1,
    },
  }
}

function queueMessage({ thread, message }) {  const entry = resolveCodexEntry()
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [entry, 'queue', '--thread', thread, '--message', message], {
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (c) => {
      stdout += c
    })
    child.stderr.on('data', (c) => {
      stderr += c
    })
    child.on('error', (error) => resolvePromise({ code: null, stdout, stderr: String(error.message) }))
    child.on('close', (code) => resolvePromise({ code, stdout, stderr }))
  })
}

/**
 * Append the marker once, so a reader can always tell agent-authored turns from typed ones.
 *
 * The answer body stays FIRST and the marker block goes LAST. The push exists to put DSH's own
 * words into the thread, so a reader starting at the top must land on those words rather than on
 * a declaration about them; the provenance line is what a reader looks for afterwards, when
 * asking where the text came from. `---` separates the two, with a blank line in front of it so
 * Markdown does not read the last content line as a setext heading.
 */
const ANSWER_MARK = '[DSH] 以上是 DSH 协作会话的回答原文，未经 Codex 改写。'

export function markAnswer({ answer, questionId, basis }) {
  // `startsWith` keeps the old prefix-format message from being marked twice; `includes` does the
  // same for the footer format this now writes.
  if (answer.startsWith('[DSH]') || answer.includes(ANSWER_MARK)) return answer
  const footer = [
    '---',
    ANSWER_MARK,
    `依据：${questionId ? `提问 ID ${questionId}` : '本次对话' }${basis ? `；${basis}` : ''}`,
  ].join('\n')
  return `${answer}\n\n${footer}`
}

function parseFlags(argv) {
  const flags = {}
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue
    flags[argv[i].slice(2)] = argv[i + 1] ?? true
    i += 1
  }
  return flags
}

async function main() {
  const flags = parseFlags(process.argv.slice(2))
  if (!flags.project && !flags.title && !flags.thread) {
    throw new Error('usage: push-to-codex.mjs [--project <path> | --title <thread title> | --thread <id>] --message-file <f> [--question-id <id>] [--basis <text>] [--dry-run]')
  }

  const { readFileSync } = await import('node:fs')
  const raw = flags['message-file'] ? readFileSync(flags['message-file'], 'utf8') : flags.message
  if (typeof raw !== 'string' || raw.trim().length === 0) throw new Error('a non-empty --message-file or --message is required')

  // Most explicit wins: an id, then a named title, then the project's most recent thread.
  let thread = null
  let resolvedBy = null
  if (flags.thread) {
    thread = { id: flags.thread, cwd: null, ageMinutes: null, fresh: true }
    resolvedBy = 'explicit'
  } else if (typeof flags.title === 'string') {
    const titled = resolveCodexThreadByTitle({ title: flags.title })
    if (!titled.ok) {
      process.stdout.write(`${JSON.stringify({ ok: false, code: titled.reason, requested: titled.requested, matches: titled.matches, candidates: titled.candidates }, null, 2)}\n`)
      process.exitCode = 3
      return
    }
    thread = titled.thread
    resolvedBy = titled.thread.titleMatchedExactly ? 'title' : 'title-fragment'
  } else {
    thread = resolveCodexThread({ project: flags.project })
    resolvedBy = 'project'
  }
  if (!thread) {
    process.stdout.write(`${JSON.stringify({ ok: false, code: 'no_codex_thread_for_project', project: flags.project }, null, 2)}\n`)
    process.exitCode = 3
    return
  }

  const message = markAnswer({ answer: raw, questionId: flags['question-id'], basis: flags.basis })
  const record = {
    ok: true,
    thread_id: thread.id,
    thread_title: thread.title ?? null,
    resolved_by: resolvedBy,
    thread_cwd: thread.cwd,
    thread_age_minutes: thread.ageMinutes,
    thread_fresh: thread.fresh,
    message_length: message.length,
    dry_run: Boolean(flags['dry-run']),
  }

  if (flags['dry-run']) {
    process.stdout.write(`${JSON.stringify(record, null, 2)}\n`)
    return
  }

  const result = await queueMessage({ thread: thread.id, message })
  record.queue_exit = result.code
  record.queue_stdout = result.stdout.trim().slice(0, 300)
  if (result.code !== 0) {
    record.ok = false
    record.queue_stderr = result.stderr.trim().slice(0, 300)
    process.exitCode = 1
  } else {
    try {
      appendFileSync(
        join(import.meta.dirname, '..', 'push-audit.jsonl'),
        `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`,
        'utf8',
      )
    } catch {
      // the push already happened; a failed audit append must not report failure
    }
  }
  process.stdout.write(`${JSON.stringify(record, null, 2)}\n`)
}

if (process.argv[1] && import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`) {
  main().catch((error) => {
    process.stderr.write(`push-to-codex: ${error?.message ?? error}\n`)
    process.exitCode = 1
  })
}
