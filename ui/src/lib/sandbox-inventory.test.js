import test from 'node:test'
import assert from 'node:assert/strict'
import * as inventory from './sandbox-inventory.js'
import {copyCloudSandboxToLocal} from './local-cloud.js'

test('combined inventory preserves identical local/cloud names and IDs independently',()=>{
 const rows=inventory.mergeSandboxInventories({local:[{id:'same',name:'demo'}],cloud:[{id:'same',name:'demo'}]})
 assert.equal(rows.length,2);assert.notEqual(inventory.sandboxInventoryKey(rows[0]),inventory.sandboxInventoryKey(rows[1]))
 assert.deepEqual(rows.map(s=>s.computeTarget),['local','cloud'])
})
test('mixed inventory actions stay pinned to each row rather than selected compute',async()=>{
 const paths=[],oldFetch=globalThis.fetch
 globalThis.fetch=async path=>{paths.push(path);return {ok:true,json:async()=>({})}}
 try{
  for(const computeTarget of ['local','cloud'])await inventory.sandboxInventoryApi({computeTarget},true).lifecycle('demo','delete')
  await inventory.sandboxInventoryApi({computeTarget:'cloud'},false).sandbox('demo')
  assert.deepEqual(paths,['/api/os/sandboxes/demo/delete','/api/remote/os/sandboxes/demo/delete','/api/os/sandboxes/demo'])
 }finally{globalThis.fetch=oldFetch}
})
test('cloud workspace import uses only the local destination and waits for its runnable result',async()=>{
 const calls=[],bundle={version:1,files:[]},cloud={cloudExport:async name=>{calls.push(['export',name]);return {bundle,warning:'Reconnect agents'}}},local={target:'local',importCloud:async value=>{calls.push(['import',value]);return {name:'local-copy'}}}
 const result=await copyCloudSandboxToLocal(cloud,local,'demo')
 assert.equal(result.name,'local-copy');assert.equal(result.warning,'Reconnect agents');assert.deepEqual(calls,[['export','demo'],['import',bundle]])
 await assert.rejects(copyCloudSandboxToLocal(cloud,{...local,target:'cloud'},'demo'),/local/)
})
