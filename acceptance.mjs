import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {randomUUID} from 'node:crypto'
import {pathToFileURL} from 'node:url'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'magi-accept-'))
process.env.DSH_HOME = home
process.env.USERPROFILE = home
delete process.env.CODEX_THREAD_ID
delete process.env.DSH_SESSION_ID
delete process.env.MAGI_CODEX_THREAD
delete process.env.MAGI_ROUTING
const dir = process.argv[2] || process.cwd()
const load = file => import(pathToFileURL(path.join(dir, 'lib', file)).href)
const routing = await load('routing.js')
const project = path.join(home, 'workspace')
const id = 'session-' + randomUUID()
fs.mkdirSync(path.join(home,'sessions', routing.workspaceSlug(project), id), {recursive:true})
const registry = {version:1, projects:{[routing.normaliseProject(project)]:{node:'test',routes:{test:id}}}}
fs.writeFileSync(path.join(home,'collab-routing.json'), JSON.stringify(registry))
assert.deepEqual(routing.loadRegistry(), registry)
let received
const agent = {id, options:{cwd:project}, steer:msg=>{received=msg}}
const {apply} = await load('index.js')
apply({agents:{get:key=>key===id?agent:null, roots:()=>[agent]},effect:fn=>fn()})
const discovery = path.join(home,'magi.json')
for(let i=0;i<100 && !fs.existsSync(discovery);i++) await new Promise(resolve=>setTimeout(resolve,25))
const cfg=JSON.parse(fs.readFileSync(discovery))
const health=await (await fetch('http://127.0.0.1:'+cfg.port+'/health')).json()
assert.equal(health.plugin,'magi')
assert.equal(health.version,'0.10.0')
const from='codex/'+randomUUID()
const {routeMessage}=await load('message.mjs')
const receipt=await routeMessage({from,to:'dsh/'+id,text:'候选包回归',project})
const text=received.content[0].text
assert.ok(text.startsWith('[Codex-DSH]\n候选包回归\n'))
assert.ok(text.includes('reply '+receipt.id))
assert.ok(!text.includes('[CODEX→DSH]'))
const legacy=await fetch('http://127.0.0.1:'+cfg.port+'/ask',{method:'POST',headers:{authorization:'Bearer '+cfg.token,'content-type':'application/json'},body:JSON.stringify({project,session:id,question:'legacy',codex_thread:from.slice(6)})})
assert.equal(legacy.status,202)
assert.ok(received.content[0].text.includes('[CODEX→DSH]'))
console.log('通过：独立发现、版本、旧路由、定向投递、单一回复命令、原接口兼容')
process.exit(0)