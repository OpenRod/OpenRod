import http from 'node:http'
import fs from 'node:fs'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { identityContext, requestPath } from './security.js'
import {readJson,safeWorkspaceTarget} from './remote-http.js'
import { signWorkerRequest } from './worker-auth.js'
import { workerPrefix, workerAuthHeader } from './cloud-deployment.js'
const fail=(message,status=503)=>Object.assign(Error(message),{status})
const json=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value))}
const hash=value=>createHash('sha256').update(value).digest('hex')
export function createHandoffs(db,now=()=>Date.now(),prefix='openrod-user') {
 const ticketPattern=new RegExp(`^${workerPrefix(prefix)}-[a-f0-9]{24}\\.[a-f0-9]{64}$`)
 return {
  async issue(identity,name){const token=`${name}.${randomBytes(32).toString('hex')}`;await db.collection('handoffs').doc(name).set({uid:identity.uid,hash:hash(token),expires:Math.min(identity.expires,now()+300000),used:false});return token},
  async consume(token){
   if(typeof token!=='string'||!ticketPattern.test(token))throw fail('Invalid cloud transfer ticket',401)
   return db.runTransaction(async tx=>{const ref=db.collection('handoffs').doc(token.split('.')[0]),s=await tx.get(ref),r=s.exists?s.data():null;if(!r||r.used||r.expires<=now()||r.hash!==hash(token))throw fail('Cloud transfer ticket expired or already used',401);tx.update(ref,{used:true});return r.uid})
  },
 }
}
export function proxyWorker(req,res,record,identity,config,{target=req.url,maxBytes=36*1024*1024}={}) {
 const headers={host:config.host,origin:config.origin,'x-openshell-console':'1',[workerAuthHeader(record.workerProtocol??config.workerProtocol)]:signWorkerRequest(record.key,identity,{method:req.method,url:target})}
 for(const key of ['content-type','content-length','accept','range','x-openshell-context','x-openshell-location'])if(req.headers[key])headers[key]=req.headers[key]
 return new Promise(resolve=>{
  const upstream=http.request({hostname:record.address,port:record.port??4600,path:target,method:req.method,headers},response=>{
   const safe={...response.headers};delete safe['set-cookie'];delete safe['connection'];delete safe['transfer-encoding']
   res.writeHead(response.statusCode,safe);response.pipe(res);response.once('end',resolve);response.once('error',()=>{res.destroy();resolve()})
  })
  upstream.setTimeout(35*60000,()=>upstream.destroy())
  let bytes=0
  req.on('data',chunk=>{bytes+=chunk.length;if(bytes>maxBytes){upstream.destroy();if(!res.headersSent)json(res,413,{error:'Transfer exceeds the upload limit'});else res.destroy()}})
  upstream.once('error',()=>{if(!res.headersSent)json(res,503,{error:'Your cloud machine is unavailable. Try again shortly.'});else res.destroy();resolve()})
  res.once('close',()=>upstream.destroy());req.pipe(upstream)
 })
}
export function proxyWorkerSocket(req,socket,head,record,identity,config,{target=req.url}={}) {
 const upstream=http.request({hostname:record.address,port:record.port??4600,path:target,method:'GET',headers:{host:config.host,origin:config.origin,upgrade:'websocket',connection:'Upgrade','sec-websocket-key':req.headers['sec-websocket-key'],'sec-websocket-version':req.headers['sec-websocket-version'],[workerAuthHeader(record.workerProtocol??config.workerProtocol)]:signWorkerRequest(record.key,identity,{method:'GET',url:target})}})
 upstream.once('upgrade',(response,remote,remoteHead)=>{
  socket.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(response.headers).map(([k,v])=>`${k}: ${v}`).join('\r\n')}\r\n\r\n`)
  if(remoteHead.length)socket.write(remoteHead);if(head.length)remote.write(head)
  socket.pipe(remote);remote.pipe(socket);socket.once('close',()=>remote.destroy());remote.once('close',()=>socket.destroy());remote.once('error',()=>socket.destroy());socket.once('error',()=>remote.destroy())
 })
 upstream.once('response',()=>socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'))
 upstream.once('error',()=>socket.destroy());socket.once('close',()=>upstream.destroy());upstream.end()
}
export function cloudRouter(security,machines,handoffs,auth,{artifact=process.env.OPENROD_WORKER_ARTIFACT,connections,connectionCheckMs=60000}={}) {
 async function publicRoutes(req,res,next) {
  try {
   const pathname=requestPath(req)
   if(pathname==='/internal/worker-artifact') {
    if(req.method!=='GET')throw fail('Not found',404)
    const record=await machines.store.byName(req.headers['x-openrod-worker']??(security.config.workerProtocol==='legacy'?req.headers['x-legacy-worker']:undefined))
    const supplied=req.headers.authorization?.replace(/^Bearer /,'')??''
    if(!record||supplied.length!==record.key.length||!timingSafeEqual(Buffer.from(supplied),Buffer.from(record.key))||!artifact)throw fail('Not found',404)
    res.writeHead(200,{'Content-Type':'application/gzip','Cache-Control':'no-store'});const file=fs.createReadStream(artifact);file.on('error',()=>res.destroy());res.once('close',()=>file.destroy());file.pipe(res);return
   }
   if(connections && pathname.startsWith('/api/cloud/local-connect/') && pathname!=='/api/cloud/local-connect/authorize') {
    if(req.headers.host!==security.config.host||(req.headers.origin&&req.headers.origin!==security.config.origin)||(req.headers['sec-fetch-site']&&!['same-origin','none'].includes(req.headers['sec-fetch-site'])))throw fail('Request rejected',403)
    if(pathname==='/api/cloud/local-connect/exchange'&&req.method==='POST'){
     const body=await readJson(req);return json(res,200,await connections.redeem(body.code,body.verifier,body.nonce))
    }
    const token=req.headers.authorization?.replace(/^Bearer /,'')
    let identity;try{identity=await connections.authenticate(token)}catch(error){if(error.status===403)throw fail('Cloud connection unavailable. Sign in again.',401);throw error}
    if(pathname==='/api/cloud/local-connect/revoke'&&req.method==='POST'){await readJson(req);await connections.revoke(token);return json(res,200,{ok:true})}
    if(pathname==='/api/cloud/local-connect/identity'&&req.method==='GET')return json(res,200,{user:{uid:identity.uid,email:identity.email},expires:identity.expires})
    if(pathname==='/api/cloud/local-connect/inventory'&&req.method==='GET'){
     const record=await machines.store.get(identity.uid)
     if(record&&record.uid!==identity.uid)throw fail('Machine ownership mismatch',403)
     if(!record||record.state!=='ready'||!record.address)return json(res,200,{sandboxes:[],templates:[],locations:[],machine:{status:record?.state??'none',error:record?.error??null}})
     watchConnection(token,res,identity)
     return await proxyWorker(req,res,record,identity,security.config,{target:'/api/os/inventory'})
    }
    if(pathname==='/api/cloud/local-connect/machine'&&req.method==='GET')return json(res,200,await machines.status(identity))
    if(pathname==='/api/cloud/local-connect/machine'&&req.method==='POST'){
     if(req.headers['x-openshell-console']!=='1')throw fail('Request rejected',403)
     await readJson(req);return json(res,200,await machines.prepare(identity))
    }
    if(pathname.startsWith('/api/cloud/local-connect/os/')&&['GET','POST'].includes(req.method)){
     const target=safeWorkspaceTarget(req.url,'/api/cloud/local-connect/os')
     if(req.method!=='GET'&&req.headers['x-openshell-console']!=='1')throw fail('Request rejected',403)
     watchConnection(token,res,identity)
     return await proxyWorker(req,res,await machines.target(identity,{provision:req.method!=='GET'}),identity,security.config,{target})
    }
    throw fail('Not found',404)
   }
   if(pathname==='/api/cloud/import') {
    if(req.method!=='POST'||req.headers['content-type']!=='application/json')throw fail('Invalid cloud transfer',400)
    const uid=await handoffs.consume(req.headers.authorization?.replace(/^Bearer /,''))
    const user=await auth.getUser(uid)
    if(user.disabled||!user.emailVerified||!user.providerData?.some(p=>p.providerId==='google.com'))throw fail('Account unavailable',403)
    const identity={uid,email:user.email,org:security.config.org,role:'member',expires:Date.now()+3600000}
    return await proxyWorker(req,res,await machines.target(identity),identity,security.config,{target:'/api/os/cloud-import'})
   }
   next()
  }catch(error){json(res,error.status??503,{error:error.status?error.message:'Cloud service unavailable. Try again shortly.'})}
 }
 async function protectedRoutes(req,res,next) {
  try {
   const identity=identityContext.getStore(),pathname=requestPath(req)
   if(connections&&pathname==='/api/cloud/local-connect/authorize'&&req.method==='POST'){const body=await readJson(req);return json(res,200,{code:await connections.authorize(identity,body,security.sessionHash(req))})}
   if(pathname==='/api/cloud/machine'&&req.method==='GET')return json(res,200,await machines.status(identity))
   if(pathname==='/api/cloud/machine'&&req.method==='POST'){
    if(req.headers['x-openshell-console']!=='1')throw fail('Request rejected',403)
    await readJson(req);return json(res,200,await machines.prepare(identity))
   }
   if(pathname==='/api/cloud/handoff'&&req.method==='POST'){
    if(req.headers['x-openshell-console']!=='1')throw fail('Request rejected',403)
    const record=await machines.target(identity);return json(res,200,{ticket:await handoffs.issue(identity,record.name)})
   }
   if(pathname.startsWith('/api/os/'))return await proxyWorker(req,res,await machines.target(identity,{provision:req.method!=='GET'}),identity,security.config)
   next()
  }catch(error){json(res,error.status??503,{error:error.status?error.message:'Cloud service unavailable. Try again shortly.'})}
 }
 function watchConnection(token,target,identity){
  const expiry=setTimeout(()=>target.destroy(),Math.max(1,identity.expires-Date.now())),check=setInterval(()=>connections.authenticate(token).catch(()=>target.destroy()),connectionCheckMs)
  expiry.unref?.();check.unref?.();target.once('close',()=>{clearTimeout(expiry);clearInterval(check)})
 }
 return {publicRoutes,protectedRoutes,upgrade:async(req,socket,head)=>{
  try{
   const pathname=requestPath(req)
   if(connections&&pathname.startsWith('/api/cloud/local-connect/os/')){
    if(req.headers.host!==security.config.host||req.headers.origin!==security.config.origin)throw fail('Request rejected',403)
    const target=safeWorkspaceTarget(req.url,'/api/cloud/local-connect/os')
    if(!['/api/os/terminal','/api/os/ssh'].includes(target.split('?')[0]))throw fail('Not found',404)
    const token=req.headers.authorization?.replace(/^Bearer /,''),identity=await connections.authenticate(token)
    watchConnection(token,socket,identity);proxyWorkerSocket(req,socket,head,await machines.target(identity,{provision:false}),identity,security.config,{target});return
   }
   if(pathname!=='/api/os/terminal')return
   const identity=await security.authenticate(req);security.watch(req,socket,identity);proxyWorkerSocket(req,socket,head,await machines.target(identity,{provision:false}),identity,security.config)
  }catch{socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')}
 }}
}
