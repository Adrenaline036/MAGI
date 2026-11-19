import assert from 'node:assert/strict'
import { accountAuthenticationOverlay, modelOverlay } from '../lib/review-bridge.mjs'

// 账户路线必须恢复整个认证依赖链；其他路线保持 headless 原有隔离。
const account = { provider: 'deepseek-account', model: 'deepseek-flash' }
const overlay = accountAuthenticationOverlay(account)
const rows = [...overlay.matchAll(/^- id: (\S+)\n  disabled: (\S+)$/gm)]
assert.deepEqual(rows.map((m) => [m[1], m[2]]), [
  ['credentials', 'false'], ['authorization', 'false'], ['deepseek-account', 'false'],
])
assert.equal(rows.map((m) => m[0] + '\n').join(''), overlay)
for (const route of [null, undefined, { provider: 'deepseek-official' }, { provider: 'other' }]) {
  assert.equal(accountAuthenticationOverlay(route), '')
}
assert.match(modelOverlay(account), /provider: deepseek-account\n    model: deepseek-flash/)
console.log('PASS: 账户认证依赖完整启用；其他路线无覆盖；保留模型选择')
