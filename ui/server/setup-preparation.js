import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { createPackagePreparation, packageLocation, packageRuntimeRequirements } from './setup-packages.js'
import { discoverSignIn } from './setup-auth-discovery.js'
import { checkRemote } from './setup-remote-check.js'
import { connectCredentials } from './setup-credentials.js'
import { canPrepareAtLaunch, isPackagePending } from '../shared/setup-launch.js'
import { fail, publicItem, hash } from './setup-discovery.js'
import { readOrg, blockedBy } from './org.js'
import { listPolicies, blockedByPolicy } from './egress.js'
import { hostMatches } from '../src/lib/egress.js'
import { contextSelection, runWithContext } from './gateway.js'
import { scopedStateDirectory } from './paths.js'

const states=globalThis[Symbol.for('openshell.setup.preparation-contexts.v1')]??=new Map()
function preparationState() {
 const dir=path.join(scopedStateDirectory(),'setup-preparations')
 let state=states.get(dir)
 if(!state){state={jobs:new Map(),controllers:new Map()};states.set(dir,state)}
 return state
}
const valid=(id)=>{if(!/^[a-f0-9-]{36}$/.test(id))throw fail('Unknown preparation.',404);return path.join(scopedStateDirectory(),'setup-preparations',id+'.json')}
const publicJob=({preparedItems,...job})=>job
// Prepared items can hold up to 64 MB of skill files and live only in memory; a restarted job is re-reviewed.
const persist=async(job)=>{const p=valid(job.id),tmp=p+'.'+randomUUID()+'.tmp';await fs.mkdir(path.dirname(p),{recursive:true,mode:0o700});await fs.writeFile(tmp,JSON.stringify(publicJob(job)),{mode:0o600});await fs.rename(tmp,p)}
export async function preparationStatus(id){
 const state=preparationState()
 if(state.jobs.has(id))return publicJob(state.jobs.get(id))
 let job;try{job=JSON.parse(await fs.readFile(valid(id),'utf8'))}catch(e){if(e.code==='ENOENT')throw fail('Unknown preparation.',404);throw e}
 if((job.status==='complete'&&!job.setup)||job.status==='cancelled'){job.status='interrupted';job.message='The console restarted. Re-scan or prepare the saved Setup again; package artifacts and gateway credentials were retained.';delete job.review}
 if(job.status==='running'){delete job.current;return {...publicJob(job),status:'interrupted',message:'The console restarted. Review the selection again; completed package artifacts were retained.'}}
 return publicJob(job)
}
export async function cancelPreparation(id){const controller=preparationState().controllers.get(id);if(controller)controller.abort();return {cancelled:!!controller}}
export function runtimeRequirements(hosts){
 if(!Array.isArray(hosts)||hosts.length>20)throw fail('Add up to 20 exact runtime hosts.')
 return [...new Set(hosts.map(h=>String(h).trim()).filter(Boolean))].map(host=>{
  if(!/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$/i.test(host)||host.includes('..')||host.includes('*')||host.endsWith('.local'))throw fail('Runtime hosts must be exact public DNS names. Private services require a connection adapter.')
  return {phase:'runtime',host:host.toLowerCase(),port:443,reason:'You chose this as where the MCP sends its credentials.'}
 })
}
export function clearPreparationIssues(item) {
 const previous = new Set(item.preparationIssues || [])
 return { ...item, issues: item.issues.filter(issue => !previous.has(issue)), preparationIssues: [] }
}
export const CONNECT_FAILED='Couldn’t connect to this MCP from a sandbox. Check that its URL is right and the server is up, then try the import again.'
// Only an explicit agent OAuth configuration can skip the sandbox check.
// Host-wide metadata also exists for public and token-authenticated endpoints.
export async function checkConnection(item,signal,step=async()=>{},{discover=discoverSignIn,check=checkRemote}={}){
 const agentSignIn=item.auth?.mode==='agent-session'&&!item.credentialRef
 if(agentSignIn){
   await step('Looking up sign-in details')
   item={...await discover(item),verification:{status:'needs-sign-in',reason:'This MCP uses account sign-in. Sign in from the agent inside the sandbox.',checkedAt:new Date().toISOString()}}
 }else{
   await step('Checking the connection in a temporary sandbox')
   item={...item,verification:await check(item,signal)}
   if(item.verification.status==='needs-sign-in'&&!item.credentialRef){await step('Looking up sign-in details');item=await discover(item)}
   // A working dedicated credential must continue through deployment checks.
   if(item.credentialRef&&item.verification.status==='connected')delete item.auth
 }
 item.issues=item.issues.filter(i=>!i.startsWith('Account sign-in')&&!i.startsWith('Connection check')&&i!==CONNECT_FAILED)
 if(item.verification.status!=='connected'&&(item.verification.status!=='needs-sign-in'||item.credentialRef)){
   item.issues.push(CONNECT_FAILED);item.preparationIssues=[...(item.preparationIssues||[]).filter(i=>i!==CONNECT_FAILED),CONNECT_FAILED]
 }
 return item
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
 return runWithContext(contextSelection(),async()=>{
 const state=preparationState()
 if(input.approved!==true)throw fail('Review and approve preparation and requested access first.')
 const preview=store.preview(input.token)
 if([...state.controllers.values()].length>=2)throw fail('Two imports are already preparing. Wait or cancel one.',429)
 const choices=input.items||{}
 const org=await readOrg(),scoped=await listPolicies()
 const items=preview.items.map(original=>{
   if(packagesOnly&&!canPrepareAtLaunch(original))return original
   const item=clearPreparationIssues(original)
   const choice=choices[item.id]
   const credentialsProvided=Boolean(choice?.useSourceSecrets||choice?.provider||Object.values(choice?.secrets||{}).some(Boolean))
   // Rows that cannot become usable in this import need no runtime preflight.
   // Keep package downloads and supplied credentials eligible for policy checks.
   if(item.disabled||item.issues.some(issue=>!isPackagePending(issue)&&!(issue.startsWith('Connect credentials')&&credentialsProvided)))return {...item,preparationBlocked:true}
   const extra=[...packageRuntimeRequirements(item.package),...runtimeRequirements(choices[item.id]?.hosts||[])]
   const requirements=[...item.requirements,...extra.filter(r=>!item.requirements.some(o=>o.host===r.host&&o.phase===r.phase))]
   const blocked=requirements.find(r=>blockedBy(org,[r.host])||blockedByPolicy(scoped,{name:'',group:null},[r.host],hostMatches))
   const preparationIssues=blocked?[`Your organization blocks ${blocked.host}, so this MCP can’t be used in sandboxes.`]:[]
   return {...item,requirements,preparationIssues,issues:[...item.issues,...preparationIssues],preparationBlocked:!!blocked}
 })
 const id=randomUUID(),controller=new AbortController()
 const job={id,status:'running',createdAt:new Date().toISOString(),message:'Preparing selected tools',items:items.map(publicItem)}
 state.jobs.set(id,job);state.controllers.set(id,controller);await persist(job)
 const context=contextSelection()
 const packages=createPackagePreparation({signal:controller.signal})
 void runWithContext(context,async()=>{
   const prepared=[]
   let startupFailure=null
   for(const original of items){
     if(controller.signal.aborted)break
     let item=structuredClone(original)
     const step=async(message)=>{job.current={id:item.id,name:item.name,message};job.message=`${item.name}: ${message}`;await persist(job)}
     try{
       if(!item.preparationBlocked&&!item.disabled&&(!packagesOnly||canPrepareAtLaunch(item))){
         if(item.package&&!item.artifact){
           const artifact=await packages.build(item.package,{progress:step})
           item={...item,artifact,config:{command:'node',args:[`${packageLocation(artifact)}/${artifact.bin}`,...artifact.args],...(item.environment?{env:item.environment}:{})},issues:item.issues.filter(i=>!isPackagePending(i))}
         }
         if(item.credentialFields?.length&&(choices[item.id]?.useSourceSecrets||choices[item.id]?.provider||Object.values(choices[item.id]?.secrets||{}).some(Boolean))){
           await step('Connecting credentials')
           item=await connectCredentials(item,choices[item.id],preview.credentials?.[item.id])
         }
         // Known incompatible rows remain inactive; an irrelevant check must not block compatible imports.
         if(!packagesOnly&&item.config?.url&&!item.credentialFields?.length&&!item.issues.length)item=await checkConnection(item,controller.signal,step)
       }
     }catch(e){if(e.preparationUnavailable)startupFailure=e.message;const message=e.status?e.message:'Preparation failed. Retry this item; no imported code ran on your computer.';item.preparationIssues=[message];item.issues=[...item.issues.filter(i=>!isPackagePending(i)),message]}
     item.state=item.disabled?'disabled':item.issues.length?'needs-attention':item.auth?.mode==='agent-session'?'sign-in-in-sandbox':'prepared'
     delete job.current
     prepared.push(item);job.preparedItems=[...prepared,...items.slice(prepared.length)];job.items=job.preparedItems.map(publicItem);await persist(job)
     if(startupFailure)break
   }
   delete job.current
   if(controller.signal.aborted){job.status='cancelled';job.message='Preparation cancelled. Completed items are retained for review; destination sandboxes were not modified.';job.review=store.stage(job.preparedItems||items,preview.credentials)}
   else if(startupFailure){job.status='failed';job.message=startupFailure+' Remaining tools were not attempted. Restore connectivity and retry.';job.review=store.stage(job.preparedItems||items,preview.credentials)}
   else if(packagesOnly){
     const failed=prepared.find(item=>source.items.some(old=>old.id===item.id&&canPrepareAtLaunch(old))&&(!item.artifact||item.issues.length))
     if(failed){job.status='failed';job.message=`${failed.name}: ${failed.issues.join(' ') || 'Package preparation failed.'}`}
     else{job.setup=await store.buildSnapshot(source,prepared);job.status='complete';job.message='MCP packages prepared. Baking the sandbox image…'}
   }
   else{job.status='complete';job.message='Review the prepared items. Items needing attention remain inactive.';job.review=store.stage(prepared,preview.credentials)}
   await persist(job)
   // A finished job keeps only its public view; the staged review or snapshot holds the prepared items.
 }).catch((e)=>runWithContext(context,async()=>{job.status='failed';job.message=e?.status?e.message:'Preparation failed. Retry the import.';delete job.current;try{await persist(job)}catch{}})).finally(async()=>{await packages.close();state.controllers.delete(id);delete job.preparedItems})
 return publicJob(job)
 })
}
