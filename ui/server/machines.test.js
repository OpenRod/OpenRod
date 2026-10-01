import test from 'node:test'
import assert from 'node:assert/strict'
import { createMachineStore, machineName, createMachineManager, workerReady } from './machines.js'
import { EventEmitter } from 'node:events'
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

test('readiness has an overall deadline while the connection is still pending',async()=>{
 const probe=new EventEmitter(),timeoutMs=30
 let inactivityTimeout,destroyed=false
 probe.setTimeout=(duration,callback)=>{inactivityTimeout={duration,callback};return probe}
 probe.end=()=>{}
 // A connecting socket may never start Node's inactivity timer or emit error.
 probe.destroy=()=>{destroyed=true}
 const started=Date.now()
 const result=await Promise.race([
  workerReady({uid:'alice',key:'a'.repeat(64)},'10.80.0.9',{timeoutMs,requestProbe:()=>probe}),
  new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('Pending connection exceeded readiness deadline')),500);timer.unref()}),
 ])
 assert.equal(result,false)
 assert.equal(destroyed,true)
 assert.equal(inactivityTimeout.duration,timeoutMs)
 assert.ok(Date.now()-started<500)
})

test('completed readiness clears its overall timer instead of destroying a successful connection',async()=>{
 const probe=new EventEmitter()
 let callback,destroyed=false,resumed=false
 probe.setTimeout=()=>probe;probe.end=()=>queueMicrotask(()=>callback({statusCode:200,resume:()=>{resumed=true}}));probe.destroy=()=>{destroyed=true}
 assert.equal(await workerReady({uid:'alice',key:'a'.repeat(64)},'10.80.0.9',{timeoutMs:20,requestProbe:(_options,onResponse)=>{callback=onResponse;return probe}}),true)
 await new Promise(resolve=>setTimeout(resolve,40))
 assert.equal(resumed,true)
 assert.equal(destroyed,false)
})
test('parallel ensure calls create one VM, no credentials are returned to the browser',async()=>{
 const store=createMachineStore(database(),{maxMachines:1});let creates=0,exists=false
 const compute={get:async()=>exists?{status:'RUNNING',labels:{openrod_owner:machineName('alice').slice(9)},networkInterfaces:[{networkIP:'10.80.0.9'}]}:null,create:async()=>{creates++;exists=true}}
 const manager=createMachineManager(store,compute,{ready:async()=>true})
 await Promise.all(Array.from({length:10},()=>manager.ensure({uid:'alice'})))
 const result=await manager.status({uid:'alice'})
 assert.equal(creates,1);assert.equal(result.status,'ready');assert.equal(result.key,undefined);assert.equal(result.address,undefined)
})

test('readiness probe preserves the public Host and signed worker identity',async()=>{
 const {default:http}=await import('node:http')
 const {verifyWorkerRequest}=await import('./worker-auth.js')
 const key='a'.repeat(64)
 const server=http.createServer((req,res)=>{
  assert.equal(req.headers.host,'cloud.example.com')
  assert.equal(verifyWorkerRequest(key,'alice',req).uid,'alice')
  res.end('{}')
 })
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
 try{assert.equal(await workerReady({uid:'alice',key},'127.0.0.1',{port:server.address().port,host:'cloud.example.com'}),true)}finally{await new Promise(resolve=>server.close(resolve))}
})
