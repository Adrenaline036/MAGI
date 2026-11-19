import assert from 'node:assert/strict'
import fs from 'node:fs'
import {EventEmitter} from 'node:events'
import {PassThrough, Writable} from 'node:stream'
import {sendDesktopMessage} from './lib/codex-desktop-delivery.mjs'
const manifest = JSON.parse(fs.readFileSync(new URL('./package.json',import.meta.url)))
const child = new EventEmitter()
child.stdout=new PassThrough()
child.stderr=new PassThrough()
child.kill=()=>{}
const requests=[]
child.stdin=new Writable({write(bytes,enc,done){
  const request=JSON.parse(bytes.toString())
  requests.push(request)
  if(request.id)queueMicrotask(()=>child.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result:{content:[]}})+'\n'))
  done()
}})
const thread='00000000-0000-0000-0000-000000000001'
await sendDesktopMessage({thread,message:'离线验收',target:{thread,pipe:'mock',server:'mock'},spawnImpl:()=>child})
assert.equal(requests[0].params.clientInfo.version,manifest.version)
assert.equal(requests.filter(r=>r.method==='tools/call').length,1)
console.log('桌面握手版本',manifest.version,'；仅投递一次')