import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parseReplyArgs, replyToCodex, markAnswer } from '../lib/reply.mjs'

const thread = '00000000-0000-4000-8000-000000000041'
const flags = ['--thread', thread, '--message-file', '回复.txt']
test('入口只接受明确线程及一种正文来源', () => {
  assert.equal(parseReplyArgs(flags).thread, thread)
  for (const args of [[], ['--project', 'P', '--message', 'x'], [...flags, '--message', 'x'], [...flags, '--thread', thread], ['--thread', thread, '--message-file'], [...flags, 'extra']]) assert.throws(() => parseReplyArgs(args))
})
for (const mode of ['steer', 'followup', 'inject']) test(`项目不能选择 ${mode}`, () => {
  assert.throws(() => parseReplyArgs([...flags, '--mode', mode]))
  assert.throws(() => parseReplyArgs([...flags, '--mode='+mode]))
})
test('未知参数与登记混用在发送前拒绝', () => {
  assert.throws(() => parseReplyArgs([...flags, '--transport', 'queue']))
  assert.throws(() => parseReplyArgs([...flags, '--register-desktop']))
  assert.equal(parseReplyArgs(['--thread', thread, '--register-desktop'])['register-desktop'], true)
})
test('统一 API 不接收策略，正文原样送往明确线程一次', async () => {
  let calls = 0
  const answer = '中文正文 "引号"\n第二行'
  const send = async request => { calls++; assert.deepEqual(request, { thread, message: markAnswer({ answer }) }); return { code: 0, delivery: 'accepted' } }
  const record = () => 'test-receipt'
  const result = await replyToCodex({ thread, answer }, { send, record })
  assert.equal(result.delivery, 'accepted'); assert.equal(result.transport, 'codex-app-tools'); assert.equal(calls, 1)
  await assert.rejects(replyToCodex({ thread, answer, mode: 'followup' }, { send, record }))
  assert.equal(calls, 1)
})
test('失败与结果未知不重试', async () => {
  let calls = 0
  await assert.rejects(replyToCodex({ thread, answer: 'x' }, { send: async () => { calls++; throw new Error('unknown') } }))
  assert.equal(calls, 1)
  await assert.rejects(replyToCodex({ thread, answer: 'x' }, { send: async () => { calls++; return { code: 1, delivery: 'failed' } } }))
  assert.equal(calls, 2)
})
test('回执失败保持已受理，不制造重发理由', async () => {
  const result = await replyToCodex({ thread, answer: 'x' }, { send: async () => ({ code: 0, delivery: 'accepted' }), record: () => { throw new Error('disk') } })
  assert.equal(result.delivery, 'accepted'); assert.match(result.audit_warning, /不要重复发送/)
})
test('旧入口没有队列实现，只转交统一入口', () => {
  const source = readFileSync(new URL('../tools/transport/push-to-codex.mjs', import.meta.url), 'utf8')
  assert.match(source, /runReplyCli/)
  assert.doesNotMatch(source, /queueMessage|resolveCodexEntry|spawn\(/)
})


test('来源线程缺失或空白时明确停止，正常线程去除外侧空白', async () => {
  const { renderFraming } = await import('../lib/index.js')
  for (const codexThread of [undefined, null, '', '  \t']) {
    assert.match(renderFraming({ codexThread }), /来源线程：缺失，停止回推并报告，不能猜测目标/)
  }
  assert.match(renderFraming({ codexThread: '  '+thread+'  ' }), new RegExp('来源线程：'+thread+'\n'))
})
