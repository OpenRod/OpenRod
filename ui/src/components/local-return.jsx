import * as React from 'react'
import { createApi } from "@/lib/api"
import { terminalHref } from "@/lib/sandbox-session"
import { useTransferGroups } from '@/components/transfer-groups'
import {CLOUD_ORIGIN} from '@/lib/cloud-transfer'
import { Notice } from '@/components/notice'
export function LocalReturn({children}) {
 const { chooseGroups, dialog, cancel } = useTransferGroups()
  // A cloud return always rebuilds on the laptop, independent of saved compute.
  const transfer = React.useRef(new AbortController())
  const api = React.useMemo(() => createApi('local', transfer.current.signal), [])
  const generation = React.useRef(0)
  React.useEffect(() => {
    const current = ++generation.current
    return () => queueMicrotask(() => { if (generation.current === current) transfer.current.abort() })
  }, [])
 const nonce=React.useRef(/^#cloud-return=([a-f0-9-]{36})$/.exec(window.location.hash)?.[1])
 const [state,setState]=React.useState(nonce.current&&window.opener?'waiting':'normal'),[message,setMessage]=React.useState('')
 const accepted=React.useRef(false),detached=React.useRef(false)
 React.useEffect(()=>{
  if(state!=='waiting')return
  const receive=async event=>{
   if(accepted.current||event.origin!==CLOUD_ORIGIN||event.source!==window.opener||event.data?.type!=='openrod-local-bundle'||event.data.nonce!==nonce.current)return
   accepted.current=true;setState('importing')
   try {
    if (typeof event.data.error === 'string') throw Error(event.data.error)
    const inventory = await api.inventory()
    const location = inventory.locations.find(item => !item.remote && item.connected)
    if (!location) throw Error('Connect a local gateway before importing this workspace.')
    const destination = api.forContext(location.context)
    const groups = await chooseGroups(destination, 'local OpenRod', transfer.current.signal)
    if (detached.current) return
    const result=await destination.importCloud({ ...event.data.bundle, ...(groups ? { destinationGroups: groups } : {}) })
    window.opener.postMessage({type:'openrod-local-result',nonce:nonce.current,name:result.name},CLOUD_ORIGIN)
    if(detached.current)return
    setMessage(event.data.warning??'Workspace copied locally. Reconnect agent credentials to continue.')
    window.location.href=terminalHref(result.name, "shell", { ...location, target: "local" });setState('done')
   }catch(error){if(detached.current || transfer.current.signal.aborted)return;setMessage(error.message);setState('error');window.opener.postMessage({type:'openrod-local-result',nonce:nonce.current,error:error.message},CLOUD_ORIGIN)}
  }
  window.addEventListener('message',receive)
  window.opener.postMessage({type:'openrod-local-ready',nonce:nonce.current},CLOUD_ORIGIN)
  return()=>window.removeEventListener('message',receive)
 },[state])
 React.useEffect(()=>{
  if(!['waiting','importing'].includes(state))return
  const deadline=Date.now()+35*60000
  const timer=setInterval(()=>{if(window.opener?.closed||Date.now()>deadline){transfer.current.abort();cancel();setMessage('The cloud tab closed or the copy timed out. Open the workspace to check whether a copy was created.');setState('error')}},1000)
  return()=>clearInterval(timer)
 },[state])
 if(state==='normal'||state==='done')return <>{message&&<Notice id="local-return" tone={state==='done'?'success':'warning'} title={state==='done'?'Workspace continued locally':'Workspace copy didn’t finish'} onDismiss={()=>setMessage('')}>{message}</Notice>}{children}</>
 return <>{dialog}<main className="grid min-h-screen place-items-center px-6"><section className="max-w-md text-center">
  <h1 className="text-2xl font-semibold">Continuing your workspace locally…</h1>
  <p className="mt-3 text-sm text-muted-foreground">Keep the cloud tab open while your files are copied and your template is rebuilt for this computer.</p>
  {message&&<p role="alert" className="mt-4 text-sm text-destructive">{message}</p>}
  {<button className="mt-6 text-sm underline" onClick={()=>{transfer.current.abort();cancel();detached.current=true;accepted.current=true;window.location.hash='';setState('normal')}}>Open local workspace</button>}
 </section></main></>
}
