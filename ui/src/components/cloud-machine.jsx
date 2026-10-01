import * as React from 'react'
import { cloudHandoff } from '@/lib/cloud-machine'
import { Notice } from '@/components/notice'
async function request(path,method='GET') {
 const response=await fetch(`/api/cloud/${path}`,{method,headers:method==='POST'?{'x-openshell-console':'1'}:undefined})
 const value=await response.json()
 if(!response.ok)throw Error(value.error??'Cloud machine unavailable')
 return value
}
export function CloudMachine({children,logout}) {
 const [machine,setMachine]=React.useState(null),[error,setError]=React.useState(''),[transfer,setTransfer]=React.useState(null)
 const handoff=React.useRef(cloudHandoff(window.location.hash)),sent=React.useRef(false)
 React.useEffect(()=>{
  let alive=true,timer
  async function poll(){try{const value=await request('machine');if(alive){setMachine(value);setError(value.error??'');if(value.status!=='ready')timer=setTimeout(poll,5000)}}catch(e){if(alive){setError(e.message);timer=setTimeout(poll,10000)}}}
  poll();return()=>{alive=false;clearTimeout(timer)}
 },[])
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
 return <main className="grid min-h-screen place-items-center px-6"><section className="max-w-md text-center">
  <img src="/openrod.svg" alt="OpenRod" className="mx-auto mb-6 h-10 w-10"/>
  <h1 className="text-2xl font-semibold">{transfer?'Continuing your workspace…':'Preparing your private machine…'}</h1>
  <p className="mt-3 text-sm text-muted-foreground">{transfer?'Keep the local OpenRod tab open while your files are copied and your template is rebuilt.':'Your account has one dedicated machine. Its first start can take several minutes.'}</p>
  {(error||transfer?.message)&&<p role="alert" className="mt-4 text-sm text-destructive">{transfer?.message??error}</p>}
  {transfer&&<button onClick={()=>{handoff.current=null;setTransfer(null);window.location.hash=''}} className="mt-4 text-sm underline">Open cloud workspace</button>}
  <button onClick={logout} className="mt-6 block w-full text-xs underline">Sign out</button>
 </section></main>
}
