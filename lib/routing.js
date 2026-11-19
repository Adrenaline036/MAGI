// Project/node -> collaboration session routing.
//
// The registry is STATE, not per-call input. A project points at a current node, and a
// node points at a session. Crossing a milestone therefore means updating one field, and
// every later question from that project follows automatically.
//
// Resolution order for a project:
//   1. an explicit session id, or its unique prefix   (the caller names one conversation)
//   2. an explicit node label                         (the caller names one route)
//   3. an explicit title                              (the caller names the conversation the
//                                                      way the user sees it in the window)
//   4. routes[project.node]                            explicit route for the current node
//   5. routes.default                                  explicit fallback for the project
//   6. newest session for the project's workspace slug  inferred, zero configuration
//   7. unresolved                                      reported, never guessed
//
// A caller that names something gets what it named or an explicit refusal: falling back to the
// newest session after a failed title or label match would deliver a question into the wrong
// conversation, which is the failure this selection exists to prevent.

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

// Resolved in one place for every entry point; dsh 0.2.0-rc.2 no longer exports DSH_HOME into
// the plugin process, so the environment alone is not enough. See ./home.mjs.
import { dshHome } from './home.mjs'
import { sessionActivityMs, sessionSummary } from './session-log.mjs'

export { dshHome }

export function routingPath() {
  return process.env.MAGI_ROUTING ?? join(dshHome(), 'magi-routing.json')
}

// A session directory is named after the workspace path with separators replaced.
export function workspaceSlug(projectPath) {
  return `--${projectPath.replace(/:/g, '').replace(/[\\/]/g, '-')}--`
}

export function normaliseProject(projectPath) {
  return String(projectPath).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

export function loadRegistry(file = routingPath()) {
  if (!process.env.MAGI_ROUTING && file === routingPath() && !existsSync(file)) {
    file = join(dshHome(), 'collab-routing.json')
  }
  if (!existsSync(file)) return { version: 1, projects: {} }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return { version: parsed.version ?? 1, projects: parsed.projects ?? {} }
  } catch {
    // A corrupt registry must not take the bridge down; treat it as empty and let the
    // caller see that no route is configured.
    return { version: 1, projects: {}, corrupt: true }
  }
}

export function saveRegistry(registry, file = routingPath()) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(registry, null, 2)}\n`, 'utf8')
}

// Root sessions for a project's workspace, newest first. A delegated child agent is
// named by a bare childId and is never a collaboration target.
//
// Recency is the newest entry INSIDE the session directory. The directory's own mtime only moves when
// entries are added or removed, so a conversation running for days kept reporting its creation
// moment, and "the newest session for this workspace" could pick a stale one.
export function sessionsForProject(projectPath, home = dshHome()) {
  const root = join(home, 'sessions', workspaceSlug(projectPath))
  let names
  try {
    names = readdirSync(root)
  } catch {
    return []
  }
  return names
    .filter((name) => name.startsWith('session-'))
    .map((name) => ({ id: name, dir: join(root, name), mtimeMs: sessionActivityMs(join(root, name)) }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
}

// Titles are compared with surrounding and repeated whitespace collapsed, case-insensitively, because
// a title is typed or spoken rather than copied.
export function normaliseTitle(title) {
  return String(title ?? '').replace(/\s+/g, ' ').trim().toLowerCase()
}

// One line per conversation, for a refusal that has to let the caller choose.
function describe(candidate) {
  const summary = sessionSummary(candidate.dir)
  return {
    session_id: candidate.id,
    title: summary.title,
    last_activity_ms: candidate.mtimeMs,
    last_user_line: summary.lastUserLine,
  }
}

export function resolveMagiSession({ project, registry = loadRegistry(), node, session, title } = {}) {
  const key = normaliseProject(project)
  const entry = registry.projects[key]
  const candidates = sessionsForProject(project)
  const current = entry?.node ?? null
  const base = { project: key, node: current, configured: false }

  // ---- 1. an explicit session id, or a unique prefix of one
  if (typeof session === 'string' && session.trim()) {
    const wanted = session.trim()
    const exact = candidates.find((candidate) => candidate.id === wanted)
    const prefixed = exact ? [] : candidates.filter((candidate) => candidate.id.startsWith(wanted))
    const hit = exact ?? (prefixed.length === 1 ? prefixed[0] : null)
    if (!hit) {
      return {
        ...base,
        session_id: null,
        resolved_by: prefixed.length > 1 ? 'session-ambiguous' : 'session-unmatched',
        reason: prefixed.length > 1 ? 'session_prefix_ambiguous' : 'session_not_in_workspace',
        requested: { session: wanted },
        sessions: candidates.map(describe),
      }
    }
    return { ...base, session_id: hit.id, resolved_by: 'session', configured: true, requested: { session: wanted } }
  }

  // ---- 2. an explicit node label
  if (typeof node === 'string' && node.trim()) {
    const label = node.trim()
    const routed = entry?.routes?.[label]
    if (!routed) {
      return {
        ...base,
        session_id: null,
        resolved_by: 'node-unrouted',
        reason: 'node_not_routed',
        requested: { node: label },
        labels: Object.keys(entry?.routes ?? {}),
      }
    }
    return { ...base, node: label, session_id: routed, resolved_by: `routes[${label}]`, configured: true, requested: { node: label } }
  }

  // ---- 3. an explicit title
  if (typeof title === 'string' && title.trim()) {
    const wanted = normaliseTitle(title)
    const described = candidates.map((candidate) => ({ candidate, summary: sessionSummary(candidate.dir) }))
    const named = described.filter(({ summary }) => summary.title)
    const exact = named.filter(({ summary }) => normaliseTitle(summary.title) === wanted)
    const partial = exact.length > 0 ? exact : named.filter(({ summary }) => normaliseTitle(summary.title).includes(wanted))
    const match = partial.length === 1 ? partial[0] : null
    if (!match) {
      return {
        ...base,
        session_id: null,
        resolved_by: partial.length > 1 ? 'title-ambiguous' : 'title-unmatched',
        reason: partial.length > 1 ? 'title_matches_several' : 'title_not_found',
        requested: { title: title.trim() },
        matches: partial.map(({ candidate, summary }) => ({
          session_id: candidate.id,
          title: summary.title,
          last_activity_ms: candidate.mtimeMs,
        })),
        sessions: described.map(({ candidate, summary }) => ({
          session_id: candidate.id,
          title: summary.title,
          last_activity_ms: candidate.mtimeMs,
          last_user_line: summary.lastUserLine,
        })),
      }
    }
    return {
      ...base,
      session_id: match.candidate.id,
      resolved_by: 'title',
      configured: true,
      requested: { title: title.trim() },
      matched_title: match.summary.title,
      matched_exactly: exact.length === 1,
    }
  }

  // ---- 4..6. the registry, then the inferred newest session
  if (entry) {
    const routes = entry.routes ?? {}
    if (current && routes[current]) {
      return { ...base, node: current, session_id: routes[current], resolved_by: `routes[${current}]`, configured: true }
    }
    if (routes.default) {
      return { ...base, node: current, session_id: routes.default, resolved_by: 'routes.default', configured: true }
    }
  }

  if (candidates.length > 0) {
    return {
      ...base,
      node: current,
      session_id: candidates[0].id,
      resolved_by: 'newest-session-for-workspace',
      configured: false,
      candidate_count: candidates.length,
    }
  }

  return { ...base, node: current, session_id: null, resolved_by: 'unresolved', configured: false }
}


// Point a node at a session. This is the whole "switch after a milestone" operation.
//
// Registering a label normally also makes it the project's current node, which is what the milestone
// flow wants: one step names the node and moves the project onto it. Labelling a conversation for
// parallel work is the opposite case, so `current: false` registers the name without moving the
// project's default target.
export function setRoute({ project, node, sessionId, current = true, file = routingPath() }) {
  const registry = loadRegistry(file)
  const key = normaliseProject(project)
  const entry = registry.projects[key] ?? { node: null, routes: {} }
  entry.routes = entry.routes ?? {}
  const label = node ?? 'default'
  entry.routes[label] = sessionId
  if (node && current) entry.node = node
  entry.updated_at = new Date().toISOString()
  registry.projects[key] = entry
  saveRegistry(registry, file)
  return entry
}

export function setCurrentNode({ project, node, file = routingPath() }) {
  const registry = loadRegistry(file)
  const key = normaliseProject(project)
  const entry = registry.projects[key]
  if (!entry) throw new Error(`project is not registered: ${key}`)
  if (!entry.routes?.[node]) throw new Error(`no session is routed for node "${node}"`)
  entry.node = node
  entry.updated_at = new Date().toISOString()
  saveRegistry(registry, file)
  return entry
}
