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
 const compute={get:async()=>exists?{status:'RUNNING',labels:{openrod_owner:'2bd806c97f0e00af1a1fc332'},networkInterfaces:[{networkIP:'10.80.0.9'}]}:null,create:async()=>{creates++;exists=true}}
 const manager=createMachineManager(store,compute,{ready:async()=>true})
 await Promise.all(Array.from({length:10},()=>manager.ensure({uid:'alice'})))
 const result=await manager.status({uid:'alice'})
 assert.equal(creates,1);assert.equal(result.status,'ready');assert.equal(result.key,undefined);assert.equal(result.address,undefined)
})

test('worker ownership verification is independent of the configured resource prefix',async()=>{
 for(const prefix of ['openrod-user','legacy-user','my-company-worker']){
  const store=createMachineStore(database(),{prefix})
  await store.reserve({uid:'alice'})
  const manager=createMachineManager(store,{get:async()=>({status:'RUNNING',labels:{openrod_owner:'2bd806c97f0e00af1a1fc332'},networkInterfaces:[{networkIP:'10.80.0.9'}]})},{ready:async()=>true})
  assert.equal((await manager.status({uid:'alice'})).status,'ready')
 }
})

test('status and resource reads never reserve a machine or recreate a failed reservation',async()=>{
 const store=createMachineStore(database(),{maxMachines:1});let creates=0
 const manager=createMachineManager(store,{get:async()=>null,create:async()=>{creates++}})
 assert.deepEqual(await manager.status({uid:'alice'}),{name:null,status:'none',error:null})
 assert.equal(await store.get('alice'),null)
 await assert.rejects(manager.target({uid:'alice'},{provision:false}),{status:409})
 await store.reserve({uid:'alice'})
 assert.equal((await manager.status({uid:'alice'})).status,'provisioning')
 assert.equal(creates,0)
 await manager.prepare({uid:'alice'})
 assert.equal(creates,1)
})

test('configured legacy fleet identity reuses its existing owner record without creating a second VM',async()=>{
 const db=database(),store=createMachineStore(db,{prefix:'legacy-user',maxMachines:1})
 const original=await store.reserve({uid:'alice'})
 assert.equal(original.name,machineName('alice','legacy-user'))
 let creates=0
 const manager=createMachineManager(createMachineStore(db,{prefix:'legacy-user',maxMachines:1}),{get:async()=>({status:'RUNNING',labels:{legacy_owner:original.name.slice(9)},networkInterfaces:[{networkIP:'10.80.0.3'}]}),create:async()=>{creates++}},{ownerLabel:'legacy_owner',allowProvisioning:false,ready:async()=>true})
 assert.equal((await manager.prepare({uid:'alice'})).status,'ready')
 assert.equal((await store.get('alice')).key,original.key)
 await assert.rejects(manager.prepare({uid:'bob'}),/temporarily unavailable/)
 assert.equal(await store.get('bob'),null)
 assert.equal(await store.byName(machineName('alice')),null)
 assert.equal(creates,0)
})

test('explicit prepare arriving during an empty status read still allocates exactly once',async()=>{
 const store=createMachineStore(database()),read=store.get
 let release,creates=0,first=true
 store.get=async uid=>{if(first){first=false;await new Promise(resolve=>{release=resolve})}return read(uid)}
 const manager=createMachineManager(store,{get:async()=>null,create:async()=>{creates++}})
 const status=manager.status({uid:'alice'})
 const prepare=manager.prepare({uid:'alice'})
 release()
 assert.equal((await status).status,'none')
 assert.equal((await prepare).status,'provisioning')
 assert.equal(creates,1)
})

test('readiness probe preserves the public Host and signed worker identity',async()=>{
 const {default:http}=await import('node:http')
 const {verifyWorkerRequest}=await import('./worker-auth.js')
 const key='a'.repeat(64)
 const server=http.createServer((req,res)=>{
  assert.equal(req.headers.host,'cloud.example.test')
  assert.equal(verifyWorkerRequest(key,'alice',req).uid,'alice')
  res.end('{}')
 })
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
 try{assert.equal(await workerReady({uid:'alice',key},'127.0.0.1',{port:server.address().port,host:'cloud.example.test'}),true)}finally{await new Promise(resolve=>server.close(resolve))}
})
