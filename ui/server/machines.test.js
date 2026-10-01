import test from 'node:test'
import assert from 'node:assert/strict'
import { createMachineStore, machineName, createMachineManager } from './machines.js'
function database() {
 const data=new Map();let queue=Promise.resolve()
 const ref=path=>({path,get:async()=>({exists:data.has(path),data:()=>structuredClone(data.get(path))})})
 return {collection:name=>({doc:id=>ref(`${name}/${id}`)}),runTransaction:fn=>{const result=queue.then(()=>fn({get:r=>r.get(),set:(r,v)=>data.set(r.path,structuredClone(v)),update:(r,v)=>data.set(r.path,{...data.get(r.path),...structuredClone(v)})}));queue=result.catch(()=>{});return result}}
}
test('concurrent requests reserve one deterministic VM and one fleet slot per UID',async()=>{
 const store=createMachineStore(database(),{maxMachines:2})
 const records=await Promise.all(Array.from({length:20},()=>store.reserve({uid:'alice',email:'a@example.com'})))
 assert.equal(new Set(records.map(r=>r.key)).size,1);assert.equal(records[0].name,machineName('alice'))
 await store.reserve({uid:'bob'})
 await assert.rejects(store.reserve({uid:'charlie'}),{status:503})
 assert.equal((await store.reserve({uid:'alice'})).name,records[0].name)
})
test('parallel ensure calls create one VM, no credentials are returned to the browser',async()=>{
 const store=createMachineStore(database(),{maxMachines:1});let creates=0,exists=false
 const compute={get:async()=>exists?{status:'RUNNING',labels:{openrod_owner:machineName('alice').slice(9)},networkInterfaces:[{networkIP:'10.80.0.9'}]}:null,create:async()=>{creates++;exists=true}}
 const manager=createMachineManager(store,compute,{ready:async()=>true})
 await Promise.all(Array.from({length:10},()=>manager.ensure({uid:'alice'})))
 const result=await manager.status({uid:'alice'})
 assert.equal(creates,1);assert.equal(result.status,'ready');assert.equal(result.key,undefined);assert.equal(result.address,undefined)
})
