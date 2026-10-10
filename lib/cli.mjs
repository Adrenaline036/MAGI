#!/usr/bin/env node
// dsh-collabridge — manual client.
//
// Talks to the in-host plugin through the same discovery file the MCP wrapper uses, so
// this doubles as the diagnostic tool: if the MCP path misbehaves, run `health` here to
// see whether the plugin or the client is at fault.
//
// Two commands exist for the parallel-conversation case, so a conversation never has to be named by
// its UUID:
//   label --as <name>   register the conversation this shell belongs to (DSH_SESSION_ID) under a name
//   sessions            list the conversations of a workspace with the title each one shows

import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
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
    const name = argv[i].slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) {
      flags[name] = true
      continue
    }
    flags[name] = next
    i += 1
  }
  return flags
}

function print(result) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  if (result.status >= 400) process.exitCode = 1
}

// The conversation this shell belongs to. DSH exports it into every process a session starts, so a
// conversation can name itself without anybody looking an id up.
function ownSessionId() {
  const id = process.env.DSH_SESSION_ID
  if (typeof id !== 'string' || id.trim().length === 0) {
    throw new Error('DSH_SESSION_ID is not set here; run this from inside the DSH conversation you want to name, or pass --session <id>')
  }
  return id.trim()
}

function formatSessions(body) {
  const sessions = Array.isArray(body.sessions) ? body.sessions : []
  if (sessions.length === 0) return `no conversation of ${body.project ?? '(this project)'} has a session on disk yet`
  const lines = [`${body.project ?? ''}  (${sessions.length} conversations, newest first)`.trim()]
  for (const entry of sessions) {
    const when = entry.last_activity ? entry.last_activity.replace('T', ' ').slice(0, 16) : '—'
    lines.push('')
    lines.push(`${entry.live ? '*' : ' '} ${when}  ${entry.live ? 'live  ' : 'closed'}  id ${entry.id}`)
    lines.push(`    标题: ${entry.title ?? '(not titled yet)'}`)
    if (entry.last_user_line) lines.push(`    最近: ${entry.last_user_line.length > 88 ? `${entry.last_user_line.slice(0, 88)}…` : entry.last_user_line}`)
  }
  lines.push('')
  lines.push('把问题交给其中一条：ask_dsh(project, title: "<标题>")')
  return lines.join('\n')
}

async function main() {
  const [command, ...rest] = process.argv.slice(2)
  const flags = parseFlags(rest)

  if (command === 'health') {
    return print(await call('/health'))
  }
  if (command === 'sessions') {
    const project = typeof flags.project === 'string' ? flags.project : process.cwd()
    const result = await call(`/sessions?project=${encodeURIComponent(project)}`)
    if (flags.json || result.status >= 400) return print(result)
    process.stdout.write(`${formatSessions(result.body)}\n`)
    return
  }
  if (command === 'routes') {
    return print(await call('/routes'))
  }
  if (command === 'route') {
    return print(await call('/route', {
      method: 'POST',
      body: {
        project: flags.project,
        node: flags.node,
        session: flags.session,
        ...(flags.current === false ? { current: false } : {}),
      },
    }))
  }
  if (command === 'node') {
    return print(await call('/node', { method: 'POST', body: { project: flags.project, node: flags.node } }))
  }
  if (command === 'label') {
    const label = typeof flags.as === 'string' ? flags.as.trim() : ''
    if (label.length === 0) throw new Error('label requires --as <name>')
    const project = typeof flags.project === 'string' ? flags.project : process.cwd()
    const session = typeof flags.session === 'string' ? flags.session : ownSessionId()
    const registered = await call('/route', {
      method: 'POST',
      body: { project, node: label, session, current: flags.current === true },
    })
    if (registered.status >= 400) return print(registered)
    process.stdout.write(
      [
        `已登记：标签「${label}」-> 会话 ${session}`,
        `工作区：${resolve(project)}`,
        flags.current === true
          ? '这个标签同时成为该项目的当前节点。'
          : '当前节点未改动（要一并切换就加 --current）。',
        `以后这样指定它：ask_dsh(project, node: "${label}")`,
      ].join('\n') + '\n',
    )
    return
  }
  if (command === 'ask') {
    const question = flags['question-file']
      ? readFileSync(flags['question-file'], 'utf8')
      : flags.question
    return print(
      await call('/ask', {
        method: 'POST',
        body: {
          project: flags.project,
          question,
          mode: flags.mode,
          title: flags.title,
          node: flags.node,
          session: flags.session,
          codex_thread: flags['codex-thread'],
        },
      }),
    )
  }

  process.stderr.write(
    'usage: collab-cli.mjs <health|sessions|routes|route|node|label|ask> [--project <path>] [--node <label>] [--session <id>] [--title <title>] [--as <name>] [--current] [--json] [--question <text>|--question-file <path>] [--mode steer|followup|inject]   (default steer: enters the running turn)\n',
  )
  process.exitCode = 2
}

main().catch((error) => {
  process.stderr.write(`collab-cli: ${error?.message ?? error}\n`)
  process.exitCode = 1
})
