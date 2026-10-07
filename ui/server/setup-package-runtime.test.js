import test from 'node:test'
import assert from 'node:assert/strict'
import { preparationImageRuntime } from './image-templates.js'

const target={name:'local-gateway',remote:false}
const status={state:'ok',gateway:target.name,driver:{engineId:'engine'},build:{engineId:'engine'}}
const image='node:22-bookworm-slim@sha256:pinned'
const fixture=(over={})=>{
  const commands=[]
  const execute=async args=>{
    commands.push(args)
    if(args[0]==='context')return JSON.stringify([{Endpoints:{docker:{Host:'unix:///test/docker.sock'}}}])
    if(args[0]==='info')return JSON.stringify({ID:'engine',OSType:'linux',Architecture:'x86_64',...over.engine})
    if(args[0]==='image')return JSON.stringify([{Os:'linux',Architecture:'amd64',Config:{Env:['NODE_VERSION=22.22.0']},...over.image}])
    assert.fail('Runtime lookup must not run or pull an image')
  }
  return {commands,options:{execute,guard:{status:async()=>over.status??status}}}
}
test('trusted pinned image metadata establishes runtime without executing code',async()=>{
  const f=fixture()
  assert.deepEqual(await preparationImageRuntime(target,image,f.options),{node:'22.22.0',arch:'x64',platform:'linux',libc:'glibc'})
  assert.ok(f.commands.some(args=>args[0]==='image'&&args[2]===image))
})
test('unknown or changed gateway engines cannot enable the cache fast path',async()=>{
  for(const over of [{status:{...status,state:'unknown'}},{status:{...status,gateway:'different'}},{engine:{ID:'changed'}}]) {
    const f=fixture(over)
    assert.equal(await preparationImageRuntime(target,image,f.options),null)
    assert.ok(!f.commands.some(args=>args[0]==='image'))
  }
})
test('missing Node metadata or mismatched image architecture cannot establish runtime',async()=>{
  assert.equal(await preparationImageRuntime(target,image,fixture({image:{Config:{Env:[]}}}).options),null)
  await assert.rejects(preparationImageRuntime(target,image,fixture({image:{Architecture:'arm64'}}).options),/architecture|matching image/)
})
