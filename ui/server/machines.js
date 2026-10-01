import http from 'node:http'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { signWorkerRequest } from './worker-auth.js'
export const MACHINE_DATABASE='openrod-cloud'
const fail=(message,status=503)=>Object.assign(Error(message),{status})
export function machineName(uid) {
 if(typeof uid!=='string'||!uid||uid.length>128)throw fail('Invalid account',400)
 return `openrod-user-${createHash('sha256').update(uid).digest('hex').slice(0,24)}`
}
export function createMachineStore(db,{maxMachines=10,now=()=>Date.now()}={}) {
 if(!Number.isInteger(maxMachines)||maxMachines<1||maxMachines>100)throw Error('Fleet limit must be between 1 and 100')
 const ref=uid=>db.collection('machines').doc(machineName(uid))
 return {
  async reserve(identity) {
   const document=ref(identity.uid),fleet=db.collection('control').doc('fleet')
   return db.runTransaction(async tx=>{
    const current=await tx.get(document)
    if(current.exists){const record=current.data();if(record.uid!==identity.uid)throw fail('Machine ownership mismatch',403);return record}
    const counter=await tx.get(fleet),count=counter.exists?counter.data().count:0
    if(!Number.isInteger(count)||count<0||count>=maxMachines)throw fail('Cloud capacity is full. Please try again later.')
    const record={uid:identity.uid,email:identity.email??null,name:machineName(identity.uid),key:randomBytes(32).toString('hex'),requestId:randomUUID(),createdAt:now(),state:'provisioning',leaseUntil:0}
    tx.set(document,record);tx.set(fleet,{count:count+1});return record
   })
  },
  async get(uid){const result=await ref(uid).get();return result.exists?result.data():null},
  async byName(name){if(!/^openrod-user-[a-f0-9]{24}$/.test(name))return null;const r=await db.collection('machines').doc(name).get();return r.exists?r.data():null},
  async lease(uid){return db.runTransaction(async tx=>{const r=ref(uid),s=await tx.get(r);if(!s.exists||s.data().leaseUntil>now())return false;tx.update(r,{leaseUntil:now()+120000});return true})},
  async update(uid,values){return db.runTransaction(async tx=>{const r=ref(uid);await tx.get(r);tx.update(r,values)})},
 }
}
export function workerReady(record,address,{port=4600,host=process.env.OPENROD_PUBLIC_ORIGIN?new URL(process.env.OPENROD_PUBLIC_ORIGIN).host:'cloud.example.com',timeoutMs=5000,requestProbe=http.request}={}) {
 const request={method:'GET',url:'/api/os/overview'}
 return new Promise(resolve=>{
  let settled=false,deadline
  const finish=ready=>{if(settled)return;settled=true;clearTimeout(deadline);resolve(ready)}
  const probe=requestProbe({hostname:address,port,path:request.url,method:request.method,headers:{host,'x-openrod-worker-auth':signWorkerRequest(record.key,{uid:record.uid,expires:Date.now()+60000},request)}},response=>{response.resume();finish(response.statusCode===200)})
  // Socket inactivity does not include DNS or a pending connection. Bound the
  // entire probe so an unreachable worker cannot hold a provisioning lease.
  deadline=setTimeout(()=>{finish(false);probe.destroy()},timeoutMs)
  probe.setTimeout(timeoutMs,()=>{finish(false);probe.destroy()})
  probe.on('error',()=>finish(false))
  probe.on('close',()=>finish(false))
  probe.end()
 })
}
export function createMachineManager(store,compute,{ready=workerReady}={}) {
 const inflight=new Map(),readyCache=new Map()
 async function ensure(identity) {
  const cached=readyCache.get(identity.uid)
  if(cached && cached.until>Date.now())return cached.record
  if(inflight.has(identity.uid))return inflight.get(identity.uid)
  const task=(async()=>{
   const record=await store.reserve(identity)
   if(!await store.lease(identity.uid))return record
   try{
    const instance=await compute.get(record.name)
    if(!instance) {
     if(record.everReady)throw fail('Your machine is missing. Contact your ShellOS administrator.')
     await compute.create(record)
     await store.update(identity.uid,{state:'provisioning',error:null})
    }else {
     if(instance.labels?.openrod_owner!==record.name.slice(9))throw fail('Machine ownership mismatch',403)
     const address=instance.networkInterfaces?.[0]?.networkIP
     if(address&&!/^10\.80\.0\.\d{1,3}$/.test(address))throw fail('Unexpected worker address')
     const isReady=instance.status==='RUNNING'&&address&&await ready(record,address)
     const stalled=!isReady && Date.now()-record.createdAt>30*60000
     await store.update(identity.uid,{state:isReady?'ready':stalled?'error':'provisioning',address:address??null,everReady:Boolean(record.everReady||isReady),error:stalled?'Machine startup is taking longer than expected. Contact your ShellOS administrator.':null})
    }
   }catch(error){await store.update(identity.uid,{state:'error',error:'Machine provisioning failed. Try again or contact your ShellOS administrator.'});console.error(JSON.stringify({event:'openrod.provision.failed',machine:record.name,error:error.message}));throw error}
   finally{await store.update(identity.uid,{leaseUntil:0})}
   const result=await store.get(identity.uid)
   if(result.state==='ready')readyCache.set(identity.uid,{record:result,until:Date.now()+30000})
   return result
  })()
  inflight.set(identity.uid,task)
  try{return await task}finally{inflight.delete(identity.uid)}
 }
 return {store,ensure,async status(identity){const r=await ensure(identity);return {name:r.name,status:r.state,error:r.error??null}},async target(identity){const r=await ensure(identity);if(r.state!=='ready'||!r.address)throw fail('Your cloud machine is starting. Please try again shortly.');return r}}
}
export async function firebaseMachines(config) {
 const { getApps }=await import('firebase-admin/app'),{getFirestore}=await import('firebase-admin/firestore')
 const { createCompute }=await import('./compute.js')
 return createMachineManager(createMachineStore(getFirestore(getApps()[0],MACHINE_DATABASE),{maxMachines:Number(process.env.OPENROD_MAX_MACHINES??10)}),await createCompute(config))
}
