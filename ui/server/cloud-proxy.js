import http from 'node:http'
import fs from 'node:fs'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { identityContext, requestPath } from './security.js'
import { signWorkerRequest } from './worker-auth.js'
const fail=(message,status=503)=>Object.assign(Error(message),{status})
const json=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value))}
const hash=value=>createHash('sha256').update(value).digest('hex')
export function createHandoffs(db,now=()=>Date.now()) {
 return {
  async issue(identity,name){const token=`${name}.${randomBytes(32).toString('hex')}`;await db.collection('handoffs').doc(name).set({uid:identity.uid,hash:hash(token),expires:Math.min(identity.expires,now()+300000),used:false});return token},
  async consume(token){
   if(typeof token!=='string'||!/^openrod-user-[a-f0-9]{24}\.[a-f0-9]{64}$/.test(token))throw fail('Invalid cloud transfer ticket',401)
   return db.runTransaction(async tx=>{const ref=db.collection('handoffs').doc(token.split('.')[0]),s=await tx.get(ref),r=s.exists?s.data():null;if(!r||r.used||r.expires<=now()||r.hash!==hash(token))throw fail('Cloud transfer ticket expired or already used',401);tx.update(ref,{used:true});return r.uid})
  },
 }
}
export function proxyWorker(req,res,record,identity,config,{target=req.url,maxBytes=36*1024*1024}={}) {
 const headers={host:config.host,origin:config.origin,'x-openshell-console':'1','x-openrod-worker-auth':signWorkerRequest(record.key,identity,{method:req.method,url:target})}
 for(const key of ['content-type','content-length','accept','range'])if(req.headers[key])headers[key]=req.headers[key]
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
export function proxyWorkerSocket(req,socket,head,record,identity,config) {
 const upstream=http.request({hostname:record.address,port:record.port??4600,path:req.url,method:'GET',headers:{host:config.host,origin:config.origin,upgrade:'websocket',connection:'Upgrade','sec-websocket-key':req.headers['sec-websocket-key'],'sec-websocket-version':req.headers['sec-websocket-version'],'x-openrod-worker-auth':signWorkerRequest(record.key,identity,req)}})
 upstream.once('upgrade',(response,remote,remoteHead)=>{
  socket.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(response.headers).map(([k,v])=>`${k}: ${v}`).join('\r\n')}\r\n\r\n`)
  if(remoteHead.length)socket.write(remoteHead);if(head.length)remote.write(head)
  socket.pipe(remote);remote.pipe(socket);socket.once('close',()=>remote.destroy());remote.once('close',()=>socket.destroy());remote.once('error',()=>socket.destroy());socket.once('error',()=>remote.destroy())
 })
 upstream.once('response',()=>socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'))
 upstream.once('error',()=>socket.destroy());socket.once('close',()=>upstream.destroy());upstream.end()
}
export function cloudRouter(security,machines,handoffs,auth,{artifact=process.env.OPENROD_WORKER_ARTIFACT}={}) {
 async function publicRoutes(req,res,next) {
  try {
   const pathname=requestPath(req)
   if(pathname==='/internal/worker-artifact') {
    if(req.method!=='GET')throw fail('Not found',404)
    const record=await machines.store.byName(req.headers['x-openrod-worker'])
    const supplied=req.headers.authorization?.replace(/^Bearer /,'')??''
    if(!record||supplied.length!==record.key.length||!timingSafeEqual(Buffer.from(supplied),Buffer.from(record.key))||!artifact)throw fail('Not found',404)
    res.writeHead(200,{'Content-Type':'application/gzip','Cache-Control':'no-store'});const file=fs.createReadStream(artifact);file.on('error',()=>res.destroy());res.once('close',()=>file.destroy());file.pipe(res);return
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
   if(pathname==='/api/cloud/machine'&&req.method==='GET')return json(res,200,await machines.status(identity))
   if(pathname==='/api/cloud/handoff'&&req.method==='POST'){
    if(req.headers['x-openshell-console']!=='1')throw fail('Request rejected',403)
    const record=await machines.target(identity);return json(res,200,{ticket:await handoffs.issue(identity,record.name)})
   }
   if(pathname.startsWith('/api/os/'))return await proxyWorker(req,res,await machines.target(identity),identity,security.config)
   next()
  }catch(error){json(res,error.status??503,{error:error.status?error.message:'Cloud service unavailable. Try again shortly.'})}
 }
 return {publicRoutes,protectedRoutes,upgrade:async(req,socket,head)=>{
  try{if(requestPath(req)!=='/api/os/terminal')return;const identity=await security.authenticate(req);security.watch(req,socket,identity);proxyWorkerSocket(req,socket,head,await machines.target(identity),identity,security.config)}catch{socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')}
 }}
}
