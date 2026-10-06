import http from 'node:http'
import { randomBytes, randomUUID } from 'node:crypto'
import { signWorkerRequest } from './worker-auth.js'
import { workerPrefix, workerAuthHeader, workerOwnerHash } from './cloud-deployment.js'
const fail=(message,status=503)=>Object.assign(Error(message),{status})
export function machineName(uid,prefix='openrod-user') {
 return `${workerPrefix(prefix)}-${workerOwnerHash(uid)}`
}
export function createMachineStore(db,{maxMachines=10,now=()=>Date.now(),prefix='openrod-user'}={}) {
 workerPrefix(prefix)
 if(!Number.isInteger(maxMachines)||maxMachines<1||maxMachines>100)throw Error('Fleet limit must be between 1 and 100')
 const ref=uid=>db.collection('machines').doc(machineName(uid,prefix))
 return {
  async reserve(identity) {
   const document=ref(identity.uid),fleet=db.collection('control').doc('fleet')
   return db.runTransaction(async tx=>{
    const current=await tx.get(document)
    if(current.exists){const record=current.data();if(record.uid!==identity.uid)throw fail('Machine ownership mismatch',403);return record}
    const counter=await tx.get(fleet),count=counter.exists?counter.data().count:0
    if(!Number.isInteger(count)||count<0||count>=maxMachines)throw fail('Cloud capacity is full. Please try again later.')
    const record={uid:identity.uid,email:identity.email??null,name:machineName(identity.uid,prefix),key:randomBytes(32).toString('hex'),requestId:randomUUID(),createdAt:now(),state:'provisioning',leaseUntil:0}
    tx.set(document,record);tx.set(fleet,{count:count+1});return record
   })
  },
  async get(uid){const result=await ref(uid).get();return result.exists?result.data():null},
  async byName(name){if(!new RegExp(`^${prefix}-[a-f0-9]{24}$`).test(name))return null;const r=await db.collection('machines').doc(name).get();return r.exists?r.data():null},
  async lease(uid){return db.runTransaction(async tx=>{const r=ref(uid),s=await tx.get(r);if(!s.exists||s.data().leaseUntil>now())return false;tx.update(r,{leaseUntil:now()+120000});return true})},
  async update(uid,values){return db.runTransaction(async tx=>{const r=ref(uid);await tx.get(r);tx.update(r,values)})},
 }
}
export function workerReady(record,address,{port=4600,protocol='current',host=new URL(process.env.OPENROD_PUBLIC_ORIGIN||process.env.OPENROD_CLOUD_ORIGIN||'https://localhost').host,timeoutMs=5000,requestProbe=http.request}={}) {
 const request={method:'GET',url:'/api/os/overview'}
 return new Promise(resolve=>{
  let settled=false,deadline
  const finish=ready=>{if(settled)return;settled=true;clearTimeout(deadline);resolve(ready)}
  const probe=requestProbe({hostname:address,port,path:request.url,method:request.method,headers:{host,[workerAuthHeader(protocol)]:signWorkerRequest(record.key,{uid:record.uid,expires:Date.now()+60000},request)}},response=>{response.resume();finish(response.statusCode===200)})
  // Socket inactivity does not include DNS or a pending connection. Bound the
  // entire probe so an unreachable worker cannot hold a provisioning lease.
  deadline=setTimeout(()=>{finish(false);probe.destroy()},timeoutMs)
  probe.setTimeout(timeoutMs,()=>{finish(false);probe.destroy()})
  probe.on('error',()=>finish(false))
  probe.on('close',()=>finish(false))
  probe.end()
 })
}
export function createMachineManager(store,compute,{ready=workerReady,ownerLabel='openrod_owner',allowProvisioning=true}={}) {
 const inflight=new Map(),readyCache=new Map()
 async function ensure(identity,{provision=true}={}) {
  const cached=readyCache.get(identity.uid)
  if(cached && cached.until>Date.now())return cached.record
  const pending=inflight.get(identity.uid)
  if(pending){
   const result=await pending.task
   // An explicit prepare arriving during a read-only inspection must retain
   // its intent. Retry after that inspection releases the per-owner lease.
   if(provision&&!pending.provision){if(inflight.get(identity.uid)===pending)inflight.delete(identity.uid);return ensure(identity,{provision:true})}
   return result
  }
  const task=(async()=>{
   const existing=await store.get(identity.uid)
   if(!existing&&provision&&!allowProvisioning)throw fail('New cloud environments are temporarily unavailable during deployment.')
   const record=existing??(provision?await store.reserve(identity):null)
   if(!record)return null
   if(record.uid!==identity.uid)throw fail('Machine ownership mismatch',403)
   if(!await store.lease(identity.uid))return record
   try{
    const instance=await compute.get(record.name)
    if(!instance) {
     if(record.everReady)throw fail('Your machine is missing. Contact your OpenRod administrator.')
     if(!provision)return record
     if(!allowProvisioning)throw fail('Cloud provisioning is temporarily unavailable during deployment.')
     await compute.create(record)
     await store.update(identity.uid,{state:'provisioning',error:null})
    }else {
     if(instance.labels?.[ownerLabel]!==workerOwnerHash(record.uid))throw fail('Machine ownership mismatch',403)
     const address=instance.networkInterfaces?.[0]?.networkIP
     if(address&&!/^10\.80\.0\.\d{1,3}$/.test(address))throw fail('Unexpected worker address')
     const isReady=instance.status==='RUNNING'&&address&&await ready(record,address)
     const stalled=!isReady && Date.now()-record.createdAt>30*60000
     await store.update(identity.uid,{state:isReady?'ready':stalled?'error':'provisioning',address:address??null,everReady:Boolean(record.everReady||isReady),error:stalled?'Machine startup is taking longer than expected. Contact your OpenRod administrator.':null})
    }
   }catch(error){await store.update(identity.uid,{state:'error',error:'Machine provisioning failed. Try again or contact your OpenRod administrator.'});console.error(JSON.stringify({event:'openrod.provision.failed',machine:record.name,error:error.message}));throw error}
   finally{await store.update(identity.uid,{leaseUntil:0})}
   const result=await store.get(identity.uid)
   if(result.state==='ready')readyCache.set(identity.uid,{record:result,until:Date.now()+30000})
   return result
  })()
  const entry={task,provision};inflight.set(identity.uid,entry)
  try{return await task}finally{if(inflight.get(identity.uid)===entry)inflight.delete(identity.uid)}
 }
 const publicStatus=r=>({name:r?.name??null,status:r?.state??'none',error:r?.error??null})
 return {store,ensure,async status(identity){return publicStatus(await ensure(identity,{provision:false}))},async prepare(identity){return publicStatus(await ensure(identity))},async target(identity,{provision=true}={}){const r=await ensure(identity,{provision});if(!r)throw fail('Prepare your cloud environment before using this resource.',409);if(r.state!=='ready'||!r.address)throw fail('Your cloud machine is starting. Please try again shortly.');return r}}
}
