import { resolve } from 'node:path'

const READ_TOOLS = new Set(['read', 'grep', 'glob', 'structured_output'])
const SHELL_KEYS = new Set(['command', 'description', 'workdir', 'timeoutMs', 'run_in_background'])
const WORKFLOW_KEYS = new Set(['script', 'args', 'meta'])

/**
 * Whether the fixed workflow's `args` argument carries anything.
 *
 * The generated workflow script ignores `args` entirely, so "nothing" has to be accepted in both
 * spellings a model produces: the object `{}` the conductor task asks for, and the JSON TEXT `"{}"`,
 * which is what two real reviews sent. The old object-only test read the text form as two keys and
 * refused the conductor's only workflow call, so the review died with no verdict at all
 * (REVIEW_RETURN_UNREADABLE), twice in the first 52 runs after the guard shipped. A payload with any
 * content is still refused, in either spelling.
 */
function carriesNoWorkflowArgs(value) {
  if (value === undefined || value === null) return true
  if (typeof value === 'string') return value.trim() === '{}'
  if (typeof value !== 'object' || Array.isArray(value)) return false
  return Object.keys(value).length === 0
}

/** Enforce the fixed review's execution scope before a tool body is dispatched. */
export function createReviewExecutionGuard(policy) {
  const root = resolve(policy.candidateRoot)
  const command = policy.testCommand || null
  const script = policy.workflowScript
  const timeout = policy.testTimeoutMs
  if (typeof script !== 'string' || !script.trim() || !Number.isFinite(timeout) || timeout <= 0) {
    throw new TypeError('Invalid review execution policy')
  }
  let workflowStarted = false
  let testStarted = false
  return (exec) => {
    if (READ_TOOLS.has(exec.name)) return
    const args = exec.arguments
    const deny = 'REVIEW_EXECUTION_SCOPE: only file reads, the fixed workflow and the declared synchronous test command are permitted'
    if (!args || typeof args !== 'object' || Array.isArray(args)) return deny
    if (exec.name === 'workflow') {
      if (workflowStarted || typeof args.script !== 'string' || args.script.trim() !== script.trim() ||
          !carriesNoWorkflowArgs(args.args) ||
          Object.keys(args).some((key) => !WORKFLOW_KEYS.has(key))) return deny
      workflowStarted = true
      return
    }
    // `timeoutMs` is deliberately NOT a denial ground. It is a request, not a scope: the run's own
    // deadline kills the child whatever it asks for, and `policy.testTimeoutMs` only records the
    // declared test budget. Refusing a reviewer that asked for the budget it was actually given
    // (observed: 240000 ms against a 180000 ms policy) cost it its single admitted run and bought
    // nothing. Malformed values are still refused, because those cannot be executed.
    if (exec.name !== 'pwsh' || !command || testStarted || args.command !== command ||
        Object.keys(args).some((key) => !SHELL_KEYS.has(key)) ||
        (args.run_in_background !== undefined && args.run_in_background !== false) ||
        (args.workdir !== undefined && (typeof args.workdir !== 'string' || resolve(args.workdir) !== root)) ||
        (args.timeoutMs !== undefined && (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0))) return deny
    testStarted = true
  }
}

/** Generated per-review plugin; the policy is captured outside the model's workflow. */
export function guardPluginSource(policy, moduleUrl = import.meta.url) {
  return `import { createReviewExecutionGuard } from ${JSON.stringify(moduleUrl)};\n` +
    `export const inject = ['tools'];\n` +
    `export function apply(ctx) { ctx.tools.guard(createReviewExecutionGuard(${JSON.stringify(policy)})); }\n`
}
