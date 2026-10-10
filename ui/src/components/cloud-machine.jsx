import * as React from 'react'
import { CloudAgents } from '@/components/cloud-agents'
import { cloudHandoff } from '@/lib/cloud-machine'
import { Notice } from '@/components/notice'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
async function request(path,method='GET') {
 const response=await fetch(`/api/cloud/${path}`,{method,headers:method==='POST'?{'x-openshell-console':'1','content-type':'application/json'}:undefined,body:method==='POST'?'{}':undefined})
 const value=await response.json()
 if(!response.ok)throw Error(value.error??'Cloud machine unavailable')
 return value
}
export function CloudMachine({children,logout}) {
 const [machine,setMachine]=React.useState(null),[error,setError]=React.useState(''),[transfer,setTransfer]=React.useState(null)
 const [preparing,setPreparing]=React.useState(false),[revision,refresh]=React.useReducer(value=>value+1,0)
 async function prepare(){setPreparing(true);setError('');try{setMachine(await request('machine','POST'));refresh()}catch(e){setError(e.message)}finally{setPreparing(false)}}
 const handoff=React.useRef(cloudHandoff(window.location.hash)),sent=React.useRef(false),autoStarted=React.useRef(false)
 React.useEffect(()=>{
  let alive=true,timer
  // Signing in to the cloud console is the request for a machine; start it without another click.
  async function poll(){try{const value=await request('machine');if(alive){setMachine(value);setError(value.error??'');if(value.status==='none'&&!autoStarted.current){autoStarted.current=true;prepare()}else if(!['ready','none','error'].includes(value.status))timer=setTimeout(poll,5000)}}catch(e){if(alive){setError(e.message);timer=setTimeout(poll,10000)}}}
  poll();return()=>{alive=false;clearTimeout(timer)}
 },[revision])
 React.useEffect(()=>{
  const target=handoff.current
  if(machine?.status!=='ready'||!target||!window.opener||sent.current)return
  sent.current=true;setTransfer({status:'waiting'})
  const receive=event=>{
   if(!handoff.current)return
   if(event.source!==window.opener||event.origin!==target.origin||event.data?.type!=='openrod-cloud-result'||event.data.nonce!==target.nonce)return
   if(event.data.error){setTransfer({status:'error',message:event.data.error});return}
   setTransfer({status:'done',message:event.data.warning??'Workspace copied. Reconnect your agent credentials to continue.'})
   if(/^[a-z0-9-]{1,63}$/.test(event.data.name??''))window.location.hash=`terminal/${event.data.name}?session=shell`
  }
  window.addEventListener('message',receive)
  request('handoff','POST').then(({ticket})=>window.opener.postMessage({type:'openrod-cloud-ready',nonce:target.nonce,ticket},target.origin)).catch(e=>setTransfer({status:'error',message:e.message}))
  const deadline=Date.now()+35*60000
  const timer=setInterval(()=>{
   if(!handoff.current)return
   if(window.opener?.closed||Date.now()>deadline){setTransfer({status:'error',message:'The source tab closed or the copy timed out. Open your workspace to check whether a copy was created.'});clearInterval(timer)}
  },1000)
  return()=>{window.removeEventListener('message',receive);clearInterval(timer)}
 },[machine?.status])
 if(machine?.status==='ready'&&(!transfer||transfer.status==='done'))return <>{transfer?.message&&<Notice id="cloud-transfer" tone="success" title="Workspace continued in the cloud" onDismiss={()=>setTransfer(null)}>{transfer.message}</Notice>}{children}</>
 if(!machine&&!error&&!transfer)return null
 const starting=!transfer&&!error&&(preparing||!['none','ready','error'].includes(machine.status))
 return <main className="grid min-h-screen place-items-center px-6"><section className="max-w-md text-center">
  {starting&&<CloudAgents />}
  <h1 className="text-2xl font-semibold">{transfer?'Continuing your workspace…':'Setting up your cloud machine…'}</h1>
  <p className="mt-3 text-sm text-muted-foreground">{transfer?'Keep your local OpenRod tab open.':'High demand may slow this down.'}</p>
  {starting&&<div role="status" className="mt-5 flex items-center justify-center gap-2 rounded-lg bg-muted/50 p-4 text-sm"><Spinner aria-hidden="true" /><span>Opens automatically when ready</span></div>}
  {(error||transfer?.message)&&<p role="alert" className="mt-4 text-sm text-destructive">{transfer?.message??error}</p>}
  {!transfer&&!starting&&<Button disabled={preparing} className="mt-5" onClick={prepare}>{preparing&&<Spinner />}Try again</Button>}
  {transfer&&<button onClick={()=>{handoff.current=null;setTransfer(null);window.location.hash=''}} className="mt-4 text-sm underline">Open cloud workspace</button>}
  <button onClick={logout} className="mt-6 block w-full text-xs underline">Sign out</button>
 </section></main>
}
