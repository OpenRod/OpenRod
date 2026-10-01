import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { buildPackage, packageLocation, packageRuntimeRequirements } from './setup-packages.js'
import { discoverSignIn } from './setup-auth-discovery.js'
import { checkRemote } from './setup-remote-check.js'
import { connectCredentials } from './setup-credentials.js'
import { canPrepareAtLaunch } from '../shared/setup-launch.js'
import { fail, publicItem, hash } from './setup-discovery.js'
import { readOrg, blockedBy } from './org.js'
import { listPolicies, blockedByPolicy } from './egress.js'
import { hostMatches } from '../src/lib/egress.js'

const DIR=path.resolve(import.meta.dirname,'../.state/setup-preparations')
const state=globalThis[Symbol.for('openshell.setup.preparation.v1')]??={jobs:new Map(),controllers:new Map()}
const valid=(id)=>{if(!/^[a-f0-9-]{36}$/.test(id))throw fail('Unknown preparation.',404);return path.join(DIR,id+'.json')}
const publicJob=({preparedItems,...job})=>job
const persist=async(job)=>{await fs.mkdir(DIR,{recursive:true,mode:0o700});const p=valid(job.id),tmp=p+'.tmp';await fs.writeFile(tmp,JSON.stringify(job),{mode:0o600});await fs.rename(tmp,p)}
export async function preparationStatus(id){
 if(state.jobs.has(id))return publicJob(state.jobs.get(id))
 let job;try{job=JSON.parse(await fs.readFile(valid(id),'utf8'))}catch(e){if(e.code==='ENOENT')throw fail('Unknown preparation.',404);throw e}
 if((job.status==='complete'&&!job.setup)||job.status==='cancelled'){job.status='interrupted';job.message='The console restarted. Re-scan or prepare the saved Setup again; package artifacts and gateway credentials were retained.';delete job.review}
 if(job.status==='running')return {...publicJob(job),status:'interrupted',message:'The console restarted. Review the selection again; completed package artifacts were retained.'}
 return publicJob(job)
}
export async function cancelPreparation(id){const controller=state.controllers.get(id);if(controller)controller.abort();return {cancelled:!!controller}}
export function runtimeRequirements(hosts){
 if(!Array.isArray(hosts)||hosts.length>20)throw fail('Add up to 20 exact runtime hosts.')
 return [...new Set(hosts.map(h=>String(h).trim()).filter(Boolean))].map(host=>{
  if(!/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$/i.test(host)||host.includes('..')||host.includes('*')||host.endsWith('.local'))throw fail('Runtime hosts must be exact public DNS names. Private services require a connection adapter.')
  return {phase:'runtime',host:host.toLowerCase(),port:443,reason:'Operator-reviewed runtime destination.'}
 })
}
export function clearPreparationIssues(item) {
 const previous = new Set(item.preparationIssues || [])
 return { ...item, issues: item.issues.filter(issue => !previous.has(issue)), preparationIssues: [] }
}
export async function prepareLaunch(store, id, input) {
 const source = await store.get(id)
 if (input.revision !== source.revision) throw fail('Setup changed. Review the selection again.',409)
 if (!source.items.some(canPrepareAtLaunch)) return {status:'complete', setup:{...source,items:source.items.map(publicItem)}}
 const cachedId=hash('quick-setup:'+source.id+':'+source.revision).slice(0,24)
 try { const cached=await store.get(cachedId);return {status:'complete',setup:{...cached,items:cached.items.map(publicItem)}} }
 catch(e){if(e.status!==404)throw e}
 const review=store.stage(source.items)
 return prepareImport(store,{token:review.token,approved:true},{source,packagesOnly:true})
}
export async function prepareImport(store,input,{source,packagesOnly=false}={}){
 if(input.approved!==true)throw fail('Review and approve preparation and requested access first.')
 const preview=store.preview(input.token)
 if([...state.controllers.values()].length>=2)throw fail('Two imports are already preparing. Wait or cancel one.',429)
 const choices=input.items||{}
 const org=await readOrg(),scoped=await listPolicies()
 const items=preview.items.map(original=>{
   if(packagesOnly&&!canPrepareAtLaunch(original))return original
   const item=clearPreparationIssues(original)
   const extra=[...packageRuntimeRequirements(item.package),...runtimeRequirements(choices[item.id]?.hosts||[])]
   const requirements=[...item.requirements,...extra.filter(r=>!item.requirements.some(o=>o.host===r.host&&o.phase===r.phase))]
   const blocked=requirements.find(r=>blockedBy(org,[r.host])||blockedByPolicy(scoped,{name:'',group:null},[r.host],hostMatches))
   const preparationIssues=blocked?[`Organization or global Egress policy blocks ${blocked.host}.`]:[]
   return {...item,requirements,preparationIssues,issues:blocked?[...item.issues,`Organization or global Egress policy blocks ${blocked.host}.`]:item.issues,preparationBlocked:!!blocked}
 })
 const id=randomUUID(),controller=new AbortController()
 const job={id,status:'running',createdAt:new Date().toISOString(),message:'Preparing selected tools',items:items.map(publicItem)}
 state.jobs.set(id,job);state.controllers.set(id,controller);await persist(job)
 void(async()=>{
   const prepared=[]
   for(const original of items){
     if(controller.signal.aborted)break
     let item=structuredClone(original)
     try{
       if(!item.preparationBlocked&&!item.disabled&&(!packagesOnly||canPrepareAtLaunch(item))){
         if(item.package&&!item.artifact){
           const artifact=await buildPackage(item.package,{signal:controller.signal,progress:async(message)=>{job.message=`${item.name}: ${message}`;await persist(job)}})
           item={...item,artifact,config:{command:'node',args:[`${packageLocation(artifact)}/${artifact.bin}`,...artifact.args],...(item.environment?{env:item.environment}:{})},issues:item.issues.filter(i=>!i.startsWith('Prepare package'))}
         }
         if(item.credentialFields?.length&&(choices[item.id]?.useSourceSecrets||choices[item.id]?.provider||Object.values(choices[item.id]?.secrets||{}).some(Boolean))){
           item=await connectCredentials(item,choices[item.id],preview.credentials?.[item.id])
         }
         if(!packagesOnly&&item.config?.url&&!item.credentialFields?.length){
           job.message=`${item.name}: Checking connection in an isolated sandbox`;await persist(job)
           item.verification=await checkRemote(item,controller.signal)
           item.issues=item.issues.filter(i=>!i.startsWith('Account sign-in')&&!i.startsWith('Connection check'))
           if(item.verification.status==='needs-sign-in') item=await discoverSignIn(item)
           else if(item.verification.status!=='connected')item.issues.push('Connection check did not pass. Review the account and runtime destinations, then retry.')
         }
       }
     }catch(e){const message=e.status?e.message:'Preparation failed. Retry this item; no imported code ran on your computer.';item.preparationIssues=[message];item.issues=[...item.issues.filter(i=>!i.startsWith('Prepare package')),message]}
     item.state=item.disabled?'disabled':item.issues.length?'needs-attention':item.auth?.mode==='agent-session'?'sign-in-in-sandbox':'prepared'
     prepared.push(item);job.preparedItems=[...prepared,...items.slice(prepared.length)];job.items=job.preparedItems.map(publicItem);await persist(job)
   }
   if(controller.signal.aborted){job.status='cancelled';job.message='Preparation cancelled. Completed items are retained for review; destination sandboxes were not modified.';job.review=store.stage(job.preparedItems||items,preview.credentials)}
   else if(packagesOnly){
     const failed=prepared.find(item=>source.items.some(old=>old.id===item.id&&canPrepareAtLaunch(old))&&(!item.artifact||item.issues.length))
     if(failed){job.status='failed';job.message=`${failed.name}: ${failed.issues.join(' ') || 'Package preparation failed.'}`}
     else{job.setup=await store.buildSnapshot(source,prepared);job.status='complete';job.message='MCP packages prepared. Baking the sandbox image…'}
   }
   else{job.status='complete';job.message='Review the prepared items. Items needing attention remain inactive.';job.review=store.stage(prepared,preview.credentials)}
   await persist(job)
 })().catch(async()=>{job.status='failed';job.message='Preparation failed. Retry the import.';await persist(job)}).finally(()=>state.controllers.delete(id))
 return publicJob(job)
}
