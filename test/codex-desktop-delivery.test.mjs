import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import { callerThread, deliveryMode, sendDesktopMessage } from '../lib/codex-desktop-delivery.mjs'
import { markAnswer, parseFlags, resolveDeliveryTarget } from '../tools/transport/push-to-codex.mjs'

const thread = '00000000-0000-0000-0000-000000000024'
const target = { thread, pipe: 'test-pipe', server: 'test-server.mjs' }

function harness(onRequest) {
  const requests = [], calls = []
  const child = new EventEmitter()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.kill = () => { child.killed = true }
  const reply = value => child.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n')
  child.stdin = new Writable({ write(chunk, encoding, done) {
    const request = JSON.parse(chunk.toString())
    requests.push(request)
    queueMicrotask(() => onRequest(request, reply, child))
    done()
  } })
  const spawnImpl = (...args) => { calls.push(args); return child }
  return { child, requests, calls, spawnImpl }
}

test('discussion defaults to steer; queueing requires explicit followup', () => {
  assert.equal(deliveryMode(parseFlags([]).mode), 'steer')
  assert.equal(deliveryMode(parseFlags(['--mode', 'followup']).mode), 'followup')
  for (const mode of ['', true, 'inject', 'queue']) assert.throws(() => deliveryMode(mode))
})

test('caller metadata takes priority over process thread and supports JSON text', () => {
  const env = { CODEX_THREAD_ID: '00000000-0000-0000-0000-000000000001' }
  for (const value of [{ thread_id: thread }, JSON.stringify({ thread_id: thread })]) {
    assert.equal(callerThread({ 'x-codex-turn-metadata': value }, env), thread)
  }
  assert.equal(callerThread(null, env), env.CODEX_THREAD_ID)
  assert.equal(callerThread({ 'x-codex-turn-metadata': '{bad' }, {}), null)
  assert.equal(callerThread({ thread_id: 'not-a-thread' }, env), null)
})

test('desktop discussion refuses project-only guessing and keeps the explicit source thread', () => {
  assert.equal(resolveDeliveryTarget({ flags: { project: 'shared-workspace' } }).reason, 'explicit_target_required')
  assert.equal(resolveDeliveryTarget({ flags: { thread: '', project: 'shared-workspace' } }).reason, 'thread_required')
  const result = resolveDeliveryTarget({ flags: { thread, project: 'shared-workspace' } })
  assert.equal(result.ok, true)
  assert.equal(result.thread.id, thread)
  assert.equal(result.resolvedBy, 'explicit')
})

test('desktop MCP sends one original DSH message to the exact source thread', async () => {
  const message = markAnswer({ answer: '回复原文：中文、引号 " 与换行\n正文。', questionId: 'test-q' })
  const h = harness((r, reply) => {
    if (r.method === 'initialize') reply({ id: 1, result: { protocolVersion: '2024-11-05' } })
    if (r.method === 'tools/call') reply({ id: 2, result: { content: [{ type: 'text', text: JSON.stringify({ threadId: thread }) }] } })
  })
  const result = await sendDesktopMessage({ thread, message, target, spawnImpl: h.spawnImpl })
  assert.equal(result.delivery, 'accepted')
  assert.equal(result.transport, 'codex-app-tools')
  assert.equal(h.calls.length, 1)
  assert.deepEqual(h.calls[0][1], [target.server])
  assert.equal(h.calls[0][2].env.CODEX_APP_TOOLS_PIPE_PATH, target.pipe)
  assert.equal(h.calls[0][2].shell, undefined)
  assert.deepEqual(h.requests.map(r => r.method), ['initialize', 'notifications/initialized', 'tools/call'])
  const send = h.requests[2]
  assert.equal(send.params.name, 'send_message_to_thread')
  assert.deepEqual(send.params.arguments, { threadId: thread, prompt: message })
  assert.equal(send.params._meta['x-codex-turn-metadata'].thread_id, thread)
  assert.equal(h.child.killed, true)
})

test('split stdout frames and duplicate initialization do not duplicate a send', async () => {
  const h = harness((r, reply, child) => {
    if (r.method === 'initialize') {
      const frame = JSON.stringify({ id: 1, result: {} }) + '\n'
      child.stdout.write(frame.slice(0, 7)); child.stdout.write(frame.slice(7))
      reply({ id: 1, result: {} })
    }
    if (r.method === 'tools/call') reply({ id: 2, result: { content: [] } })
  })
  await sendDesktopMessage({ thread, message: 'test', target, spawnImpl: h.spawnImpl })
  assert.equal(h.requests.filter(r => r.method === 'tools/call').length, 1)
})

for (const failure of ['init-error', 'tool-error', 'isError', 'malformed', 'exit', 'timeout']) {
  test(`desktop ${failure} never retries or falls back to a queue`, async () => {
    const h = harness((r, reply, child) => {
      if (r.method === 'initialize') {
        if (failure === 'init-error') return reply({ id: 1, error: { code: -1 } })
        reply({ id: 1, result: {} })
      }
      if (r.method !== 'tools/call') return
      if (failure === 'tool-error') reply({ id: 2, error: { code: -1 } })
      if (failure === 'isError') reply({ id: 2, result: { isError: true, content: [] } })
      if (failure === 'malformed') child.stdout.write('invalid-json\n')
      if (failure === 'exit') child.emit('exit', 1)
    })
    await assert.rejects(sendDesktopMessage({ thread, message: 'test', target, timeoutMs: 30, spawnImpl: h.spawnImpl }), error => {
      assert.match(error.message, /Nothing was queued/)
      if (failure === 'init-error') assert.match(error.message, /No message submitted/)
      else {
        assert.match(error.message, /Delivery outcome may be unknown; inspect the target before retrying/)
        assert.doesNotMatch(error.message, /No message submitted/)
      }
      return true
    })
    assert.equal(h.calls.length, 1)
    assert.equal(h.requests.filter(r => r.method === 'tools/call').length, failure === 'init-error' ? 0 : 1)
    assert.equal(h.child.killed, true)
  })
}

test('invalid destination or message fails before spawning', () => {
  let calls = 0
  const spawnImpl = () => { calls++; throw new Error('must not spawn') }
  for (const patch of [{ thread: 'other' }, { message: '' }, { timeoutMs: NaN }, { timeoutMs: 0 }]) {
    assert.throws(() => sendDesktopMessage({ thread, message: 'test', target, spawnImpl, ...patch }))
  }
  assert.equal(calls, 0)
})
