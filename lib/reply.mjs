// 协作回复的唯一执行入口。项目提供正文和来源线程，传输策略由插件固定。
import { randomUUID, createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { registerDesktopTarget, sendDesktopMessage } from './codex-desktop-delivery.mjs'

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i
const ANSWER_MARK = '[DSH] 以上是 DSH 协作会话的回答原文，未经 Codex 改写。'

export function markAnswer({ answer, questionId, basis }) {
  if (answer.startsWith('[DSH]') || answer.includes(ANSWER_MARK)) return answer
  return `${answer}\n\n---\n${ANSWER_MARK}\n依据：${questionId ? `提问 ID ${questionId}` : '本次对话'}${basis ? `；${basis}` : ''}`
}

export function parseReplyArgs(argv) {
  const allowed = new Set(['thread', 'message-file', 'message', 'question-id', 'basis', 'dry-run', 'register-desktop'])
  const flags = {}
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (!token.startsWith('--')) throw new Error('只接受明确的命名参数')
    const split = token.indexOf('=')
    const name = token.slice(2, split === -1 ? undefined : split)
    if (!allowed.has(name)) throw new Error(`不支持参数 --${name}；投递方式由插件决定`)
    if (Object.hasOwn(flags, name)) throw new Error(`重复参数 --${name}`)
    if (['dry-run', 'register-desktop'].includes(name)) {
      if (split !== -1) throw new Error(`--${name} 不接受参数值`)
      flags[name] = true
      continue
    }
    const value = split === -1 ? argv[++i] : token.slice(split + 1)
    if (typeof value !== 'string' || !value.trim() || value.startsWith('--')) throw new Error(`--${name} 缺少参数值`)
    flags[name] = value
  }
  if (!UUID.test(flags.thread ?? '')) throw new Error('需要明确的来源线程 UUID')
  if (flags['register-desktop']) {
    if (Object.keys(flags).some(k => !['thread', 'register-desktop'].includes(k))) throw new Error('端点登记不能混入发送参数')
  } else if (Boolean(flags.message) === Boolean(flags['message-file'])) {
    throw new Error('正文必须且只能通过 --message-file 或 --message 提供')
  }
  return flags
}

function recordReceipt(receipt) {
  const home = process.env.CODEX_HOME || join(process.env.USERPROFILE, '.codex')
  const dir = join(home, 'magi-replies')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, receipt.reply_id + '.json')
  const data = JSON.stringify(receipt, null, 2)
  writeFileSync(file, data, { flag: 'wx', mode: 0o600 })
  if (readFileSync(file, 'utf8') !== data) throw new Error('回执读回不一致')
  return file
}

export async function replyToCodex(request, { send = sendDesktopMessage, record = recordReceipt } = {}) {
  if (!request || Object.keys(request).some(k => !['thread', 'answer', 'questionId', 'basis'].includes(k))) throw new Error('回复仅接受来源线程、正文和来源依据，不接受投递策略')
  const { thread, answer, questionId, basis } = request
  if (!UUID.test(thread ?? '') || typeof answer !== 'string' || !answer.trim()) throw new Error('来源线程或正文无效')
  for (const value of [questionId, basis]) if (value !== undefined && typeof value !== 'string') throw new Error('来源依据必须是文本')
  const message = markAnswer({ answer, questionId, basis })
  // 单次发送；失败不重试、不调用 CLI 队列。accepted 只代表桌面受理。
  const result = await send({ thread, message })
  if (result?.code !== 0 || result?.delivery !== 'accepted') throw new Error('桌面未确认受理；结果可能未知，核对目标记录后再处理，不自动重发')
  const receipt = { reply_id: randomUUID(), at: new Date().toISOString(), thread_id: thread, question_id: questionId ?? null, transport: 'codex-app-tools', delivery: 'accepted', message_sha256: createHash('sha256').update(message).digest('hex'), message_length: message.length }
  try { receipt.audit_file = record(receipt) } catch { receipt.audit_warning = '桌面已受理，但本地回执未保存；请核对目标记录，不要重复发送' }
  return receipt
}

export async function runReplyCli(argv = process.argv.slice(2)) {
  const flags = parseReplyArgs(argv)
  if (flags['register-desktop']) {
    const receipt = registerDesktopTarget({ thread: flags.thread })
    if (!receipt) throw new Error('请在目标 Codex 对话中登记当前桌面端点')
    return { registered: flags.thread, receipt }
  }
  const answer = flags['message-file'] ? readFileSync(flags['message-file'], 'utf8') : flags.message
  if (!answer.trim()) throw new Error('正文不能为空')
  if (flags['dry-run']) return { thread_id: flags.thread, transport: 'codex-app-tools', dry_run: true, message_length: answer.length }
  return replyToCodex({ thread: flags.thread, answer, questionId: flags['question-id'], basis: flags.basis })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runReplyCli().then(result => process.stdout.write(JSON.stringify(result) + '\n')).catch(error => {
    process.stderr.write(`magi reply: ${error.message}\n`)
    process.exitCode = 1
  })
}
