#!/usr/bin/env node
// Push a DSH answer back into the Codex thread that asked.
//
// 兼容入口仅转交插件统一回复入口，不拥有投递策略。

import { existsSync, openSync, readSync, closeSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { runReplyCli } from '../../lib/reply.mjs'
export { markAnswer } from '../../lib/reply.mjs'

const codexHome = join(process.env.USERPROFILE, '.codex')
const sessionsRoot = join(codexHome, 'sessions')

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
 * An ISO timestamp as a comparable key.
 *
 * The index's `updated_at` values are NOT all written at the same precision: the writer trims trailing
 * zeros, so the same second can appear as `…T21:35:13.283917Z` and `…T21:35:13.2839177Z`. Compared as
 * strings the first one wins, because `Z` sorts above `7`, and the LATER write is then taken for the
 * older one. Measured on the real index: 95 lines carry seven fractional digits, seven carry six and
 * one carries five, so the shape is real even though no two writes shared a second on the day this was
 * found. Compare the second numerically and the fraction as a fixed-width digit string.
 */
function timeKey(value) {
  const text = String(value ?? '')
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?/.exec(text)
  if (!m) return { seconds: 0, fraction: '' }
  return { seconds: Date.parse(`${m[1]}Z`) || 0, fraction: (m[2] ?? '').padEnd(9, '0').slice(0, 9) }
}

function isLater(a, b) {
  if (a.seconds !== b.seconds) return a.seconds > b.seconds
  return a.fraction > b.fraction
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
    const at = timeKey(entry.updated_at)
    const name = typeof entry.thread_name === 'string' ? entry.thread_name.trim() : ''
    const current = titles.get(entry.id) ?? { title: '', updatedAt: { seconds: 0, fraction: '' }, lastNamedAt: { seconds: 0, fraction: '' } }
    if (isLater(at, current.updatedAt)) current.updatedAt = at
    if (name.length > 0 && isLater(at, current.lastNamedAt)) {
      current.title = name
      current.lastNamedAt = at
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

export function parseFlags(argv) {
  const flags = {}
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue
    const token = argv[i].slice(2)
    // `--name=value` is the spelling a shell produces for `--name="$VAR"`, and an unset variable makes
    // it `--name=`. Treating the whole token as a key recorded `{"name=": true}`, so a named title never
    // reached the resolver and the call fell through to project targeting: the answer was delivered to
    // a thread the caller never named. Split at the first `=`, and keep an empty value as an empty
    // string so the empty-title rule sees it.
    const equals = token.indexOf('=')
    if (equals !== -1) {
      flags[token.slice(0, equals)] = token.slice(equals + 1)
      continue
    }
    const next = argv[i + 1]
    // A following flag is not this flag's value: `--title --dry-run` used to set the title to the
    // literal "--dry-run" and silently consume the dry run.
    if (next === undefined || next.startsWith('--')) {
      flags[token] = true
      continue
    }
    flags[token] = next
    i += 1
  }
  return flags
}

/**
 * Which Codex thread a push is addressed to.
 *
 * Kept separate from main() so the policy — including what must be REFUSED — is testable without
 * spawning a process. Naming something and having it silently resolve to something else is the one
 * outcome this must never produce: a caller whose `--title "$TITLE"` expanded to nothing would
 * otherwise get the project's newest thread and never learn that its name was ignored.
 */
export function resolveTarget({ flags, codexHome, sessionsDir } = {}) {
  if ('title' in flags && (typeof flags.title !== 'string' || flags.title.trim() === '')) {
    return {
      ok: false,
      reason: 'title_required',
      hint: '--title was given without a non-empty value; it is refused rather than falling back to --project.',
    }
  }
  if (flags.thread) return { ok: true, thread: { id: flags.thread, title: null, cwd: null, ageMinutes: null, fresh: true }, resolvedBy: 'explicit' }
  if (typeof flags.title === 'string') {
    const titled = resolveCodexThreadByTitle({ title: flags.title, codexHome, sessionsDir })
    if (!titled.ok) return { ok: false, reason: titled.reason, requested: titled.requested, matches: titled.matches, candidates: titled.candidates }
    return { ok: true, thread: titled.thread, resolvedBy: titled.thread.titleMatchedExactly ? 'title' : 'title-fragment' }
  }
  const byProject = resolveCodexThread({ project: flags.project })
  if (!byProject) return { ok: false, reason: 'no_codex_thread_for_project', project: flags.project }
  return { ok: true, thread: byProject, resolvedBy: 'project' }
}

export function resolveDeliveryTarget({ flags, mode = 'steer', ...options }) {
  if (mode === 'steer' && !('thread' in flags) && !('title' in flags)) {
    return { ok: false, reason: 'explicit_target_required', hint: 'Desktop discussion requires --thread from the question framing, or an explicitly requested --title.' }
  }
  if ('thread' in flags && (typeof flags.thread !== 'string' || !flags.thread.trim())) {
    return { ok: false, reason: 'thread_required', hint: '--thread requires a non-empty thread id.' }
  }
  return resolveTarget({ flags, ...options })
}

if (process.argv[1] && import.meta.url === new URL('file:///' + process.argv[1].replace(/\\/g, '/')).href) {
  runReplyCli().then(result => process.stdout.write(JSON.stringify(result) + '\n')).catch(error => {
    process.stderr.write(`magi reply: ${error.message}\n`)
    process.exitCode = 1
  })
}
