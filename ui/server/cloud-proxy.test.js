import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import {once} from 'node:events'
import {cloudRouter,createHandoffs} from './cloud-proxy.js'
import {cloudConfig,createSecurity} from './security.js'
import {verifyWorkerRequest} from './worker-auth.js'
const config=cloudConfig({OPENROD_MODE:'cloud',OPENROD_ORG_ID:'pilot',OPENROD_PUBLIC_ORIGIN:'https://console.example.com',GOOGLE_CLOUD_PROJECT:'openrod-test',OPENROD_FIREBASE_API_KEY:'public',OPENROD_FIREBASE_AUTH_DOMAIN:'openrod-test.firebaseapp.com'})
async function listen(t,server){server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();return new Promise(r=>server.close(r))});return server.address().port}
test('authenticated HTTP routing separates users and never serves the pilot gateway',async t=>{
 const keys={alice:'a'.repeat(64),bob:'b'.repeat(64)},targets={}
 for(const uid of Object.keys(keys)){
  const worker=http.createServer((req,res)=>{try{const identity=verifyWorkerRequest(keys[uid],uid,req);res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({owner:identity.uid}))}catch{res.writeHead(403);res.end()}})
  targets[uid]={key:keys[uid],address:'127.0.0.1',port:await listen(t,worker)}
 }
 const auth={verifySessionCookie:async cookie=>({uid:cookie,exp:Math.floor(Date.now()/1000)+3600}),getUser:async uid=>({uid,email:uid+'@example.com',emailVerified:true,providerData:[{providerId:'google.com'}]})}
 const security=createSecurity(config,auth),machines={target:async id=>targets[id.uid]},routes=cloudRouter(security,machines,{},auth)
 const central=http.createServer((req,res)=>security.middleware(req,res,()=>routes.protectedRoutes(req,res,()=>{res.writeHead(404);res.end()})))
 const port=await listen(t,central)
 const request=async(uid)=>{
  const r=http.request({host:'127.0.0.1',port,path:'/api/os/overview',headers:{host:config.host,origin:config.origin,...(uid?{cookie:`__Host-openrod_session=${uid}`}:{})}}),pending=once(r,'response');r.end();const [res]=await pending;let body='';for await(const chunk of res)body+=chunk;return {status:res.statusCode,body}
 }
 assert.equal((await request()).status,401)
 assert.equal(JSON.parse((await request('alice')).body).owner,'alice')
 assert.equal(JSON.parse((await request('bob')).body).owner,'bob')
 // A wrong routing target must still fail the VM's owner/key check.
 targets.alice={...targets.bob,key:keys.alice}
 assert.equal((await request('alice')).status,403)
})
test('cloud handoff ticket is single-use, expired tickets fail, and a second ticket replaces the first',async()=>{
 const rows=new Map();let queue=Promise.resolve(),now=1000
 const doc=id=>({id,get:async()=>({exists:rows.has(id),data:()=>rows.get(id)}),set:async row=>rows.set(id,row)})
 const db={collection:()=>({doc}),runTransaction:fn=>{const result=queue.then(()=>fn({get:r=>r.get(),update:(r,v)=>rows.set(r.id,{...rows.get(r.id),...v})}));queue=result.catch(()=>{});return result}}
 const handoffs=createHandoffs(db,()=>now),name='openrod-user-'+'a'.repeat(24),identity={uid:'alice',expires:9999999}
 const first=await handoffs.issue(identity,name),second=await handoffs.issue(identity,name)
 await assert.rejects(handoffs.consume(first),{status:401})
 const results=await Promise.allSettled([handoffs.consume(second),handoffs.consume(second)])
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1)
 const third=await handoffs.issue(identity,name);now+=300001;await assert.rejects(handoffs.consume(third),{status:401})
})
test('local connection authorization requires the console cookie and relay uses the grant owner',async t=>{
 const identity={uid:'alice',email:'alice@example.com',org:'pilot',role:'member',expires:Date.now()+3600000}
 const security=createSecurity(config,{verifySessionCookie:async()=>({uid:'alice',exp:Math.floor(identity.expires/1000)}),getUser:async()=>({uid:'alice',emailVerified:true,providerData:[{providerId:'google.com'}]})})
 const events=[],connections={authorize:async(id,bound,hash)=>{events.push({id,bound,hash});return 'code'},redeem:async()=>({token:'grant',expires:identity.expires,user:{uid:'alice'}}),authenticate:async token=>{if(token!=='grant')throw Object.assign(Error('unauthorized'),{status:401});return identity},revoke:async()=>{}}
 const machines={status:async id=>({status:'ready',owner:id.uid})},routes=cloudRouter(security,machines,{},null,{connections})
 const server=http.createServer((req,res)=>routes.publicRoutes(req,res,()=>security.middleware(req,res,()=>routes.protectedRoutes(req,res,()=>res.writeHead(404).end())))),port=await listen(t,server)
 const request=(path,{cookie,token,body}={})=>new Promise(resolve=>{const q=http.request({host:'127.0.0.1',port,path,method:body?'POST':'GET',headers:{host:config.host,origin:config.origin,'x-openshell-console':'1','content-type':'application/json',...(cookie?{cookie:'__Host-openrod_session='+cookie}:{}),...(token?{authorization:'Bearer '+token}:{})}},r=>{let data='';r.on('data',c=>data+=c);r.on('end',()=>resolve({status:r.statusCode,data:data?JSON.parse(data):{}}))});q.end(body?JSON.stringify(body):undefined)})
 assert.equal((await request('/api/cloud/local-connect/authorize',{body:{}})).status,401)
 assert.equal((await request('/api/cloud/local-connect/authorize',{cookie:'alice',body:{origin:'http://127.0.0.1:4600'}})).data.code,'code')
 assert.equal(events[0].id.uid,'alice');assert.match(events[0].hash,/^[a-f0-9]{64}$/)
 assert.equal((await request('/api/cloud/local-connect/machine')).status,401)
 assert.equal((await request('/api/cloud/local-connect/machine',{token:'grant'})).data.owner,'alice')
 assert.equal((await request('/api/cloud/local-connect/exchange',{body:{code:'code',verifier:'v',nonce:'n'}})).data.token,'grant')
})

test('combined inventory reads only an existing owner VM without allocating compute',async t=>{
 const identity={uid:'alice',expires:Date.now()+60000},key='a'.repeat(64)
 const worker=http.createServer((req,res)=>{assert.equal(req.url,'/api/os/overview');assert.equal(verifyWorkerRequest(key,'alice',req).uid,'alice');res.setHeader('content-type','application/json');res.end(JSON.stringify({sandboxes:[{id:'same',name:'demo'}]}))})
 let record=null,allocations=0
 const machines={store:{get:async()=>record},target:async()=>{allocations++;throw Error('Must not provision')},status:async()=>{allocations++;throw Error('Must not provision')}}
 const security=createSecurity(config,{}),connections={authenticate:async()=>identity}
 const routes=cloudRouter(security,machines,{},null,{connections}),port=await listen(t,http.createServer((req,res)=>routes.publicRoutes(req,res,()=>res.writeHead(404).end())))
 const request=()=>new Promise(resolve=>{const q=http.request({host:'127.0.0.1',port,path:'/api/cloud/local-connect/inventory',headers:{host:config.host,origin:config.origin,authorization:'Bearer grant'}},r=>{let raw='';r.on('data',c=>raw+=c);r.on('end',()=>resolve({status:r.statusCode,data:JSON.parse(raw)}))});q.end()})
 assert.deepEqual((await request()).data.sandboxes,[])
 record={uid:'alice',state:'ready',key,address:'127.0.0.1',port:await listen(t,worker)}
 assert.equal((await request()).data.sandboxes[0].name,'demo');assert.equal(allocations,0)
 record={...record,uid:'bob'};assert.equal((await request()).status,403)
})
