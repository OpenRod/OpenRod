import http from 'node:http'
import https from 'node:https'
import {randomBytes,randomUUID,createHash} from 'node:crypto'
import {isLocalApiRequest,requestPath} from './security.js'
import {validateLocalConnection} from './cloud-connections.js'
import {readJson,responseJson,remoteFail,safeWorkspaceTarget} from './remote-http.js'
const CLOUD='https://cloud.example.com',PREFIX='/api/cloud/local-connect'
export function createLocalCloud({origin=CLOUD,allowTestHttp=false,native}={}) {
 const url=new URL(origin)
 if(url.origin!==origin||url.username||url.password||(!allowTestHttp&&origin!==CLOUD))throw Error('Invalid OpenRod Cloud origin')
 const transport=url.protocol==='https:'?https:http
 let pending,grant,expiry,generation=0
 const active=new Set(),exchanging=new Map()
 function clear(){grant=null;clearTimeout(expiry);for(const stream of active)stream.destroy();active.clear()}
 function connection(){if(!grant||grant.expires<=Date.now()){clear();throw remoteFail('Connect to OpenRod Cloud first',401)}return grant}
 function upstream(path,{method='GET',body,token,maxBytes=64000}={}) {
  return new Promise((resolve,reject)=>{
   const req=transport.request(new URL(PREFIX+path,origin),{method,headers:{origin,host:url.host,'content-type':'application/json','x-openshell-console':'1',...(token?{authorization:`Bearer ${token}`}:{})}},res=>{
    let raw='';res.on('data',c=>{raw+=c;if(Buffer.byteLength(raw)>maxBytes)req.destroy(remoteFail('Cloud response too large',502))});res.on('end',()=>{let value;try{value=JSON.parse(raw)}catch{return reject(remoteFail('Invalid cloud response',502))}if(res.statusCode>=300)return reject(remoteFail(value.error??'Cloud connection unavailable',res.statusCode));resolve(value)})
   });req.setTimeout(30000,()=>req.destroy(remoteFail('Cloud connection timed out',503)));req.on('error',reject);req.end(body===undefined?undefined:JSON.stringify(body))
  })
 }
 const call=(path,options={})=>upstream(path,{...options,token:connection().token})
 const ownerId=uid=>createHash('sha256').update(uid).digest('hex').slice(0,16)
 const assertOwner=req=>{const current=connection(),supplied=req.headers['x-openrod-local-owner']??new URL(req.url,'http://local').searchParams.get('owner');if(supplied!==ownerId(current.user.uid))throw Object.assign(remoteFail('This cloud connection belongs to a different account. Sign in again in this tab.',403),{code:'CLOUD_OWNER_CHANGED'});return current}
 const status=()=>grant?{connected:true,user:grant.user,owner:ownerId(grant.user.uid),expires:grant.expires}:{connected:false}
 function relay(req,res,target){
  const current=connection(),headers={host:url.host,origin,'x-openshell-console':'1',authorization:`Bearer ${current.token}`}
  for(const k of ['content-type','content-length','accept','range','x-openshell-context','x-openshell-location'])if(req.headers[k])headers[k]=req.headers[k]
  const proxy=transport.request(new URL(PREFIX+'/os'+target.slice('/api/os'.length),origin),{method:req.method,headers},remote=>{
   if(remote.statusCode===401&&grant===current){active.delete(res);clear()}
   const headers={...remote.headers};for(const key of ['set-cookie','connection','transfer-encoding','location'])delete headers[key]
   res.writeHead(remote.statusCode,headers);remote.pipe(res);remote.on('error',()=>res.destroy())
  })
  proxy.setTimeout(35*60000,()=>proxy.destroy());active.add(res)
  proxy.on('error',()=>{if(!res.headersSent)responseJson(res,503,{error:'Cloud compute is unavailable. Reconnect or try again.'});else res.destroy()})
  let bytes=0;req.on('data',c=>{bytes+=c.length;if(bytes>36*1024*1024){proxy.destroy();if(!res.headersSent)responseJson(res,413,{error:'Upload exceeds limit'})}})
  res.on('close',()=>{active.delete(res);proxy.destroy()});req.pipe(proxy)
 }
 function relaySocket(req,socket,head,target){
  const current=connection()
  const proxy=transport.request(new URL(PREFIX+'/os'+target.slice('/api/os'.length),origin),{headers:{host:url.host,origin,authorization:`Bearer ${current.token}`,upgrade:'websocket',connection:'Upgrade','sec-websocket-key':req.headers['sec-websocket-key'],'sec-websocket-version':req.headers['sec-websocket-version']}})
  active.add(socket)
  proxy.once('upgrade',(response,remote,remoteHead)=>{
   socket.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(response.headers).filter(([k])=>!['set-cookie'].includes(k)).map(([k,v])=>`${k}: ${v}`).join('\r\n')}\r\n\r\n`)
   if(remoteHead.length)socket.write(remoteHead);if(head.length)remote.write(head)
   socket.pipe(remote);remote.pipe(socket);socket.on('close',()=>remote.destroy());remote.on('close',()=>socket.destroy());remote.on('error',()=>socket.destroy());socket.on('error',()=>remote.destroy())
  })
  proxy.once('response',res=>{if(res.statusCode===401&&grant===current)clear();socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')})
  proxy.once('error',()=>socket.destroy());socket.once('close',()=>{active.delete(socket);proxy.destroy()});proxy.end()
 }
 return {
  call,connection,close:()=>{generation++;pending=null;clear()},setNative:handler=>{native=handler},
  async middleware(req,res,next){
   let path
   try{path=requestPath(req);if(!path.startsWith('/api/local-cloud/')&&!path.startsWith('/api/remote/'))return next()
    if(!isLocalApiRequest(req))throw remoteFail('Request rejected',403)
    if(path==='/api/local-cloud/status'&&req.method==='GET'){
     if(grant){const current=grant;try{const result=await call('/identity');if(grant===current&&result.user?.uid===current.user.uid)current.user=result.user;return responseJson(res,200,status())}catch(error){if(grant!==current)return responseJson(res,200,status());if([401,403].includes(error.status))clear();else return responseJson(res,200,{...status(),error:error.message})}}
     return responseJson(res,200,status())
    }
    if(path==='/api/local-cloud/machine'&&req.method==='GET'){const current=assertOwner(req),machine=await call('/machine');if(grant!==current)throw remoteFail('Cloud connection changed. Try again.',401);return responseJson(res,200,{...status(),machine})}
    if(path==='/api/local-cloud/inventory'&&req.method==='GET'){const current=assertOwner(req),inventory=await call('/inventory',{maxBytes:4*1024*1024});if(grant!==current)throw remoteFail('Cloud connection changed. Try again.',401);return responseJson(res,200,inventory)}
    if(path==='/api/local-cloud/start'&&req.method==='POST'){
     const body=await readJson(req),verifier=randomBytes(32).toString('hex'),nonce=randomUUID(),challenge=createHash('sha256').update(verifier).digest('hex')
     const bound=validateLocalConnection({origin:body.origin,nonce,challenge})
     if(body.origin!==`http://${req.headers.host}`)throw remoteFail('Local origin does not match this OpenRod instance',403)
     pending={...bound,verifier,generation:++generation,expires:Date.now()+300000}
     return responseJson(res,200,{nonce,challenge,url:`${CLOUD}/?handoff=1#local-connect=${Buffer.from(JSON.stringify(bound)).toString('base64url')}`})
    }
    if(path==='/api/local-cloud/finish'&&req.method==='POST'){
     const body=await readJson(req),current=pending
     if(!current||current.expires<=Date.now()||body.nonce!==current.nonce||typeof body.code!=='string')throw remoteFail('Local sign-in expired. Try again.',401)
     pending=null;exchanging.set(current.nonce,current)
     const result=await upstream('/exchange',{method:'POST',body:{code:body.code,verifier:current.verifier,nonce:current.nonce}}).finally(()=>exchanging.delete(current.nonce))
     if(current.cancelled||current.generation!==generation){if(result.token)await upstream('/revoke',{method:'POST',token:result.token,body:{}}).catch(()=>{});throw remoteFail('Local connection was cancelled. Try again.',401)}
     if(typeof result.token!=='string'||!result.user?.uid||!Number.isFinite(result.expires)||result.expires<=Date.now()||result.expires>Date.now()+3600000)throw remoteFail('Invalid cloud authorization',502)
     clear();grant={...result,nonce:current.nonce};expiry=setTimeout(clear,Math.max(1,result.expires-Date.now()));expiry.unref?.()
     return responseJson(res,200,status())
    }
    if(path==='/api/local-cloud/cancel'&&req.method==='POST'){
     const body=await readJson(req)
     if(typeof body.nonce!=='string')throw remoteFail('Invalid sign-in attempt')
     if(pending?.nonce===body.nonce){pending=null;generation++}
     const current=exchanging.get(body.nonce)
     if(current){current.cancelled=true;if(current.generation===generation)generation++}
     if(grant?.nonce===body.nonce){const old=grant;clear();await upstream('/revoke',{method:'POST',token:old.token,body:{}}).catch(()=>{})}
     return responseJson(res,200,status())
    }
    if(path==='/api/local-cloud/disconnect'&&req.method==='POST'){
     await readJson(req);if(grant)assertOwner(req);const old=grant;generation++;pending=null;clear()
     if(old)await upstream('/revoke',{method:'POST',token:old.token,body:{}}).catch(()=>{})
     return responseJson(res,200,status())
    }
    if(path.startsWith('/api/remote/os/')){
     const target=safeWorkspaceTarget(req.url,'/api/remote/os'),current=assertOwner(req)
     const boundConnection=()=>{if(connection()!==current)throw Object.assign(remoteFail('Cloud connection changed. Open this sandbox again.',403),{code:'CLOUD_OWNER_CHANGED'});return current}
     const boundCall=async(path,options={})=>{boundConnection();const result=await upstream(path,{...options,token:current.token});boundConnection();return result}
     if(native&&await native(req,res,target,{call:boundCall,connection:boundConnection}))return
     boundConnection()
     return relay(req,res,target)
    }
    throw remoteFail('Not found',404)
   }catch(error){if(!res.headersSent)responseJson(res,error.status??503,{error:error.status?error.message:'Cloud connection unavailable',...(error.code?{code:error.code}:{})});else res.destroy()}
  },
  upgrade(req,socket,head){
   try{if(!requestPath(req).startsWith('/api/remote/'))return false
    if(!isLocalApiRequest(req))throw remoteFail('Request rejected',403)
    const target=safeWorkspaceTarget(req.url,'/api/remote/os');assertOwner(req)
    if(!['/api/os/terminal','/api/os/ssh'].includes(target.split('?')[0]))throw remoteFail('Not found',404)
    socket.on('error',()=>{});relaySocket(req,socket,head,target);return true
   }catch{socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');return true}
  },
 }
}
