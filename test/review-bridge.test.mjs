#!/usr/bin/env node
// Offline tests for the bridge's pure logic. No provider request, no cost.
// Fixtures include shapes and error texts observed in production.

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  REVIEW_SCHEMA,
  buildConductorTask,
  buildReviewerPrompt,
  buildWorkflowScript,
  classifyScriptTransfer,
  classifyStructuralLimits,
  comparePriorVerdicts,
  extractWorkflowReturn,
  hashDirectory,
  modelOverlay,
  priorVerdictsForCandidate,
  resolveDshEntry,
  resolveDshLaunch,
  resolveDshNode,
  resolveReviewModel,
  structuralLimitHistory,
  validatePackage,
  validateReturn,
} from '../lib/review-bridge.mjs'
import { turnFailureFromEvents } from '../lib/session-log.mjs'

let passed = 0
const failures = []

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1
    return
  }
  failures.push(`${name}${detail ? ` -- ${detail}` : ''}`)
}

const pkg = {
  package_id: 'pkg-1',
  stage: 'GREEN',
  objective: 'Assess the candidate against the declared obligations in this test fixture.',
  obligations: [
    { id: 'OB-A', clause: 'Alpha must hold.' },
    { id: 'OB-B', clause: 'Beta must hold.' },
  ],
  known_defects: [],
  expected_failures: [],
  evidence: 'fixture evidence',
  test_command: 'python -m unittest discover -s tests',
}
const NONCE = 'nonce-abc'

const goodFinding = {
  obligation_id: 'OB-A',
  root_cause_key: 'alpha.broken',
  severity: 'P1',
  file: 'a.py',
  line: 3,
  counterexample: 'f(1) returns 2',
  evidence: 'a.py line 3',
  impact: 'alpha does not hold',
  corrective_direction: 'return 1',
}

// ---- workflow result decoding ------------------------------------------------

// The exact success shape observed from the runtime.
const observedSuccess = `workflow "schema-probe" completed (1 agent).
Return value:
{
  "ok": true,
  "n": 7
}`
const decoded = extractWorkflowReturn(observedSuccess)
check('decode: reads the Return value section', decoded.ok === true, decoded.reason)
check('decode: parses the harness-serialised object', decoded.ok && decoded.value.ok === true && decoded.value.n === 7)

// The exact failure text observed when a schema left the supported subset.
const observedFailure = `Error: workflow run failed: WorkflowError: agent() schema is outside the supported subset — unsupported JSON schema: schema.properties.verdict.enum requires type or oneOf`
const failed = extractWorkflowReturn(observedFailure)
check('decode: reports a workflow failure as failed', failed.ok === false && failed.failed === true)
check('decode: keeps the failure reason', failed.failed && failed.reason.includes('outside the supported subset'))

check('decode: rejects a result with no return section', extractWorkflowReturn('workflow "x" completed (0 agents).').ok === false)
check('decode: rejects empty output', extractWorkflowReturn('').ok === false)
check('decode: rejects a non-JSON return value', extractWorkflowReturn('Return value:\nnot json at all').ok === false)
check(
  'decode: does not repair a malformed return',
  extractWorkflowReturn('Return value:\n{verdict:FAIL}').ok === false,
)
check('decode: accepts an empty findings array', extractWorkflowReturn('Return value:\n{"findings":[]}').ok === true)

const serialised = JSON.stringify(REVIEW_SCHEMA)
check('schema: serialises', typeof serialised === 'string' && serialised.length > 100)
check('schema: rejects unknown top-level fields', REVIEW_SCHEMA.additionalProperties === false)
check('schema: every enum carries a type', REVIEW_SCHEMA.properties.verdict.type === 'string')
check(
  'schema: nested enum carries a type',
  REVIEW_SCHEMA.properties.findings.items.properties.severity.type === 'string',
)
check(
  'schema: nested items reject unknown fields',
  REVIEW_SCHEMA.properties.findings.items.additionalProperties === false,
)
check(
  'schema: line admits a null through oneOf',
  Array.isArray(REVIEW_SCHEMA.properties.findings.items.properties.line.oneOf),
)
check('schema: requires findings and unknowns', REVIEW_SCHEMA.required.includes('findings') && REVIEW_SCHEMA.required.includes('unknowns'))
// Required would be self-defeating: an omitted field is a schema violation, and a schema violation
// costs the whole review -- the exact loss this field exists to prevent.
check('schema: declares structural_limits', REVIEW_SCHEMA.properties.structural_limits?.type === 'array')
check('schema: structural_limits is optional', !REVIEW_SCHEMA.required.includes('structural_limits'))
check(
  'schema: structural_limits items reject unknown fields',
  REVIEW_SCHEMA.properties.structural_limits.items.additionalProperties === false,
)
check(
  'schema: structural_limits items require obligation_id and question',
  ['obligation_id', 'question'].every((k) => REVIEW_SCHEMA.properties.structural_limits.items.required.includes(k)),
)

// The runtime rejects `enum` that carries neither `type` nor `oneOf`, so assert the
// property structurally rather than by a text heuristic.
function bareEnumPaths(node, path = 'schema') {
  if (node === null || typeof node !== 'object') return []
  const found = []
  if (Array.isArray(node)) {
    node.forEach((child, index) => found.push(...bareEnumPaths(child, `${path}[${index}]`)))
    return found
  }
  if ('enum' in node && !('type' in node) && !('oneOf' in node)) found.push(path)
  for (const [key, child] of Object.entries(node)) {
    if (key === 'enum') continue
    found.push(...bareEnumPaths(child, `${path}.${key}`))
  }
  return found
}
const bareEnums = bareEnumPaths(REVIEW_SCHEMA)
check('schema: no enum lacks type or oneOf', bareEnums.length === 0, bareEnums.join(', '))

// ---- prompt and script construction -----------------------------------------

const prompt = buildReviewerPrompt(pkg, NONCE)
check('prompt: carries the obligation ids', prompt.includes('OB-A') && prompt.includes('OB-B'))
check('prompt: carries the nonce', prompt.includes(NONCE))
check('prompt: carries the package id', prompt.includes('pkg-1'))
check('prompt: carries the stage rule', prompt.includes('Stage GREEN'))
check('prompt: asks for no serialisation format', !/single-line JSON/i.test(prompt))
// The contradiction that produced the 2272-character summary: the prompt told the reviewer to file
// sandbox limits as unknowns, while the verdict rule made any unknown force a non-PASS verdict.
check('prompt: routes sandbox limits to structural_limits', /record it ONCE in structural_limits/.test(prompt))
check('prompt: says structural_limits does not move the verdict', /structural_limits does NOT affect the verdict/.test(prompt))
check('prompt: warns against filing sandbox limits as unknowns', /Do NOT put it in unknowns/.test(prompt))
check('prompt: keeps the STRUCTURAL SANDBOX LIMIT label', prompt.includes('STRUCTURAL SANDBOX LIMIT:'))
check('prompt: covers structural_limits in the obligation_id rule', /every structural_limit must carry an obligation_id/.test(prompt))
check('prompt: states over-length is a warning, not a rejection', /recorded as a warning, not rejected/.test(prompt))
check('prompt: says a structural limit does not hold the gate', /does not hold the gate/.test(prompt))
check('prompt: routes a genuinely outstanding verification to unknowns', /If you genuinely believe a verification is still outstanding/.test(prompt))
// The reviewer can run the declared command read-only; saying otherwise was a false structural
// limit that then deadlocked a gate. The invocation and the narrow real limitation must both be
// stated. Execution scope itself moved from promise to enforcement: a tool-dispatch guard admits
// exactly one declared command, so the prompt states the enforced scope, names that single command,
// and routes anything else to an unknown or a structural_limit. It no longer offers the reviewer a
// pytest run of its own, which the guard would refuse.
check('prompt: gives the working pytest invocation', /-q -s -p no:cacheprovider/.test(prompt))
check('prompt: states the enforced execution scope', /EXECUTION SCOPE IS ENFORCED/.test(prompt))
check('prompt: names the one admitted shell command', /The ONLY shell command admitted/.test(prompt))
check('prompt: sends extra execution to an unknown or a structural limit', /Additional verification must be requested as a precise unknown or structural_limit/.test(prompt))
check('prompt: no longer promises the reviewer its own pytest run', !/YOU CAN STILL RUN PYTEST/.test(prompt))
check('prompt: names the narrow real limitation', /tmp_path, tmpdir, tempfile\.TemporaryDirectory\(\)/.test(prompt))
// A review disproved the earlier claim that capture was the ONLY blocker: projects that write at
// import time (log handlers, lock files, mkdir) cannot be collected at all, and no flag fixes that.
check('prompt: names the import-time write blocker', /write at IMPORT time/.test(prompt))
check('prompt: requires naming which blocker class applies', /you must say which you hit/.test(prompt))
check('prompt: forbids the blanket "cannot run the tests" claim', /Never report "I cannot run the tests"/.test(prompt))
check('prompt: forbids ask_user_question', /NEVER call ask_user_question/.test(prompt))
// A review burned its whole 420 s budget in a 210 s self-written polling loop, so waiting is now
// named as a defect rather than left to judgement.
check('prompt: forbids polling and waiting', /NEVER WAIT FOR ANYTHING/.test(prompt))
check('prompt: forbids waiting on someone else\'s run', /NOT your evidence/.test(prompt))
check('prompt: bounds suite attempts to one', /AT MOST ONE ATTEMPT AT RUNNING THE SUITE/.test(prompt))
check('prompt: forbids retrying a known limitation', /Do NOT retry with another flag combination/.test(prompt))
// A review grepped a 646 KB development diary and the next request was rejected by the provider
// with HTTP 400; staying in scope is both cheaper and safer.
check('prompt: keeps the reviewer inside the declared scope', /STAY INSIDE THE DECLARED SCOPE/.test(prompt))
check('prompt: names the documents not to trawl', /development diaries, review logs, session histories, error ledgers/.test(prompt))

// The reviewer works to a deadline it cannot otherwise see, and a killed run loses everything.
const budgetPrompt = buildReviewerPrompt(pkg, NONCE, { budgetSeconds: 420 })
check('prompt: states the time budget when given one', /roughly 420 seconds/.test(budgetPrompt))
check('prompt: reserves time for the verdict', /finish investigating by about 252 seconds/.test(budgetPrompt))
check('prompt: says a killed run loses everything', /no partial credit/.test(budgetPrompt))
check('prompt: omits the budget block when none is supplied', !/YOUR TIME BUDGET/.test(prompt))

const promptPath = 'C:\\evidence\\reviewer-prompt.txt'
const script = buildWorkflowScript(promptPath)
let passedSchema, actualInstruction
const sample = {verdict:'PASS'}
const runWorkflow = new Function('agent', 'return (async () => {' + script + '})()')
const actualReview = await runWorkflow((instruction, options) => {
  passedSchema = options.schema
  actualInstruction = instruction
  return sample
})
check('script: 调用审查者并返回结构化结果', actualReview === sample && !!passedSchema)
check('script: returns the validated object', script.trim().endsWith('return review;'))
check('script: embeds the whole schema', isDeepStrictEqual(passedSchema, REVIEW_SCHEMA))
check('script: points the reviewer at the prompt file', script.includes(promptPath.replace(/\\/g, '\\\\')), promptPath)
check('script: tells the reviewer to read that file first', actualInstruction.includes('Read ' + promptPath) && actualInstruction.includes('complete review instructions'))

// Regression for a real failure: the conductor turned a log separator inside the embedded
// evidence into a longer one, and the byte-for-byte guard rejected the whole run as
// REVIEW_CONDUCTOR_ALTERED_SCRIPT. The script must therefore never carry the evidence, or any
// other prose a model might be tempted to tidy.
const evidenceWithSeparator = { ...pkg, evidence: 'header\n==========\nbody with |table| and ### marks\n' }
const scriptWithBigEvidence = buildWorkflowScript(promptPath)
check('script: does not carry the evidence', !scriptWithBigEvidence.includes('=========='))
check('script: does not carry the prompt prose', !scriptWithBigEvidence.includes('These are the ONLY requirements'))
check('script: stays small enough to copy reliably', scriptWithBigEvidence.length < 6000, `length=${scriptWithBigEvidence.length}`)
check(
  'prompt: still carries the evidence it was given',
  buildReviewerPrompt(evidenceWithSeparator, NONCE).includes('=========='),
)

// The script must be syntactically valid JavaScript with top-level await and return.
let scriptParses = true
let parseError = ''
try {
  // eslint-disable-next-line no-new-func
  new Function('agent', `return (async () => {\n${script}\n})()`)
} catch (error) {
  scriptParses = false
  parseError = error.message
}
check('script: is syntactically valid JavaScript', scriptParses, parseError)

// The instruction the reviewer receives must survive a path containing quotes and backslashes.
const nastyPath = 'C:\\a "quoted" dir\\prompt.txt'
let recoveredInstruction = null
try {
  const runScript = new Function('agent', `return (async () => {\n${buildWorkflowScript(nastyPath)}\n})()`)
  await runScript((firstArgument) => {
    recoveredInstruction = firstArgument
    return Promise.resolve({ captured: true })
  })
} catch {
  recoveredInstruction = null
}
check(
  'script: round-trips an instruction containing quotes and backslashes',
  typeof recoveredInstruction === 'string' && recoveredInstruction.includes('C:\\a "quoted" dir\\prompt.txt'),
  String(recoveredInstruction).slice(0, 120),
)

const task = buildConductorTask(script, 'review-pkg-1')
const toolArgs = JSON.parse(task.split('\n').find(line => line.startsWith('{"meta":')))
check('task: 脚本经 JSON 解码后逐字一致', toolArgs.script === script)
check('task: 工作流名称与输入一致', toolArgs.meta.name === 'review-pkg-1')
check('task: 参数是空对象', isDeepStrictEqual(toolArgs.args, {}))
check('task: 指令要求原样传入参数对象', task.includes('tool arguments object') && task.includes('without reconstructing'))
check('task: 每份只调用一次 workflow', task.includes('workflow tool once'))

// ---- validateReturn: accepted shapes ----------------------------------------

const passReturn = { package_id: 'pkg-1', nonce: NONCE, verdict: 'PASS', findings: [], unknowns: [], summary: 'ok' }
const passResult = validateReturn(pkg, NONCE, passReturn)
check('accept: clean PASS', passResult.valid === true, passResult.problems.join('; '))

const failReturn = { package_id: 'pkg-1', nonce: NONCE, verdict: 'FAIL', findings: [goodFinding], unknowns: [], summary: 'one defect' }
const failResult = validateReturn(pkg, NONCE, failReturn)
check('accept: FAIL with one bound finding', failResult.valid === true, failResult.problems.join('; '))

const withUnknown = validateReturn(pkg, NONCE, {
  ...failReturn,
  unknowns: [{ obligation_id: 'OB-B', question: 'is beta ambiguous?' }],
})
check('accept: FAIL with a bound unknown', withUnknown.valid === true, withUnknown.problems.join('; '))

// ---- validateReturn: rejected shapes ----------------------------------------

const noNonce = validateReturn(pkg, NONCE, { ...passReturn, nonce: undefined })
check('reject: missing nonce', noNonce.valid === false && noNonce.state === 'REVIEW_STRUCTURAL_INVALID')

const wrongNonce = validateReturn(pkg, NONCE, { ...passReturn, nonce: 'other' })
check('reject: replayed return under a different nonce', wrongNonce.valid === false && wrongNonce.state === 'REVIEW_STRUCTURAL_INVALID')

// The exact extra field a real review returned before the schema was enforced.
const withVerNote = validateReturn(pkg, NONCE, { ...passReturn, verdict_note: 'null' })
check('reject: undeclared top-level field', withVerNote.valid === false && withVerNote.state === 'REVIEW_STRUCTURAL_INVALID', withVerNote.problems.join('; '))

const wrongPackage = validateReturn(pkg, NONCE, { ...passReturn, package_id: 'pkg-2' })
check('reject: package_id mismatch', wrongPackage.valid === false)

const extraFindingField = validateReturn(pkg, NONCE, { ...failReturn, findings: [{ ...goodFinding, confidence: 0.9 }] })
check('reject: undeclared finding field', extraFindingField.valid === false && extraFindingField.state === 'REVIEW_SEMANTIC_INVALID', extraFindingField.problems.join('; '))

const unsupplied = validateReturn(pkg, NONCE, { ...failReturn, findings: [{ ...goodFinding, obligation_id: 'OB-INVENTED' }] })
check('reject: obligations not supplied by the caller', unsupplied.valid === false, unsupplied.problems.join('; '))

// ---- which executable is the application ------------------------------------
// The app is normally named after its directory. When it is not, choosing by readdir order hands the
// CLI to whatever helper happens to sort first (measured with elevate.exe), so the fallback picks by
// evidence: a matching name, else the largest binary. These checks build real temp trees and point
// LOCALAPPDATA at them, because that is how appRoots() looks for an install.
{
  const keys = ['LOCALAPPDATA', 'ProgramFiles', 'ProgramFiles(x86)', 'DSH_CLI_ENTRY', 'DSH_ELECTRON_EXE', 'DSH_NODE_EXE']
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
  const root = mkdtempSync(join(tmpdir(), 'magi-appexe-'))

  const build = (caseName, appDirName, exes) => {
    const local = join(root, caseName, 'LocalAppData')
    const dir = join(local, 'Programs', appDirName)
    mkdirSync(join(dir, 'resources'), { recursive: true })
    writeFileSync(join(dir, 'resources', 'app.asar'), 'archive placeholder', 'utf8')
    for (const [name, bytes] of Object.entries(exes)) writeFileSync(join(dir, name), 'x'.repeat(bytes), 'utf8')
    return { local, dir }
  }

  const resolveWith = (local) => {
    for (const key of keys) delete process.env[key]
    process.env.LOCALAPPDATA = local
    try {
      return resolveDshLaunch()
    } finally {
      for (const key of keys) {
        if (saved[key] === undefined) delete process.env[key]
        else process.env[key] = saved[key]
      }
    }
  }

  try {
    const helperFirst = build('helper', 'DSH Desktop', { 'elevate.exe': 10, 'TheActualApp.exe': 200_000, 'Uninstall DSH Desktop.exe': 10 })
    const picked = resolveWith(helperFirst.local)
    check(
      'exe: a helper that sorts first is not mistaken for the application',
      picked.command === join(helperFirst.dir, 'TheActualApp.exe'),
      picked.command,
    )
    check('exe: the chosen launcher is reported as the Electron mode', picked.mode === 'electron', picked.mode)

    const namedDifferently = build('named', 'DeepSeek Harness', { 'aaa-helper.exe': 10, 'harness runner.exe': 20_000 })
    check(
      'exe: a name matching the app wins over a larger helper',
      resolveWith(namedDifferently.local).command === join(namedDifferently.dir, 'harness runner.exe'),
      resolveWith(namedDifferently.local).command,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
  }
}

// ---- which model route the reviewer may use ---------------------------------
// The shipped headless profile pins the API-key route, which an account installation cannot
// authenticate: the child dies with MISSING_CREDENTIAL before the reviewer starts, and the archive
// says only "the conductor exited with code 1". These checks pin the discrimination, so a machine
// that signs in with an account gets the account route and an API-key machine keeps the default.
{
  const saved = {
    MAGI_REVIEW_PROVIDER: process.env.MAGI_REVIEW_PROVIDER,
    MAGI_REVIEW_MODEL: process.env.MAGI_REVIEW_MODEL,
  }
  delete process.env.MAGI_REVIEW_PROVIDER
  delete process.env.MAGI_REVIEW_MODEL
  const home = mkdtempSync(join(tmpdir(), 'magi-cred-home-'))
  const accountHome = join(home, 'account')
  const apiKeyHome = join(home, 'apikey')
  const emptyHome = join(home, 'empty')
  for (const dir of [accountHome, apiKeyHome, emptyHome]) mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(accountHome, '.credentials.yaml'),
    ['version: 1', 'records:', '  "acct":', '    kind: grant', '    payload:', '      version: 1', '      token: abcdefghijklmnop', '      issuer: https://example.invalid', ''].join('\n'),
  )
  writeFileSync(
    join(apiKeyHome, '.credentials.yaml'),
    ['version: 1', 'records:', '  "k":', '    kind: grant', '    payload:', '      version: 1', '      secret: c2VjcmV0', 'refs:', '  DEEPSEEK_API_KEY: "k"', ''].join('\n'),
  )

  try {
    const account = resolveReviewModel({ home: accountHome })
    check('model: an account grant selects the account route', account?.provider === 'deepseek-account', JSON.stringify(account))
    check('model: the choice records where it came from', /account grant/.test(account?.source ?? ''), String(account?.source))
    check('model: API 凭据引用选择官方 API 路线', resolveReviewModel({ home: apiKeyHome })?.provider === 'deepseek-official')
    check('model: a home with no credential store leaves the shipped default alone', resolveReviewModel({ home: emptyHome }) === null)

    process.env.MAGI_REVIEW_PROVIDER = 'some-other-route'
    const envOnly = resolveReviewModel({ home: accountHome })
    check('model: an explicit provider wins over detection', envOnly?.provider === 'some-other-route' && envOnly?.source === 'environment', JSON.stringify(envOnly))
    check('model: an explicit provider keeps a usable default model', envOnly?.model === 'deepseek-flash', String(envOnly?.model))
    process.env.MAGI_REVIEW_MODEL = 'some-other-model'
    check('model: an explicit model is used as given', resolveReviewModel({ home: accountHome })?.model === 'some-other-model')

    // The route names are interpolated into the patch file, so they must not be able to add entries.
    process.env.MAGI_REVIEW_PROVIDER = 'bad\n- id: injected'
    let injectionError = ''
    try {
      resolveReviewModel({ home: accountHome })
    } catch (error) {
      injectionError = error.message
    }
    check('model: an unsafe provider name is refused instead of patched in', /not a provider route name/.test(injectionError), injectionError)

    const overlay = modelOverlay({ provider: 'deepseek-account', model: 'deepseek-flash' })
    check('model: the overlay patches only the default-model entry', overlay.startsWith('- id: agent-default-model\n') && (overlay.match(/^- id:/gm) ?? []).length === 1, overlay)
    check('model: the overlay carries the chosen route', /provider: deepseek-account/.test(overlay) && /model: deepseek-flash/.test(overlay), overlay)
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(home, { recursive: true, force: true })
  }
}

// ---- the app changed name, then moved inside an archive ----------------------
// Two releases broke this resolver, and each break looked like a broken plugin. `resources/app`
// became `resources/app.asar.unpacked`; then the app was renamed to "DeepSeek Harness" and its whole
// tree moved INSIDE `resources/app.asar`, which is a FILE. Plain node cannot read inside it (it exits
// with MODULE_NOT_FOUND on the path truncated at the first space), so the entry must be started by
// the Electron binary in node mode — the same way the app starts its own runtime. `DSH_NODE_EXE`
// pointing at a real node does NOT fix that. These checks pin entry/interpreter pairing, with
// injected environment so they run on any machine.
{
  const saved = {
    DSH_CLI_ENTRY: process.env.DSH_CLI_ENTRY,
    DSH_NODE_EXE: process.env.DSH_NODE_EXE,
    DSH_ELECTRON_EXE: process.env.DSH_ELECTRON_EXE,
  }
  const fakeDir = mkdtempSync(join(tmpdir(), 'magi-launch-'))
  const fakeNode = join(fakeDir, 'node.exe')
  const fakeExe = join(fakeDir, 'DeepSeek Harness.exe')
  const archiveEntry = join(fakeDir, 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  const plainEntry = join(fakeDir, 'bin.js')
  writeFileSync(fakeNode, 'x')
  writeFileSync(fakeExe, 'x')
  writeFileSync(plainEntry, 'x')

  try {
    process.env.DSH_CLI_ENTRY = archiveEntry
    process.env.DSH_ELECTRON_EXE = fakeExe
    process.env.DSH_NODE_EXE = fakeNode
    const inArchive = resolveDshLaunch()
    check('resolve: an entry inside app.asar is started by the Electron binary', inArchive.command === fakeExe, inArchive.command)
    check('resolve: a plain node is never the interpreter for an archive entry', inArchive.command !== fakeNode)
    check('resolve: an archive entry gets ELECTRON_RUN_AS_NODE=1', inArchive.env.ELECTRON_RUN_AS_NODE === '1', String(inArchive.env.ELECTRON_RUN_AS_NODE))
    check(
      'resolve: an archive entry is passed through --expose-internals',
      inArchive.args[0] === '--expose-internals' && inArchive.args[1] === archiveEntry,
      JSON.stringify(inArchive.args),
    )
    check('resolve: the launch mode is reported for diagnostics', inArchive.mode === 'electron', inArchive.mode)

    // With no interpreter for the archive, the message must name the variable to set: the raw
    // symptom is a MODULE_NOT_FOUND on a truncated path, which sends a reader after the wrong thing.
    const soloDir = mkdtempSync(join(tmpdir(), 'magi-noexe-'))
    delete process.env.DSH_ELECTRON_EXE
    process.env.DSH_CLI_ENTRY = join(soloDir, 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    let archiveError = ''
    try {
      resolveDshLaunch()
    } catch (error) {
      archiveError = error.message
    }
    check('resolve: an archive entry with no interpreter explains the fix', /DSH_ELECTRON_EXE/.test(archiveError), archiveError)
    rmSync(soloDir, { recursive: true, force: true })

    // The unpacked case is unchanged: a real file, run by node, with no Electron environment.
    process.env.DSH_CLI_ENTRY = plainEntry
    process.env.DSH_NODE_EXE = fakeNode
    const unpacked = resolveDshLaunch()
    check('resolve: an unpacked entry still runs under node', unpacked.mode === 'node' && unpacked.command === fakeNode, `${unpacked.mode} ${unpacked.command}`)
    check('resolve: an unpacked entry is passed as a bare script argument', unpacked.args.length === 1 && unpacked.args[0] === plainEntry, JSON.stringify(unpacked.args))
    // Identity, not absence: the harness itself exports ELECTRON_RUN_AS_NODE into the shells it
    // spawns, so what must hold is that the unpacked case does not PATCH the environment.
    check('resolve: an unpacked entry gets the environment unpatched', unpacked.env === process.env)
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(fakeDir, { recursive: true, force: true })
  }
}

// ---- the app layout moved (DSH 0.1.7, then 0.2.0-rc.2) ----------------------
// Portable: with the app present it must resolve; with none, it must explain every layout it tried.
// An entry inside app.asar is invisible to existsSync by design, so it is validated by shape.
{
  let entry = null
  let entryError = ''
  try {
    entry = resolveDshEntry()
  } catch (error) {
    entryError = error.message
  }
  const insideArchive = entry !== null && /\.asar[\\/]/i.test(entry)
  check(
    'resolve: locates the dsh CLI, or explains the layouts it tried',
    entry === null
      ? /app\.asar/.test(entryError)
      : insideArchive
        ? /resources[\\/]app\.asar[\\/]dsh[\\/]node_modules/.test(entry)
        : existsSync(entry),
    entry ?? entryError,
  )
  if (entry !== null) {
    check(
      'resolve: an unpacked entry sits under a shipped layout',
      insideArchive || /resources[\\/](app\.asar\.unpacked|app)[\\/]node_modules/.test(entry),
      entry,
    )
    const resolved = resolveDshLaunch()
    check('resolve: the interpreter resolves to an existing file', existsSync(resolved.command), resolved.command)
    check(
      'resolve: the launch mode matches where the entry lives',
      (resolved.mode === 'electron') === insideArchive,
      `${resolved.mode} for ${resolved.where}`,
    )
    if (insideArchive) {
      check('resolve: launching an archive entry sets the Electron environment', resolved.env.ELECTRON_RUN_AS_NODE === '1')
    }
    check('resolve: resolveDshNode still answers with the interpreter', resolveDshNode() === resolved.command)
  }
}

// ---- the conductor script transfer ------------------------------------------
// 首尾空白可被容忍，正文改动仍须拒绝；全部标识符均为合成夹具。
{
  const intended = buildWorkflowScript('C:\\tmp\\reviewer-prompt.txt', { package_id: 'phase0-example0-00000001', nonce: '00000000-0000-4000-8000-000000000011' })

  check('script: an identical script is exact', classifyScriptTransfer(intended, intended).state === 'exact')

  const leading = classifyScriptTransfer(`\n${intended}`, intended)
  check('script: a leading newline is tolerated, not treated as tampering', leading.state === 'edge-whitespace', JSON.stringify(leading))
  check('script: the added leading newline is counted', leading.leading === 1 && leading.trailing === 0, JSON.stringify(leading))

  const trailing = classifyScriptTransfer(`${intended}\n`, intended)
  check('script: a trailing newline is tolerated too', trailing.state === 'edge-whitespace', JSON.stringify(trailing))
  check('script: the added trailing newline is counted', trailing.leading === 0 && trailing.trailing === 1, JSON.stringify(trailing))

  check('script: \\r\\n at both ends is still only edge whitespace', classifyScriptTransfer(`\r\n${intended}\r\n`, intended).state === 'edge-whitespace')
  // Whitespace INSIDE the body is not edge whitespace, and the built script does contain newlines.
  check('script: changing interior whitespace is still an alteration', classifyScriptTransfer(intended.replace('\n', ' '), intended).state === 'altered')

  // The two real alteration shapes: a difference inside the body, at an offset and at the end.
  const editedInside = intended.replace('await agent(', 'await  agent(')
  const insideTransfer = classifyScriptTransfer(editedInside, intended)
  check('script: an edit inside the body is still rejected', insideTransfer.state === 'altered', JSON.stringify(insideTransfer))
  check('script: the rejection points at the first differing character', insideTransfer.firstDifference === editedInside.indexOf('await  agent(') + 6, String(insideTransfer.firstDifference))

  const appendedLine = `${intended}\n// extra`
  const appendedTransfer = classifyScriptTransfer(appendedLine, intended)
  check('script: text appended after the body is still rejected', appendedTransfer.state === 'altered', JSON.stringify(appendedTransfer))

  // A non-string script means the conductor never supplied one, which stays its own state.
  check('script: a missing script is reported as missing', classifyScriptTransfer(null, intended).state === 'missing')

  // Identity lives in the body, so tolerating edge whitespace must not weaken it.
  const otherIdentity = buildWorkflowScript('C:\\tmp\\reviewer-prompt.txt', { package_id: 'phase0-OTHER-0000', nonce: '00000000-0000-0000-0000-000000000000' })
  check('script: a different identity is still an alteration', classifyScriptTransfer(`${otherIdentity}\n`, intended).state === 'altered')
}

// ---- identity is bound, not transcribed -------------------------------------
// 合成长标识符用于验证单字符抄写差异、身份纠正及真正的身份冲突。
const LONG_ID = 'red-example0-00000001'
const LONG_NONCE = '00000000-0000-4000-8000-000000000021'
const longPkg = { ...pkg, package_id: LONG_ID }
const slippedPayload = {
  package_id: 'red-exaample0-00000001',
  nonce: LONG_NONCE,
  verdict: 'PASS',
  findings: [],
  unknowns: [],
  summary: 'ok',
}
const slipped = validateReturn(longPkg, LONG_NONCE, slippedPayload)
check('identity: a one-character slip keeps the verdict', slipped.valid === true, slipped.problems.join('; '))
check('identity: the slip is corrected to the authoritative id', slippedPayload.package_id === LONG_ID)
check('identity: the correction is reported', slipped.warnings.some((w) => /transcription slip/.test(w)), slipped.warnings.join('; '))

const slippedNonce = validateReturn(longPkg, LONG_NONCE, {
  package_id: LONG_ID,
  nonce: '00000000-0000-4000-8000-000000000022',
  verdict: 'PASS',
  findings: [],
  unknowns: [],
  summary: 'ok',
})
check('identity: a near-miss nonce is corrected too', slippedNonce.valid === true, slippedNonce.problems.join('; '))

// A genuinely different identifier is still a binding failure.
const otherId = validateReturn(longPkg, LONG_NONCE, { ...slippedPayload, package_id: 'green-example9-99999999' })
check('identity: a different id is still fatal', otherId.valid === false && /package_id mismatch/.test(otherId.problems.join(' ')))
const otherNonce = validateReturn(longPkg, LONG_NONCE, { ...slippedPayload, package_id: LONG_ID, nonce: '11111111-2222-3333-4444-555555555555' })
check('identity: a different nonce is still fatal', otherNonce.valid === false && /nonce mismatch/.test(otherNonce.problems.join(' ')))

// Short ids get no tolerance: one character there is a different identifier.
check('identity: a short id stays strictly compared', validateReturn(pkg, NONCE, { ...passReturn, package_id: 'pkg-2' }).valid === false)

// And the script binds identity itself, so the slip cannot reach the validator at all.
const boundScript = buildWorkflowScript('C:\\tmp\\p.txt', { package_id: LONG_ID, nonce: LONG_NONCE })
check('identity: the script writes the package_id', boundScript.includes(`review.package_id = ${JSON.stringify(LONG_ID)}`))
check('identity: the script writes the nonce', boundScript.includes(`review.nonce = ${JSON.stringify(LONG_NONCE)}`))
check('identity: the script binds after the failure guard', boundScript.indexOf('reviewer_failed') < boundScript.indexOf('review.package_id ='))
check('identity: a script built without identity does not bind', !buildWorkflowScript('C:\\tmp\\p.txt').includes('review.package_id ='))

// ---- an echoed clause after a declared id is not a scope violation ----------
// A real RED review declared the single obligation "RED" and answered with the whole rendered line,
// "RED: <the 137-character clause>", because that is how the prompt listed it. Both its finding and
// its structural limit were correct and both were discarded over the label. The scope check exists
// to catch an obligation nobody declared; that must stay fatal.
const echoedPayload = {
  ...failReturn,
  findings: [{ ...goodFinding, obligation_id: 'OB-A: the thing this obligation actually says' }],
  structural_limits: [{ obligation_id: 'OB-A: same clause again', question: 'STRUCTURAL SANDBOX LIMIT: x' }],
}
const echoedId = validateReturn(pkg, NONCE, echoedPayload)
check('obligation: an echoed clause is accepted', echoedId.valid === true, echoedId.problems.join('; '))
check('obligation: the finding id is normalised to the token', echoedId.valid && echoedPayload.findings[0].obligation_id === 'OB-A')
check('obligation: the limit id is normalised too', echoedId.valid && echoedPayload.structural_limits[0].obligation_id === 'OB-A')
check('obligation: normalisation is reported as a warning', echoedId.warnings.some((w) => /repeated the clause/.test(w)), echoedId.warnings.join('; '))
check('obligation: a bare dash separator also normalises', validateReturn(pkg, NONCE, { ...failReturn, findings: [{ ...goodFinding, obligation_id: 'OB-A - clause' }] }).valid === true)
check('obligation: an undeclared id is still fatal', validateReturn(pkg, NONCE, { ...failReturn, findings: [{ ...goodFinding, obligation_id: 'OB-OTHER: clause' }] }).valid === false)
const longest = validateReturn({ ...pkg, obligations: [{ id: 'OB', clause: 'short' }, { id: 'OB-A', clause: 'longer' }] }, NONCE, {
  ...failReturn,
  findings: [{ ...goodFinding, obligation_id: 'OB-A: clause' }],
})
check('obligation: the longest declared prefix wins', longest.valid === true && failReturn.findings[0].obligation_id === 'OB-A')

// ---- a prior verdict on another gate cannot contradict this one -------------
const priors = [
  { package_id: 'green-1', state: 'PASS', stage: 'GREEN', obligations: ['MANUAL', 'FONT', 'REGRESSION'] },
  { package_id: 'phase0-1', state: 'FAIL', stage: 'PHASE0', obligations: ['DESIGN', 'CONSUMERS'] },
]
const splitGreen = comparePriorVerdicts(priors, 'GREEN', ['MANUAL', 'FONT', 'REGRESSION'])
check('contradiction: a different stage is not comparable', splitGreen.comparable.length === 1 && splitGreen.comparable[0].package_id === 'green-1')
check('contradiction: the PHASE0 FAIL lands in unrelated', splitGreen.unrelated.map((p) => p.package_id).join() === 'phase0-1')
check('contradiction: shared obligations are named', JSON.stringify(splitGreen.comparable[0].shared_obligations) === '["MANUAL","FONT","REGRESSION"]')

// The same stage but disjoint obligations is also not a contradiction.
const disjoint = comparePriorVerdicts([{ package_id: 'p', state: 'FAIL', stage: 'GREEN', obligations: ['OTHER'] }], 'GREEN', ['MANUAL'])
check('contradiction: same stage, disjoint obligations is not comparable', disjoint.comparable.length === 0)

// The real case: the same stage and a shared obligation IS comparable and must still be detected.
const realContradiction = comparePriorVerdicts([{ package_id: 'p', state: 'FAIL', stage: 'GREEN', obligations: ['FONT'] }], 'GREEN', ['MANUAL', 'FONT'])
check('contradiction: same stage with a shared obligation stays comparable', realContradiction.comparable.length === 1)
check('contradiction: and reports which obligation overlaps', JSON.stringify(realContradiction.comparable[0].shared_obligations) === '["FONT"]')

// A complete verdict is never discarded over a SECONDARY field. Only identity and binding defects
// stay fatal (package_id, nonce, verdict enum, findings/unknowns shapes, obligation_id supplied);
// the rest is reported so the weakness is visible and the evidence survives.
const duplicateKey = validateReturn(pkg, NONCE, { ...failReturn, findings: [goodFinding, { ...goodFinding, file: 'b.py', line: 9 }] })
check('accept: a duplicate root_cause_key keeps both findings', duplicateKey.valid === true, duplicateKey.problems.join('; '))
check('accept: the duplicate key is reported', duplicateKey.warnings.some((w) => /repeats an earlier finding/.test(w)))

const sameBody = validateReturn(pkg, NONCE, { ...failReturn, findings: [goodFinding, { ...goodFinding, root_cause_key: 'other-key' }] })
check('accept: two findings sharing a body are both kept', sameBody.valid === true, sameBody.problems.join('; '))
check('accept: the shared body is reported', sameBody.warnings.some((w) => /repeats the body of findings/.test(w)))

const badSlug = validateReturn(pkg, NONCE, { ...failReturn, findings: [{ ...goodFinding, root_cause_key: 'Not A Slug' }] })
check('accept: a non-slug root_cause_key keeps the finding', badSlug.valid === true, badSlug.problems.join('; '))
check('accept: the bad slug is reported', badSlug.warnings.some((w) => /does not match/.test(w)))

const passWithFindings = validateReturn(pkg, NONCE, { ...failReturn, verdict: 'PASS' })
check('reject: PASS carrying findings', passWithFindings.valid === false)

const failWithNothing = validateReturn(pkg, NONCE, { ...passReturn, verdict: 'FAIL' })
check('reject: FAIL carrying nothing', failWithNothing.valid === false)

for (const [label, line] of [['zero', 0], ['negative', -1], ['string', '3']]) {
  const input = { ...failReturn, findings: [{ ...goodFinding, line }] }
  const normalized = validateReturn(pkg, NONCE, input)
  check(`accept: an unusable line (${label}) is normalised to null`, normalized.valid === true, normalized.problems.join('; '))
  check(`accept: an unusable line (${label}) is reported`, normalized.warnings.some((w) => /set to null/.test(w)))
  check(`accept: an unusable line (${label}) really became null`, input.findings[0].line === null)
}

const nullLine = validateReturn(pkg, NONCE, { ...failReturn, findings: [{ ...goodFinding, line: null }] })
check('accept: null line for a section with no exact line', nullLine.valid === true, nullLine.problems.join('; '))

// The cap bounds the payload; nine findings is more information, not a malformed review.
const tooMany = validateReturn(pkg, NONCE, {
  ...failReturn,
  findings: Array.from({ length: 9 }, (_, i) => ({ ...goodFinding, root_cause_key: `k${i}`, file: `f${i}.py` })),
})
check('accept: nine findings are all kept', tooMany.valid === true, tooMany.problems.join('; '))
check('accept: the overrun is reported', tooMany.warnings.some((w) => /above the 8 advisory cap/.test(w)))

// Over-length prose must never cost a verdict. The schema subset cannot express a maximum, so the
// model has no enforceable signal: a real RED run returned a complete PASS whose summary was 2272
// characters, and the old "the limit is 2000" rule threw the whole review away -- verdict, and the
// only record of what the reviewer could not verify. Emptiness stays fatal; length does not.
const longSummary = validateReturn(pkg, NONCE, { ...passReturn, summary: 'x'.repeat(2272) })
check('accept: an over-long summary keeps the verdict', longSummary.valid === true, longSummary.problems.join('; '))
check('accept: an over-long summary is reported as a warning', longSummary.warnings.some((w) => /summary is 2272 characters/.test(w)), longSummary.warnings.join('; '))
check('accept: an over-long summary does not become a problem', longSummary.problems.length === 0)
check('accept: a summary exactly at the advisory target passes', validateReturn(pkg, NONCE, { ...passReturn, summary: 'x'.repeat(2000) }).valid === true)
check('reject: an empty summary is reported as empty, not as long', validateReturn(pkg, NONCE, { ...passReturn, summary: '   ' }).problems.some((p) => /summary must be a non-empty string/.test(p)))
check('reject: a non-string summary is still a defect', validateReturn(pkg, NONCE, { ...passReturn, summary: 42 }).valid === false)

// The hard ceiling exists only so one runaway field cannot swamp the caller's context. It truncates
// and says so; it does not invalidate.
const runaway = { ...passReturn, summary: 'x'.repeat(25000) }
const truncated = validateReturn(pkg, NONCE, runaway)
check('accept: a runaway summary still yields a verdict', truncated.valid === true, truncated.problems.join('; '))
check('accept: a runaway summary is truncated with a marker', runaway.summary.endsWith('…[truncated by the review bridge]'), `len=${runaway.summary.length}`)
check('accept: truncation records the original length', truncated.warnings.some((w) => /was 25000 characters and has been truncated/.test(w)), truncated.warnings.join('; '))

const longField = { ...failReturn, findings: [{ ...goodFinding, counterexample: 'x'.repeat(2500) }] }
const longFieldResult = validateReturn(pkg, NONCE, longField)
check('accept: an over-long finding field keeps the verdict', longFieldResult.valid === true, longFieldResult.problems.join('; '))
check('accept: an over-long finding field is a warning', longFieldResult.warnings.some((w) => /counterexample is 2500 characters/.test(w)), longFieldResult.warnings.join('; '))
check('accept: an over-long finding field is not truncated at the advisory target', longField.findings[0].counterexample.length === 2500)
{
  const blankField = validateReturn(pkg, NONCE, { ...failReturn, findings: [{ ...goodFinding, impact: '' }] })
  check('accept: an empty finding field keeps the finding', blankField.valid === true, blankField.problems.join('; '))
  check('accept: the empty field is reported instead', blankField.warnings.some((w) => /impact is empty/.test(w)))
}

// ---- structural_limits ------------------------------------------------------
// The reviewer's own sandbox forbids verifications; that is not uncertainty about the candidate.
// Filing those as unknowns forced a false FAIL, and burying them in prose hid them: both happened.

const withLimit = { ...passReturn, structural_limits: [{ obligation_id: 'OB-A', question: 'STRUCTURAL SANDBOX LIMIT: rerun the suite, which needs a temp dir' }] }
const limitResult = validateReturn(pkg, NONCE, withLimit)
check('accept: a PASS may carry a structural limit', limitResult.valid === true, limitResult.problems.join('; '))
check('accept: a structural limit does not change the verdict', limitResult.state === 'PASS')
check('accept: a structural limit is not reported as a problem', limitResult.problems.length === 0)

check('accept: structural_limits is optional', validateReturn(pkg, NONCE, { ...passReturn }).valid === true)
check(
  'reject: a structural limit must bind to a supplied obligation',
  validateReturn(pkg, NONCE, { ...passReturn, structural_limits: [{ obligation_id: 'OB-INVENTED', question: 'q' }] }).valid === false,
)
check(
  'accept: a structural limit rejects undeclared fields',
  validateReturn(pkg, NONCE, { ...passReturn, structural_limits: [{ obligation_id: 'OB-A', question: 'q', severity: 'P0' }] }).valid === false,
)
check(
  'accept: an empty structural_limits array is not a limit',
  validateReturn(pkg, NONCE, { ...passReturn, structural_limits: [] }).valid === true,
)

// ---- a failed reviewer agent is not a malformed return ----------------------
// agent() resolves null when the child fails, and a real run reported that as "returned value is
// not a JSON object" while the actual cause sat in the child's turn record: a provider rejection,
// HTTP 400 "Content Exists Risk". The two must not share a message or a state.
const agentFailed = validateReturn(pkg, NONCE, {
  reviewer_failed: true,
  reason: 'the reviewer agent produced no result: its turn ended in an error before it could return one',
})
check('failed-agent: gets its own state', agentFailed.state === 'REVIEWER_AGENT_FAILED', agentFailed.state)
check('failed-agent: is not reported as a shape problem', agentFailed.state !== 'REVIEW_STRUCTURAL_INVALID')
check('failed-agent: carries the reason', /produced no result/.test(agentFailed.problems.join(' ')))
check('failed-agent: the marker is not read as an undeclared field', !/undeclared/.test(agentFailed.problems.join(' ')))

check('failed-agent: a bare null still reports as a non-object', validateReturn(pkg, NONCE, null).state === 'REVIEW_STRUCTURAL_INVALID')

const scriptText = buildWorkflowScript('C:\\tmp\\prompt.txt')
check('failed-agent: the script no longer returns a bare null', (await runWorkflow(() => null))?.reviewer_failed === true)
check('failed-agent: the script still returns the review when it exists', /return review;/.test(scriptText))

// The failure extractor reads the harness's own turn record, not prose.
const turnEvents = [
  { type: 'step/end', data: { turn: 1, step: 13 } },
  { type: 'turn/end', data: { turn: 1, reason: { kind: 'error', error: { message: 'Content Exists Risk (request_id: x)', code: 'INVALID_REQUEST', status: 400 } } } },
]
const extractedFailure = turnFailureFromEvents(turnEvents)
check('failed-agent: extracts a provider failure', extractedFailure?.status === 400, JSON.stringify(extractedFailure))
check('failed-agent: keeps the provider message', /Content Exists Risk/.test(extractedFailure?.message ?? ''))
check(
  'failed-agent: a clean turn reports no failure',
  turnFailureFromEvents([{ type: 'turn/end', data: { reason: { kind: 'completed' } } }]) === null,
)
check(
  'failed-agent: falls back to the failing step when the turn has no end record',
  turnFailureFromEvents([
    { type: 'assistant/chunk', data: { step: 14, chunk: { type: 'finish', reason: { kind: 'error', failure: { message: 'boom', code: 'X', status: 500 } } } } },
  ])?.status === 500,
)


// A real FAIL was lost here. The reviewer obeyed the instruction to state the narrow blocked set and
// the exact command, produced a 2756-character structural limit, and isNonEmptyString's 2000-char
// default reported it as "must be a non-empty string" -- discarding the verdict and its P1 finding.
const LONG_LIMIT = 'STRUCTURAL SANDBOX LIMIT: ' + 'x'.repeat(2731)
const longLimit = validateReturn(pkg, NONCE, {
  ...passReturn,
  structural_limits: [{ obligation_id: 'OB-A', question: LONG_LIMIT }],
})
check('accept: a long structural limit keeps the verdict', longLimit.valid === true, longLimit.problems.join('; '))
check('accept: a long structural limit is a warning, not a problem', longLimit.problems.length === 0)
check(
  'accept: the long limit is described by length, never as emptiness',
  new RegExp(`question is ${LONG_LIMIT.length} characters`).test(longLimit.warnings.join('; ')) &&
    !longLimit.warnings.some((w) => /must be a non-empty string/.test(w)),
  longLimit.warnings.join('; '),
)

// A content-free entry carries nothing, so it is dropped rather than punishing the whole return.
const emptyLimit = validateReturn(pkg, NONCE, {
  ...passReturn,
  structural_limits: [{ obligation_id: 'OB-A', question: '   ' }],
})
check('accept: an empty structural limit is dropped, not fatal', emptyLimit.valid === true, emptyLimit.problems.join('; '))
check('accept: dropping it is reported', emptyLimit.warnings.some((w) => /carries no information and was dropped/.test(w)))
check('accept: the dropped limit is removed from the return', emptyLimit.valid && Array.isArray(passReturn.structural_limits) === false)

// A FAIL whose only unknown is content-free keeps its finding and stays a FAIL.
const failWithEmptyUnknown = { ...failReturn, unknowns: [{ obligation_id: 'OB-A', question: '' }] }
const failKept = validateReturn(pkg, NONCE, failWithEmptyUnknown)
check('accept: a FAIL keeps its finding when an empty unknown is dropped', failKept.valid === true, failKept.problems.join('; '))
check('accept: the empty unknown is gone from the return', failWithEmptyUnknown.unknowns.length === 0)

// And when the empty unknown was the ONLY content, the accurate rule reports it -- not emptiness.
const failOnlyEmptyUnknown = validateReturn(pkg, NONCE, {
  ...passReturn,
  verdict: 'FAIL',
  unknowns: [{ obligation_id: 'OB-A', question: '' }],
})
check('reject: a FAIL emptied of content fails on the content rule', failOnlyEmptyUnknown.valid === false)
check(
  'reject: and says so accurately',
  failOnlyEmptyUnknown.problems.some((p) => /FAIL requires at least one finding or unknown/.test(p)) &&
    !failOnlyEmptyUnknown.problems.some((p) => /must be a non-empty string/.test(p)),
  failOnlyEmptyUnknown.problems.join('; '),
)

// An implausible path is not an invalid review.
const longPath = validateReturn(pkg, NONCE, { ...failReturn, findings: [{ ...goodFinding, file: 'x'.repeat(600) }] })
check('accept: a wildly long file path keeps the finding', longPath.valid === true, longPath.problems.join('; '))
check('accept: the long path is warned about', longPath.warnings.some((w) => /longer than any real path/.test(w)))
{
  const emptyPath = validateReturn(pkg, NONCE, { ...failReturn, findings: [{ ...goodFinding, file: '' }] })
  check('accept: an empty file path keeps the finding', emptyPath.valid === true, emptyPath.problems.join('; '))
  check('accept: the missing location is reported', emptyPath.warnings.some((w) => /names no location/.test(w)))
}

// ---- structural limit discharge ---------------------------------------------
// A structural limit is a permanent property of the read-only reviewer, so its presence cannot
// hold a gate. A real RED gate deadlocked here: the caller supplied the requested independent run,
// the next reviewer acknowledged it by name, and the gate still refused to close because the
// reviewer could not run pytest itself. Discharge is therefore decided by whether the caller
// supplied different evidence since the limit was first raised.

const CAND = 'deadbeefcafe0001'
const evHash = (text) => createHash('sha256').update(text).digest('hex')

const archiveRoot = mkdtempSync(join(tmpdir(), 'dsh-review-archive-'))
function writeRun(name, { candidate, evidence, limits, verdict = 'PASS' }) {
  mkdirSync(join(archiveRoot, name), { recursive: true })
  writeFileSync(
    join(archiveRoot, name, 'review-result.json'),
    JSON.stringify({
      package_id: name,
      state: verdict,
      started_at: `2026-09-22T00:00:0${name.length}.000Z`,
      candidate_identity_after: candidate,
      return: { verdict, findings: [], unknowns: [], structural_limits: limits, summary: 'x' },
    }),
  )
  writeFileSync(join(archiveRoot, name, 'package.json'), JSON.stringify({ evidence }))
}
const LIMIT = [{ obligation_id: 'RED-CAUSE', question: 'STRUCTURAL SANDBOX LIMIT: cannot run pytest' }]

// First run on a fresh candidate: nothing has been asked before.
const historyEmpty = structuralLimitHistory(archiveRoot, CAND, 'red-1')
check('discharge: no prior report for an unseen candidate', historyEmpty.length === 0)
check(
  'discharge: first sight of a limit is new',
  classifyStructuralLimits(LIMIT, historyEmpty, evHash('E1'))[0].status === 'new',
)

// Run 1 reported the limit with evidence E1.
writeRun('red-1', { candidate: CAND, evidence: 'E1', limits: LIMIT })

// Run 2 arrives with DIFFERENT evidence for the same candidate: the caller did the work.
const historyAfter1 = structuralLimitHistory(archiveRoot, CAND, 'red-2')
check('discharge: history finds the earlier run', historyAfter1.length === 1)
check('discharge: history recomputes the evidence digest from the archive', historyAfter1[0].evidence_hash === evHash('E1'))
check('discharge: history records the obligation', historyAfter1[0].obligations.includes('RED-CAUSE'))
check(
  'discharge: new evidence discharges the limit',
  classifyStructuralLimits(LIMIT, historyAfter1, evHash('E2'))[0].status === 'discharged_by_new_evidence',
)
check(
  'discharge: unchanged evidence does NOT discharge',
  classifyStructuralLimits(LIMIT, historyAfter1, evHash('E1'))[0].status === 'unaddressed_resend',
)
check(
  'discharge: a different obligation is still new',
  classifyStructuralLimits([{ obligation_id: 'S1-TEST', question: 'q' }], historyAfter1, evHash('E2'))[0].status === 'new',
)
check(
  'discharge: a limit with no obligation_id is treated as new',
  classifyStructuralLimits([{ question: 'q' }], historyAfter1, evHash('E2'))[0].status === 'new',
)

// A run that produced no verdict is not a prior report, so it cannot discharge anything.
writeRun('red-rejected', { candidate: CAND, evidence: 'E9', limits: LIMIT, verdict: 'REVIEW_TIMEOUT' })
check(
  'discharge: a run with no verdict is ignored',
  structuralLimitHistory(archiveRoot, CAND, 'red-x').length === 1,
)

// Records from before structural_limits existed filed the same limitation under unknowns.
mkdirSync(join(archiveRoot, 'red-legacy'), { recursive: true })
writeFileSync(
  join(archiveRoot, 'red-legacy', 'review-result.json'),
  JSON.stringify({
    package_id: 'red-legacy',
    state: 'FAIL',
    started_at: '2026-09-21T00:00:00.000Z',
    candidate_identity_after: CAND,
    return: { verdict: 'FAIL', findings: [], unknowns: [{ obligation_id: 'RED-CAUSE', question: 'STRUCTURAL SANDBOX LIMIT: old format' }] },
  }),
)
writeFileSync(join(archiveRoot, 'red-legacy', 'package.json'), JSON.stringify({ evidence: 'E0' }))
check(
  'discharge: pre-field runs filed under unknowns still count',
  classifyStructuralLimits(LIMIT, structuralLimitHistory(archiveRoot, CAND, 'red-3'), evHash('E3'))[0].status ===
    'discharged_by_new_evidence',
)
rmSync(archiveRoot, { recursive: true, force: true })

// ---- validatePackage --------------------------------------------------------

check('package: accepts a valid envelope', validatePackage(pkg).length === 0)
check('package: rejects GREEN with expected_failures', validatePackage({ ...pkg, expected_failures: ['something'] }).length > 0)
check('package: accepts RED with expected_failures', validatePackage({ ...pkg, stage: 'RED', expected_failures: ['impl absent'] }).length === 0)
// RED needs the command for the same reason GREEN does, and more sharply: the bridge must run the
// failing tests itself, because the reviewer's sandbox usually cannot. A RED package without it
// produced coordinator_ran_test_command null, and the reviewer spent its budget trying to generate
// the failure output it was owed -- then timed out with no verdict.
check('package: rejects RED without test_command', validatePackage({ ...pkg, stage: 'RED', test_command: undefined }).length > 0)
check('package: accepts RED with test_command', validatePackage({ ...pkg, stage: 'RED', test_command: 'pytest -q' }).length === 0)
check('package: the RED rejection explains why', /bridge must run the failures itself/.test(validatePackage({ ...pkg, stage: 'RED', test_command: undefined }).join(' ')))
// A GREEN or FINAL verdict rests on executed tests; without a command there is no test evidence.
check('package: rejects GREEN without test_command', validatePackage({ ...pkg, test_command: undefined }).length > 0)
check('package: rejects FINAL without test_command', validatePackage({ ...pkg, stage: 'FINAL', test_command: undefined }).length > 0)
check('package: accepts PHASE0 without test_command', validatePackage({ ...pkg, stage: 'PHASE0', test_command: undefined }).length === 0)
check('package: rejects an empty test_command', validatePackage({ ...pkg, test_command: '   ' }).length > 0)
check('package: rejects an unknown stage', validatePackage({ ...pkg, stage: 'ALPHA' }).length > 0)
check('package: rejects a short objective', validatePackage({ ...pkg, objective: 'short' }).length > 0)
check('package: rejects empty obligations', validatePackage({ ...pkg, obligations: [] }).length > 0)

// ---- hashDirectory ----------------------------------------------------------

const fixture = mkdtempSync(join(tmpdir(), 'dsh-hash-'))
try {
  mkdirSync(join(fixture, '__pycache__'))
  writeFileSync(join(fixture, '__pycache__', 'junk.pyc'), 'cache')
  mkdirSync(join(fixture, '.git'))
  writeFileSync(join(fixture, '.git', 'HEAD'), 'ref: x')
  writeFileSync(join(fixture, 'code.py'), 'x = 1\n')

  const before = hashDirectory(fixture)
  check('hash: stable across runs', before.treeHash === hashDirectory(fixture).treeHash)
  check('hash: ignores caches and VCS metadata', before.fileCount === 1, `fileCount=${before.fileCount}`)

  writeFileSync(join(fixture, 'code.py'), 'x = 2\n')
  const after = hashDirectory(fixture)
  check('hash: detects a content change', before.treeHash !== after.treeHash)

  writeFileSync(join(fixture, '__pycache__', 'junk.pyc'), 'other cache')
  check('hash: ignores a cache-only change', after.treeHash === hashDirectory(fixture).treeHash)

  // Scoped identity. A real run hashed 79,929 files — the whole repository including .venv and
  // the gate's own records — so two runs over unchanged product code produced different
  // identities and silently disabled the cross-run contradiction check.
  mkdirSync(join(fixture, 'src'), { recursive: true })
  mkdirSync(join(fixture, 'tests'), { recursive: true })
  mkdirSync(join(fixture, 'local', 'development'), { recursive: true })
  writeFileSync(join(fixture, 'src', 'app.py'), 'app = 1\n')
  writeFileSync(join(fixture, 'tests', 'test_app.py'), 'test = 1\n')
  writeFileSync(join(fixture, 'local', 'development', 'REVIEW.md'), 'records\n')

  const scoped = hashDirectory(fixture, undefined, ['src', 'tests'])
  check('hash: a declared scope hashes only those paths', scoped.fileCount === 2, `fileCount=${scoped.fileCount}`)
  check('hash: records the scope it used', JSON.stringify(scoped.scope) === '["src","tests"]')
  check('hash: records an unscoped run as entire-tree', hashDirectory(fixture).scope === 'entire-tree')

  // The record of a gate is not the candidate: writing review records must not move the identity.
  const scopedAgainBefore = hashDirectory(fixture, undefined, ['src', 'tests']).treeHash
  writeFileSync(join(fixture, 'local', 'development', 'REVIEW.md'), 'records, updated by the next gate\n')
  check(
    'hash: a record-only change does not move a scoped identity',
    scopedAgainBefore === hashDirectory(fixture, undefined, ['src', 'tests']).treeHash,
  )
  check(
    'hash: the same record-only change DOES move an entire-tree identity',
    hashDirectory(fixture).fileCount > scoped.fileCount,
  )
  check(
    'hash: a product change still moves a scoped identity',
    (() => {
      writeFileSync(join(fixture, 'src', 'app.py'), 'app = 2\n')
      return scopedAgainBefore !== hashDirectory(fixture, undefined, ['src', 'tests']).treeHash
    })(),
  )
  check('hash: accepts ./ and trailing slashes in a scope entry', hashDirectory(fixture, undefined, ['./src/']).fileCount === 1)
} finally {
  rmSync(fixture, { recursive: true, force: true })
}

// ---- report -----------------------------------------------------------------

console.log(`passed: ${passed}`)
if (failures.length > 0) {
  console.log(`failed: ${failures.length}`)
  for (const failure of failures) console.log(`  - ${failure}`)
  process.exitCode = 1
} else {
  console.log('all bridge logic checks passed')
}
