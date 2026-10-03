// Project/node -> collaboration session routing.
//
// The registry is STATE, not per-call input. A project points at a current node, and a
// node points at a session. Crossing a milestone therefore means updating one field, and
// every later question from that project follows automatically.
//
// Resolution order for a project:
//   1. routes[project.node]                            explicit route for the current node
//   2. routes.default                                  explicit fallback for the project
//   3. newest session for the project's workspace slug  inferred, zero configuration
//   4. unresolved                                      reported, never guessed

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

// Resolved in one place for every entry point; dsh 0.2.0-rc.2 no longer exports DSH_HOME into
// the plugin process, so the environment alone is not enough. See ./home.mjs.
import { dshHome } from './home.mjs'

export { dshHome }

export function routingPath() {
  return process.env.DSH_COLLAB_ROUTING ?? join(dshHome(), 'collab-routing.json')
}

// A session directory is named after the workspace path with separators replaced.
export function workspaceSlug(projectPath) {
  return `--${projectPath.replace(/:/g, '').replace(/[\\/]/g, '-')}--`
}

export function normaliseProject(projectPath) {
  return String(projectPath).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

export function loadRegistry(file = routingPath()) {
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
    .map((name) => ({ id: name, mtimeMs: statSync(join(root, name)).mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
}

export function resolveCollabSession({ project, registry = loadRegistry() }) {
  const key = normaliseProject(project)
  const entry = registry.projects[key]
  const candidates = sessionsForProject(project)
  const node = entry?.node ?? null

  if (entry) {
    const routes = entry.routes ?? {}
    if (node && routes[node]) {
      return { project: key, node, session_id: routes[node], resolved_by: `routes[${node}]`, configured: true }
    }
    if (routes.default) {
      return { project: key, node, session_id: routes.default, resolved_by: 'routes.default', configured: true }
    }
  }

  if (candidates.length > 0) {
    return {
      project: key,
      node,
      session_id: candidates[0].id,
      resolved_by: 'newest-session-for-workspace',
      configured: false,
      candidate_count: candidates.length,
    }
  }

  return { project: key, node, session_id: null, resolved_by: 'unresolved', configured: false }
}

// Point a node at a session. This is the whole "switch after a milestone" operation.
export function setRoute({ project, node, sessionId, file = routingPath() }) {
  const registry = loadRegistry(file)
  const key = normaliseProject(project)
  const entry = registry.projects[key] ?? { node: null, routes: {} }
  entry.routes = entry.routes ?? {}
  const label = node ?? 'default'
  entry.routes[label] = sessionId
  if (node) entry.node = node
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
