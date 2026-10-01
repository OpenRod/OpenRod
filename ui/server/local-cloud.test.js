import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import {once} from 'node:events'
import {createLocalCloud} from './local-cloud.js'
import {safeWorkspaceTarget} from './remote-http.js'
async function listen(t,s){s.listen(0,'127.0.0.1');await once(s,'listening');t.after(()=>{s.closeAllConnections();return new Promise(r=>s.close(r))});return `http://127.0.0.1:${s.address().port}`}
test('remote target cannot escape workspace routes',()=>{
 assert.equal(safeWorkspaceTarget('/api/remote/os/files/demo?path=project%2Ffile','/api/remote/os'),'/api/os/files/demo?path=project%2Ffile')
 for(const p of ['/api/remote/os/../auth/session','/api/remote/os/%2e%2e/auth/session','/api/remote/os//auth/session','/api/remote/os/internal/worker-artifact','https://evil.example/overview'])assert.throws(()=>safeWorkspaceTarget(p,'/api/remote/os'))
})
test('local return exchange keeps grant off browser, pins remote routing and disconnects',async t=>{
 let token,received=[]
 const upstream=await listen(t,http.createServer(async(req,res)=>{received.push({path:req.url,auth:req.headers.authorization});let body='';for await(const c of req)body+=c;res.setHeader('content-type','application/json');
 if(req.url.endsWith('/exchange')){token='a'.repeat(64)+'.'+'b'.repeat(64);res.end(JSON.stringify({token,expires:Date.now()+3600000,user:{uid:'alice',email:'alice@example.com'}}))}
 else if(req.url.endsWith('/machine'))res.end(JSON.stringify({status:'ready'}))
 else if(req.url.endsWith('/overview')){assert.equal(req.headers.authorization,`Bearer ${token}`);res.end(JSON.stringify({owner:'alice'}))}
 else res.end('{}')
 }))
 const bridge=createLocalCloud({origin:upstream,allowTestHttp:true}),local=http.createServer((req,res)=>bridge.middleware(req,res,()=>{res.writeHead(418);res.end('local fallback')})),base=await listen(t,local)
 const post=async(path,body)=>fetch(base+path,{method:'POST',headers:{origin:base,'content-type':'application/json','x-openshell-console':'1'},body:JSON.stringify(body)})
 const initial=await fetch(base+'/api/remote/os/overview');assert.equal(initial.status,401)
 const start=await (await post('/api/local-cloud/start',{origin:base})).json()
 assert.equal(typeof start.nonce,'string');assert.equal(start.verifier,undefined)
 assert.equal((await post('/api/local-cloud/finish',{nonce:'bad',code:'fake'})).status,401)
 const finish=await (await post('/api/local-cloud/finish',{nonce:start.nonce,code:'code'})).json()
 assert.equal(finish.connected,true);assert.equal(finish.token,undefined)
 const overview=await (await fetch(base+'/api/remote/os/overview')).json();assert.equal(overview.owner,'alice')
 await post('/api/local-cloud/disconnect',{})
 assert.equal((await fetch(base+'/api/remote/os/overview')).status,401)
 assert.equal(received.some(r=>r.path.endsWith('/revoke')),true)
})
test('disconnect during sign-in redemption cannot reinstall a cloud grant',async t=>{
 let release,entered;const waiting=new Promise(r=>release=r),exchangeSeen=new Promise(r=>entered=r),paths=[]
 const upstream=await listen(t,http.createServer(async(req,res)=>{paths.push(req.url);for await(const c of req){};res.setHeader('content-type','application/json');if(req.url.endsWith('/exchange')){entered();await waiting;res.end(JSON.stringify({token:'a'.repeat(64)+'.'+'b'.repeat(64),expires:Date.now()+3600000,user:{uid:'alice'}}))}else res.end('{}')}))
 const bridge=createLocalCloud({origin:upstream,allowTestHttp:true}),base=await listen(t,http.createServer((req,res)=>bridge.middleware(req,res,()=>res.writeHead(404).end())))
 const post=(path,body)=>fetch(base+'/api/local-cloud/'+path,{method:'POST',headers:{origin:base,'content-type':'application/json','x-openshell-console':'1'},body:JSON.stringify(body)})
 const start=await (await post('start',{origin:base})).json(),finish=post('finish',{nonce:start.nonce,code:'code'})
 await exchangeSeen;await post('disconnect',{});release()
 assert.equal((await finish).status,401)
 assert.equal((await (await fetch(base+'/api/local-cloud/status')).json()).connected,false)
 assert.equal(paths.some(p=>p.endsWith('/revoke')),true)
})
test('an old status failure cannot disconnect a replacement connection',async t=>{
 let release,entered,count=0;const waiting=new Promise(r=>release=r),seen=new Promise(r=>entered=r)
 const upstream=await listen(t,http.createServer(async(req,res)=>{for await(const c of req){};res.setHeader('content-type','application/json');if(req.url.endsWith('/exchange')){count++;res.end(JSON.stringify({token:String(count),expires:Date.now()+3600000,user:{uid:'alice',email:`connection${count}@example.com`}}))}else if(req.url.endsWith('/identity')&&req.headers.authorization==='Bearer 1'){entered();await waiting;res.writeHead(401);res.end(JSON.stringify({error:'old grant expired'}))}else res.end(JSON.stringify({status:'ready'}))}))
 const bridge=createLocalCloud({origin:upstream,allowTestHttp:true}),base=await listen(t,http.createServer((req,res)=>bridge.middleware(req,res,()=>res.writeHead(404).end())))
 const post=(path,body)=>fetch(base+'/api/local-cloud/'+path,{method:'POST',headers:{origin:base,'content-type':'application/json','x-openshell-console':'1'},body:JSON.stringify(body)})
 const connect=async()=>{const start=await (await post('start',{origin:base})).json();await post('finish',{nonce:start.nonce,code:'code'})}
 await connect();const stale=fetch(base+'/api/local-cloud/status');await seen;await connect();release();await stale
 const result=await (await fetch(base+'/api/local-cloud/status')).json();assert.equal(result.connected,true);assert.equal(result.user.email,'connection2@example.com')
})

test('sign-in and account status do not allocate cloud compute',async t=>{
 const paths=[]
 const upstream=await listen(t,http.createServer(async(req,res)=>{paths.push(req.url);for await(const c of req){};res.setHeader('content-type','application/json');res.end(JSON.stringify(req.url.endsWith('/exchange')?{token:'grant',expires:Date.now()+3600000,user:{uid:'alice'}}:req.url.endsWith('/machine')?{status:'ready'}:{user:{uid:'alice'}}))}))
 const bridge=createLocalCloud({origin:upstream,allowTestHttp:true}),base=await listen(t,http.createServer((req,res)=>bridge.middleware(req,res,()=>res.writeHead(404).end())))
 const post=(path,body)=>fetch(base+'/api/local-cloud/'+path,{method:'POST',headers:{origin:base,'content-type':'application/json','x-openshell-console':'1'},body:JSON.stringify(body)})
 const start=await(await post('start',{origin:base})).json();await post('finish',{nonce:start.nonce,code:'code'});await fetch(base+'/api/local-cloud/status')
 assert.equal(paths.some(p=>p.endsWith('/machine')),false)
 const machine=await(await fetch(base+'/api/local-cloud/machine')).json();assert.equal(machine.machine.status,'ready');assert.equal(paths.filter(p=>p.endsWith('/machine')).length,1)
})
test('cancelling an old sign-in nonce cannot disconnect a newer account session',async t=>{
 const upstream=await listen(t,http.createServer(async(req,res)=>{for await(const c of req){};res.setHeader('content-type','application/json');res.end(JSON.stringify(req.url.endsWith('/exchange')?{token:'grant',expires:Date.now()+3600000,user:{uid:'alice'}}:{user:{uid:'alice'}}))}))
 const bridge=createLocalCloud({origin:upstream,allowTestHttp:true}),base=await listen(t,http.createServer((req,res)=>bridge.middleware(req,res,()=>res.writeHead(404).end())))
 const post=(path,body)=>fetch(base+'/api/local-cloud/'+path,{method:'POST',headers:{origin:base,'content-type':'application/json','x-openshell-console':'1'},body:JSON.stringify(body)})
 const first=await(await post('start',{origin:base})).json(),second=await(await post('start',{origin:base})).json()
 await post('finish',{nonce:second.nonce,code:'code'});await post('cancel',{nonce:first.nonce})
 assert.equal((await(await fetch(base+'/api/local-cloud/status')).json()).connected,true)
 await post('cancel',{nonce:second.nonce});assert.equal((await(await fetch(base+'/api/local-cloud/status')).json()).connected,false)
})
test('nonce cancellation during exchange revokes the late grant without cancelling a new attempt',async t=>{
 let release,entered,count=0;const waiting=new Promise(r=>release=r),seen=new Promise(r=>entered=r),revoked=[]
 const upstream=await listen(t,http.createServer(async(req,res)=>{for await(const c of req){};res.setHeader('content-type','application/json');if(req.url.endsWith('/exchange')){const id=++count;if(id===1){entered();await waiting}res.end(JSON.stringify({token:`grant${id}`,expires:Date.now()+3600000,user:{uid:'alice'}}))}else{if(req.url.endsWith('/revoke'))revoked.push(req.headers.authorization);res.end('{}')}}))
 const bridge=createLocalCloud({origin:upstream,allowTestHttp:true}),base=await listen(t,http.createServer((req,res)=>bridge.middleware(req,res,()=>res.writeHead(404).end())))
 const post=(path,body)=>fetch(base+'/api/local-cloud/'+path,{method:'POST',headers:{origin:base,'content-type':'application/json','x-openshell-console':'1'},body:JSON.stringify(body)})
 const first=await(await post('start',{origin:base})).json(),finish=post('finish',{nonce:first.nonce,code:'code'})
 await seen;await post('cancel',{nonce:first.nonce})
 const second=await(await post('start',{origin:base})).json();release()
 assert.equal((await finish).status,401);assert.deepEqual(revoked,['Bearer grant1'])
 assert.equal((await post('finish',{nonce:second.nonce,code:'code'})).status,200)
 assert.equal(bridge.connection().token,'grant2')
})
