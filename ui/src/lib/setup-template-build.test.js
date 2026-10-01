import test from 'node:test'
import assert from 'node:assert/strict'
import { buildTemplateWithSetups } from './setup-template-build.js'
import { newRecipe } from './image-templates.js'

const source={id:'a'.repeat(24),revision:'b'.repeat(64),name:'My MCPs'}
const prepared={id:'c'.repeat(24),revision:'d'.repeat(64)}
test('new builds and existing-image templates prepare MCPs before baking without changing recipe choices',async()=>{
 for(const kind of ['build','image']){
  const calls=[]
  const recipe=newRecipe({name:'my-template',source:kind,image:'local/base:test',agents:['codex'],setups:[source.id],environment:[{name:'MODE',value:'test'}],setup:'echo ready'})
  const result=await buildTemplateWithSetups({
   setups:async()=>[source],
   prepareLaunchSetup:async()=>{calls.push('prepare');return {id:'job',status:'running'}},
   setupPreparation:async()=>({status:'complete',setup:prepared}),
   buildImageTemplate:async(value,replace)=>{calls.push('build');assert.equal(replace,true);assert.deepEqual(value,{...recipe,setups:[prepared.id],setupRevisions:{[prepared.id]:prepared.revision}});return {name:value.name,status:'building'}},
  },recipe,true,{wait:async()=>{}})
  assert.deepEqual(calls,['prepare','build']);assert.equal(result.status,'building')
 }
})
test('failed preparation and changed pinned revisions stop template builds',async()=>{
 const recipe=newRecipe({name:'failed',setups:[source.id]})
 const api={setups:async()=>[source],prepareLaunchSetup:async()=>({status:'failed',message:'Registry denied'}),buildImageTemplate:()=>assert.fail('must not build')}
 await assert.rejects(buildTemplateWithSetups(api,recipe,false),/Registry denied/)
 await assert.rejects(buildTemplateWithSetups(api,{...recipe,setupRevisions:{[source.id]:'e'.repeat(64)}},true),/changed/)
})
test('cancelled package preparation cancels its job without submitting an image build',async()=>{
 const controller=new AbortController();let cancelled=false
 await assert.rejects(buildTemplateWithSetups({
  setups:async()=>[source],prepareLaunchSetup:async()=>({id:'job',status:'running'}),
  cancelSetupPreparation:async id=>{assert.equal(id,'job');cancelled=true},
  buildImageTemplate:()=>assert.fail('must not build'),
 },newRecipe({name:'cancelled',setups:[source.id]}),false,{signal:controller.signal,wait:async()=>controller.abort()}),{name:'AbortError'})
 assert.equal(cancelled,true)
})
