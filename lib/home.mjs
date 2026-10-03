// Where the DSH home is, across host versions.
//
// History: the host used to export DSH_HOME into the plugin process, so reading the variable
// was the whole story. dsh 0.2.0-rc.2 keeps its home internally and only injects DSH_* into
// the tool shells it spawns, so a plugin that hard-requires the variable dies while loading:
//
//   dsh: fatal uncaught exception: Error: DSH_HOME is not set
//       at dshHome (lib/routing.js:18:20)
//
// Resolution order, most explicit first:
//   1. DSH_HOME           configuration wins, used verbatim even when the path does not exist
//                         (the MCP self-test relies on pointing at a home with no bridge)
//   2. DSH_DESKTOP_HOME   the desktop host's own name for the same fact
//   3. DSH_PROFILE_DIR    <home>/profiles/<name>; the home is two levels up
//   4. ~/.dsh             the default home location since 0.2.0-rc.2, when it exists
//   5. throw              naming every location tried, so the next report is diagnosable

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export function dshHome() {
  const explicit = process.env.DSH_HOME || process.env.DSH_DESKTOP_HOME
  if (explicit) return explicit

  const candidates = []
  if (process.env.DSH_PROFILE_DIR) candidates.push(resolve(process.env.DSH_PROFILE_DIR, '..', '..'))
  candidates.push(join(homedir(), '.dsh'))

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }

  throw new Error(
    `DSH_HOME is not set and no dsh home was found (tried: ${candidates.join(', ')}). ` +
      'Set DSH_HOME, or set DSH_PROFILE_DIR to <home>/profiles/<profile>.',
  )
}
