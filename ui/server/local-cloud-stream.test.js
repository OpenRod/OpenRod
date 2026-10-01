import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import {createHash} from 'node:crypto'
import {once} from 'node:events'
import {WebSocket,WebSocketServer} from 'ws'
import {cloudRouter} from './cloud-proxy.js'
import {createLocalCloud} from './local-cloud.js'
import {verifyWorkerRequest} from './worker-auth.js'
const owner=createHash('sha256').update('alice').digest('hex').slice(0,16)
const ownerHeaders={'x-openrod-local-owner':owner}
async function listen(t,s){s.listen(0,'127.0.0.1');await once(s,'listening');t.after(()=>{s.closeAllConnections();return new Promise(r=>s.close(r))});return `http://127.0.0.1:${s.address().port}`}
async function fixture(t,{ttl=3600000}={}){
 let denied=false,streamClosed;const streamDone=new Promise(r=>streamClosed=r),key='a'.repeat(64)
 const worker=http.createServer((req,res)=>{const id=verifyWorkerRequest(key,'alice',req);if(req.url==='/api/os/local-folder'){res.writeHead(403,{'content-type':'application/json'});res.end(JSON.stringify({error:'Host-local action forbidden'}));return}res.writeHead(200,{'content-type':'text/event-stream'});res.write(`event: sandboxes\ndata: ${JSON.stringify([{owner:id.uid}])}\n\n`);const timer=setInterval(()=>res.write(': ping\n\n'),30);res.once('close',()=>{clearInterval(timer);streamClosed()})})
 const wss=new WebSocketServer({noServer:true})
 worker.on('upgrade',(req,socket,head)=>{verifyWorkerRequest(key,'alice',req);wss.handleUpgrade(req,socket,head,ws=>ws.on('message',data=>ws.send(data)))})
 const workerOrigin=await listen(t,worker),config={mode:'cloud'},identity={uid:'alice',email:'alice@example.com',org:'pilot',role:'member',expires:Date.now()+ttl}
 const connections={redeem:async()=>({token:'grant',expires:identity.expires,user:{uid:identity.uid,email:identity.email}}),authenticate:async token=>{if(token!=='grant'||denied)throw Object.assign(Error('Revoked/disabled'),{status:401});return identity},revoke:async()=>{denied=true}}
 const machines={target:async()=>({address:'127.0.0.1',port:Number(new URL(workerOrigin).port),key}),status:async()=>({status:'ready'})}
 const security={config},routes=cloudRouter(security,machines,{},null,{connections,connectionCheckMs:10})
 const central=http.createServer((req,res)=>routes.publicRoutes(req,res,()=>res.writeHead(404).end()));central.on('upgrade',routes.upgrade)
 const cloudOrigin=await listen(t,central);config.origin=cloudOrigin;config.host=new URL(cloudOrigin).host
 const bridge=createLocalCloud({origin:cloudOrigin,allowTestHttp:true}),local=http.createServer((req,res)=>bridge.middleware(req,res,()=>res.writeHead(418).end('local')))
 local.on('upgrade',(req,socket,head)=>bridge.upgrade(req,socket,head))
 const base=await listen(t,local);t.after(()=>bridge.close())
 const post=(path,body)=>fetch(base+'/api/local-cloud/'+path,{method:'POST',headers:{...ownerHeaders,origin:base,'content-type':'application/json','x-openshell-console':'1'},body:JSON.stringify(body)})
 const start=await (await post('start',{origin:base})).json();assert.equal((await post('finish',{nonce:start.nonce,code:'code'})).status,200)
 return {base,deny:()=>{denied=true},post,streamDone}
}
test('SSE and terminal WebSocket cross local and cloud relays, then revocation closes both',{timeout:5000},async t=>{
 const f=await fixture(t),res=await fetch(f.base+'/api/remote/os/stream',{headers:ownerHeaders}),reader=res.body.getReader(),first=await reader.read()
 assert.match(Buffer.from(first.value).toString(),/alice/)
 const ws=new WebSocket(f.base.replace('http:','ws:')+'/api/remote/os/terminal?ticket=test&owner='+owner+'',{headers:{origin:f.base}})
 ws.on('error',()=>{});await once(ws,'open');const echoed=once(ws,'message');ws.send('hello cloud');assert.equal((await echoed)[0].toString(),'hello cloud')
 const forbidden=await fetch(f.base+'/api/remote/os/local-folder',{method:'POST',headers:{...ownerHeaders,origin:f.base,'content-type':'application/json','x-openshell-console':'1'},body:'{}'});assert.equal(forbidden.status,403);assert.equal((await (await fetch(f.base+'/api/local-cloud/status')).json()).connected,true)
 const stillEchoing=once(ws,'message');ws.send('still connected');assert.equal((await stillEchoing)[0].toString(),'still connected')
 const closed=once(ws,'close');f.deny();await closed;await f.streamDone
 await reader.cancel().catch(()=>{})
 assert.equal((await fetch(f.base+'/api/remote/os/overview',{headers:ownerHeaders})).status,401)
})
test('local disconnect closes existing cloud sockets and expiry closes streams',{timeout:5000},async t=>{
 const f=await fixture(t),ws=new WebSocket(f.base.replace('http:','ws:')+'/api/remote/os/terminal?ticket=test&owner='+owner+'',{headers:{origin:f.base}});ws.on('error',()=>{});await once(ws,'open');const closed=once(ws,'close');await f.post('disconnect',{});await closed
 assert.equal((await fetch(f.base+'/api/remote/os/overview',{headers:ownerHeaders})).status,401)
 const expiring=await fixture(t,{ttl:150}),res=await fetch(expiring.base+'/api/remote/os/stream',{headers:ownerHeaders}),reader=res.body.getReader();await reader.read();await expiring.streamDone;await reader.cancel().catch(()=>{})
 assert.equal((await fetch(expiring.base+'/api/remote/os/overview',{headers:ownerHeaders})).status,401)
})
test('remote WebSocket rejects a cross-origin localhost caller',{timeout:5000},async t=>{
 const f=await fixture(t),ws=new WebSocket(f.base.replace('http:','ws:')+'/api/remote/os/terminal?ticket=test&owner='+owner+'',{headers:{origin:'http://evil.example'}})
 const error=await once(ws,'error');assert.match(error[0].message,/403/)
})
