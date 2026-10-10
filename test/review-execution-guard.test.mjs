import assert from 'node:assert/strict'
import { createReviewExecutionGuard, guardPluginSource } from '../lib/review-execution-guard.mjs'
import { buildReviewerPrompt } from '../lib/review-bridge.mjs'

const policy = { candidateRoot: process.cwd(), testCommand: 'node --version', workflowScript: 'return 1;', testTimeoutMs: 10000 }
const call = (name, args, p = policy) => createReviewExecutionGuard(p)({ name, arguments: args })
let checked = 0
function check(name, body) { body(); checked++; console.log(`PASS ${name}`) }
check('declared test and fixed root permitted', () => assert.equal(call('pwsh', { command: policy.testCommand, workdir: process.cwd(), timeoutMs: 5000 }), undefined))
check('mtime-independent reads and verdict permitted', () => { for (const name of ['read', 'grep', 'glob', 'structured_output']) assert.equal(call(name, {}), undefined) })
check('compileall and full regression refused before dispatch', () => { for (const command of ['python -m compileall -q src tests', 'python -m unittest discover -s tests -q']) assert.match(call('pwsh', { command }), /REVIEW_EXECUTION_SCOPE/) })
check('command suffix prefix and whitespace variants refused', () => { for (const command of [policy.testCommand+'; echo extra', 'echo extra; '+policy.testCommand, policy.testCommand+'\n', '& '+policy.testCommand]) assert.ok(call('pwsh', { command })) })
check('background and alternate root refused', () => { for (const extra of [{ run_in_background: true }, { workdir: '..' }, { env: {} }]) assert.ok(call('pwsh', { command: policy.testCommand, ...extra })) })
// A requested timeout is not a scope. The run deadline kills the child whatever it asks for, so a
// reviewer that budgets the wall clock it was actually given must still get its one admitted run;
// only values that cannot be executed are refused.
check('a timeout above the declared test budget is still permitted', () => { assert.equal(call('pwsh', { command: policy.testCommand, timeoutMs: policy.testTimeoutMs * 4 }), undefined) })
check('a malformed timeout is refused', () => { for (const timeoutMs of [0, -1, NaN, Infinity, 'soon']) assert.ok(call('pwsh', { command: policy.testCommand, timeoutMs })) })
check('alternative execution tools refused', () => { for (const name of ['run_code', 'bash', 'exec', 'job_output', 'write', 'edit', 'ask_user_question']) assert.ok(call(name, { command: policy.testCommand })) })
check('one admitted test per review', () => { const guard = createReviewExecutionGuard(policy); const exec = {name:'pwsh',arguments:{command:policy.testCommand}}; assert.equal(guard(exec),undefined); assert.ok(guard(exec)) })
check('denied command does not consume allowed test', () => { const guard=createReviewExecutionGuard(policy); assert.ok(guard({name:'pwsh',arguments:{command:'wrong'}})); assert.equal(guard({name:'pwsh',arguments:{command:policy.testCommand}}),undefined) })
check('no declared command permits no shell', () => assert.ok(call('pwsh', { command: policy.testCommand }, {...policy,testCommand:null})))
check('fixed workflow permits harmless edge whitespace only', () => { assert.equal(call('workflow',{script:'\nreturn 1;\n',args:{},meta:{name:'review'}}),undefined); assert.ok(call('workflow',{script:'return 2;',args:{}})); assert.ok(call('workflow',{script:policy.workflowScript,args:{x:1}})) })
// Two real reviews died here: the conductor sent `args` as the JSON text "{}" instead of an object,
// and the object-only test read that as two keys, refused the conductor's only workflow call, and
// left the run with no verdict. The generated script ignores `args`, so both spellings of "nothing"
// have to be admitted while anything with content stays refused.
check('an empty workflow args is admitted in both spellings', () => {
  assert.equal(call('workflow', { script: policy.workflowScript, args: {}, meta: {} }), undefined)
  assert.equal(call('workflow', { script: policy.workflowScript, args: '{}', meta: {} }), undefined)
  assert.equal(call('workflow', { script: policy.workflowScript, args: ' {} ', meta: {} }), undefined)
  assert.equal(call('workflow', { script: policy.workflowScript, meta: {} }), undefined)
})
check('workflow args with content is refused in both spellings', () => {
  assert.ok(call('workflow', { script: policy.workflowScript, args: '{"x":1}', meta: {} }))
  assert.ok(call('workflow', { script: policy.workflowScript, args: '[]', meta: {} }))
  assert.ok(call('workflow', { script: policy.workflowScript, args: 'null', meta: {} }))
})
check('workflow cannot recursively delegate again', () => { const guard=createReviewExecutionGuard(policy); const exec={name:'workflow',arguments:{script:policy.workflowScript,args:{}}};assert.equal(guard(exec),undefined);assert.ok(guard(exec)) })
check('policy command captured by value', () => { const p={...policy};const guard=createReviewExecutionGuard(p);p.testCommand='other';assert.ok(guard({name:'pwsh',arguments:{command:'other'}})) })
check('plugin source uses runtime guard API', () => { const source=guardPluginSource(policy);assert.match(source,/ctx\.tools\.guard/);assert.match(source,/export const inject/);assert.ok(source.includes(JSON.stringify(policy))) })
check('prompt states enforced command scope', () => { const text=buildReviewerPrompt({stage:'GREEN',obligations:[{id:'A',clause:'test'}],evidence:'fixture',test_command:policy.testCommand},'nonce');assert.match(text,/EXECUTION SCOPE IS ENFORCED/);assert.ok(text.includes(policy.testCommand));assert.doesNotMatch(text,/You may execute read-only probes of your own/) })
console.log(`${checked} checks passed; no files written or deleted`)
