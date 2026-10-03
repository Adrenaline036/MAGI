#!/usr/bin/env node
// dsh-collabridge — manual client.
//
// Talks to the in-host plugin through the same discovery file the MCP wrapper uses, so
// this doubles as the diagnostic tool: if the MCP path misbehaves, run `health` here to
// see whether the plugin or the client is at fault.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { dshHome } from './home.mjs'

function discoveryPath() {
  return join(dshHome(), 'collab-bridge.json')
}

function readDiscovery() {
  const file = discoveryPath()
  if (!existsSync(file)) throw new Error(`collaboration bridge is not running: no ${file}`)
  return JSON.parse(readFileSync(file, 'utf8'))
}

async function call(pathname, { method = 'GET', body } = {}) {
  const discovery = readDiscovery()
  const response = await fetch(`http://127.0.0.1:${discovery.port}${pathname}`, {
    method,
    headers: { authorization: `Bearer ${discovery.token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await response.text()
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = { raw: text }
  }
  return { status: response.status, body: parsed }
}

function parseFlags(argv) {
  const flags = {}
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue
    flags[argv[i].slice(2)] = argv[i + 1]
    i += 1
  }
  return flags
}

async function main() {
  const [command, ...rest] = process.argv.slice(2)
  const flags = parseFlags(rest)

  if (command === 'health') {
    return print(await call('/health'))
  }
  if (command === 'sessions') {
    return print(await call('/sessions'))
  }
  if (command === 'routes') {
    return print(await call('/routes'))
  }
  if (command === 'route') {
    return print(await call('/route', { method: 'POST', body: { project: flags.project, node: flags.node, session: flags.session } }))
  }
  if (command === 'node') {
    return print(await call('/node', { method: 'POST', body: { project: flags.project, node: flags.node } }))
  }
  if (command === 'ask') {
    const question = flags['question-file']
      ? readFileSync(flags['question-file'], 'utf8')
      : flags.question
    return print(
      await call('/ask', {
        method: 'POST',
        body: { project: flags.project, question, mode: flags.mode, codex_thread: flags['codex-thread'] },
      }),
    )
  }

  process.stderr.write(
    'usage: collab-cli.mjs <health|sessions|routes|route|node|ask> [--project <path>] [--node <label>] [--session <id>] [--question <text>|--question-file <path>] [--mode followup|steer|inject]\n',
  )
  process.exitCode = 2
}

function print(result) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  if (result.status >= 400) process.exitCode = 1
}

main().catch((error) => {
  process.stderr.write(`collab-cli: ${error?.message ?? error}\n`)
  process.exitCode = 1
})
