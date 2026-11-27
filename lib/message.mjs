#!/usr/bin/env node
import { randomUUID } from 'node:crypto'
import { existsSync, realpathSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { dshHome } from './home.mjs'
import { callerThread, registerDesktopTarget, sendDesktopMessage } from './codex-desktop-delivery.mjs'

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/
const root = join(homedir(), '.magi', 'messages')
function address(value) {
  const [host, session, ...extra] = String(value).split('/')
  if (extra.length || !['codex','dsh','antigravity'].includes(host) ||
      !uuid.test(host === 'dsh' && session?.startsWith('session-') ? session.slice(8) : session) ||
      (host === 'dsh' && !session.startsWith('session-'))) throw Error('需要 客户端/完整会话ID')
  return {host, session}
}
function record(id, suffix, data) {
  writeFileSync(join(root,id+suffix),JSON.stringify(data),{flag:'wx',mode:0o600})
}
const verifiedAntigravity = Symbol('已核对宿主工具事件')
export async function routeMessage({from,to,replyTo,text,project,group}, metadata={}, verification) {
  // DSH 工具进程可能继承启动桌面程序时的 Codex 环境；只有请求元数据能覆盖当前宿主。
  const thread = process.env.DSH_SESSION_ID ? callerThread(metadata, {}) : callerThread(metadata)
  const current=thread ? 'codex/'+thread : process.env.DSH_SESSION_ID ? 'dsh/'+process.env.DSH_SESSION_ID : null
  from ??= current
  if(current && current!==from) throw Error('发送地址与宿主会话不一致')
  if (address(from).host === 'antigravity' && verification !== verifiedAntigravity) {
    throw Error('Antigravity 发件需要宿主工具事件')
  }
  if(typeof text!=='string'||!text.trim()||Buffer.byteLength(text)>48000) throw Error('正文为空或超过大小限制')
  if (group !== undefined) {
    if (to !== undefined || replyTo !== undefined || project !== undefined ||
        typeof group !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(group)) {
      throw Error('广播只接受组名、来源和正文')
    }
    const config = JSON.parse(readFileSync(join(root, '..', 'groups', group + '.json'), 'utf8'))
    const members = config.members
    if (!Array.isArray(members) || members.length !== 3 ||
        new Set(members.map(member => address(member).host)).size !== 3 ||
        typeof config.project !== 'string' || !config.project.trim()) {
      throw Error('广播组需要三个不同客户端的会话和 DSH 工作区')
    }
    if (!members.includes(from)) throw Error('发件会话不在广播组中')
    if (thread) registerDesktopTarget({thread})
    mkdirSync(root, {recursive:true, mode:0o700})
    const broadcastId = randomUUID()
    const copies = members.filter(member => member !== from)
      .map(to => ({to, id:randomUUID()}))
    record(broadcastId, '.broadcast.json', {group, from, text, copies, at:new Date().toISOString()})
    const deliveries = await Promise.all(copies.map(async ({to, id}) => {
      try {
        return await deliver({from, to, text, project:config.project, id, broadcastId})
      } catch (error) {
        return {id, to, status:'unconfirmed', detail:error.message}
      }
    }))
    const result = {broadcastId, group, from, deliveries}
    record(broadcastId, '.broadcast-result.json', result)
    return result
  }
  if(replyTo!==undefined) {
    if(to!==undefined||!uuid.test(replyTo)) throw Error('回复只接受原消息 ID')
    const original=JSON.parse(readFileSync(join(root,replyTo+'.json'),'utf8'))
    if(original.to!==from) throw Error('只有原收件会话可以回复')
    to=original.from
    project=original.project
  }
  if(thread) registerDesktopTarget({thread})
  return deliver({from, to, text, project, replyTo, id:randomUUID()})
}

async function deliver({from, to, text, project, replyTo, id, broadcastId}) {
  const sender = address(from)
  const target=address(to)
  if(target.host===sender.host) throw Error('请选择另一个客户端')
  if((sender.host==='dsh'||target.host==='dsh') && (typeof project!=='string'||!project.trim())) throw Error('需要 DSH 工作区路径')
  const entry=fileURLToPath(import.meta.url).replaceAll('\\','/')
  let windows
  let replyCommand = 'node "' + entry + '" reply ' + id + ' "<正文>" ' + to
  if (target.host === 'antigravity') {
    const configPath = join(homedir(), '.magi', 'antigravity-windows.json')
    windows = JSON.parse(readFileSync(configPath, 'utf8'))
    if (!Array.isArray(windows.sessions) || !windows.sessions.includes(target.session)) {
      throw Error('目标会话尚未登记为 Antigravity Windows 会话')
    }
    replyCommand = 'python "' + windows.helper + '" reply ' + id + ' "<正文>"'
  }
  mkdirSync(root,{recursive:true,mode:0o700})
  record(id,'.json',{id,from,to,project,replyTo,broadcastId,at:new Date().toISOString()})
  const labels = {codex: 'Codex', dsh: 'DSH', antigravity: 'Antigravity'}
  const heading = `[${labels[sender.host]}-${broadcastId ? '广播' : labels[target.host]}]`
  const body=heading+'\n'+text+'\n\n如需回复原发送会话，请执行 '+replyCommand
  if(target.host==='codex') await sendDesktopMessage({thread:target.session,message:body})
  if(target.host==='dsh') {
    const cfg=JSON.parse(readFileSync(join(dshHome(),'magi.json'),'utf8'))
    const res=await fetch('http://127.0.0.1:'+cfg.port+'/ask',{method:'POST',signal:AbortSignal.timeout(30000),headers:{authorization:'Bearer '+cfg.token,'content-type':'application/json'},body:JSON.stringify({project,session:target.session,question:body,mode:'steer',message_format:'magi-message-v1'})})
    const ack=await res.json()
    if(!res.ok||!ack.ok||ack.session_id!==target.session) throw Error('DSH 未确认目标会话')
  }
  if (windows) {
    const result = spawnSync(windows.python, [windows.transport, 'client'], {
      input: JSON.stringify({session: target.session, body}),
      encoding: 'utf8', timeout: 40000, windowsHide: true
    })
    if (result.error || result.status !== 0 || JSON.parse(result.stdout).accepted !== true) {
      throw Error('Windows Sidecar 未确认投递，请核对目标会话入站记录')
    }
  }
  record(id,'.accepted',{at:new Date().toISOString()})
  return {id,from,to,status:'accepted'}
}
const entry = process.argv[1]
if (entry && existsSync(entry) && pathToFileURL(realpathSync(entry)).href === import.meta.url) {
  const [action, dest, text, from, project]=process.argv.slice(2)
  if(action==='antigravity-request') {
    const request=JSON.parse(readFileSync(0,'utf8'))
    if(!String(request.from).startsWith('antigravity/')) throw Error('需要 Antigravity 来源')
    const proof = request.proof
    if (!proof || !uuid.test(proof.session) || !Number.isSafeInteger(proof.step) ||
        proof.step < 1 || request.from !== 'antigravity/' + proof.session) throw Error('缺少有效宿主来源')
    const verifier = fileURLToPath(new URL('./antigravity_provenance.py', import.meta.url))
    const linux = '/mnt/' + verifier[0].toLowerCase() + verifier.slice(2).replaceAll('\\','/')
    const check = spawnSync('wsl.exe', ['-d','Ubuntu','--','python3',linux,'verify'], {
      input:JSON.stringify(request), encoding:'utf8', timeout:18000, windowsHide:true
    })
    if (check.status !== 0) throw Error('宿主会话记录与请求不匹配，已停止投递')
    mkdirSync(root, {recursive:true, mode:0o700})
    record(proof.session + '-' + proof.step, '.claimed', {at:new Date().toISOString()})
    console.log(JSON.stringify(await routeMessage(request, {}, verifiedAntigravity)))
  } else {
    const field = {send:'to', reply:'replyTo', broadcast:'group'}[action]
    if (!['send','reply','broadcast'].includes(action)) throw Error('请选择 send、reply 或 broadcast')
    console.log(JSON.stringify(await routeMessage({[field]:dest, text, from, project})))
  }
}
