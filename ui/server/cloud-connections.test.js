import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {createCloudConnections,validateLocalConnection} from './cloud-connections.js'
const hash=v=>createHash('sha256').update(v).digest('hex')
function fixture(){
 const rows=new Map();let queue=Promise.resolve(),now=1000,disabled=false,revoked=false,rejectIdentity=false
 const doc=id=>({id,get:async()=>({exists:rows.has(id),data:()=>rows.get(id)}),set:async v=>rows.set(id,v)})
 const db={collection:()=>({doc}),runTransaction:fn=>{const p=queue.then(()=>fn({get:r=>r.get(),set:(r,v)=>rows.set(r.id,v),update:(r,v)=>rows.set(r.id,{...rows.get(r.id),...v})}));queue=p.catch(()=>{});return p}}
 const auth={getUser:async uid=>{if(rejectIdentity){rejectIdentity=false;throw Error('Account lookup unavailable')}return {uid,email:'alice@example.com',disabled,emailVerified:true,providerData:[{providerId:'google.com'}]}}}
 return {store:createCloudConnections(db,auth,{org:'pilot',now:()=>now,isSessionRevoked:()=>revoked}),rows,advance:n=>now+=n,disable:()=>disabled=true,revokeSession:()=>revoked=true,rejectNextIdentity:()=>rejectIdentity=true}
}
const input={origin:'http://127.0.0.1:4600',nonce:'11111111-1111-4111-8111-111111111111',challenge:hash('v'.repeat(64))},id={uid:'alice',expires:3601000}
test('local connection accepts only canonical loopback origins, nonce and challenge',()=>{
 assert.deepEqual(validateLocalConnection(input),input)
 for(const origin of ['http://evil.example:4600','https://localhost:4600','http://127.0.0.1:4600/path','http://localhost:0','http://localhost:70000','http://user@localhost:4600'])assert.throws(()=>validateLocalConnection({...input,origin}),{status:400})
 assert.throws(()=>validateLocalConnection({...input,challenge:'bad'}),{status:400})
})
test('local sign-in code is verifier-bound and redeemed exactly once concurrently',async()=>{
 const f=fixture(),code=await f.store.authorize(id,input,'a'.repeat(64))
 await assert.rejects(f.store.redeem(code,'wrong',input.nonce),{status:401})
 const results=await Promise.allSettled([f.store.redeem(code,'v'.repeat(64),input.nonce),f.store.redeem(code,'v'.repeat(64),input.nonce)])
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1)
 const grant=results.find(r=>r.status==='fulfilled').value
 assert.equal((await f.store.authenticate(grant.token)).uid,'alice')
 assert.equal(JSON.stringify([...f.rows.values()]).includes(grant.token),false)
 assert.equal(JSON.stringify([...f.rows.values()]).includes(code),false)
 await f.store.revoke(grant.token)
 await assert.rejects(f.store.authenticate(grant.token),{status:401})
})
test('expired codes/grants and replaced connection cannot authenticate',async()=>{
 const f=fixture(),first=await f.store.authorize(id,input,'a'.repeat(64));f.advance(300001)
 await assert.rejects(f.store.redeem(first,'v'.repeat(64),input.nonce),{status:401})
 const code=await f.store.authorize(id,input,'a'.repeat(64)),grant=await f.store.redeem(code,'v'.repeat(64),input.nonce)
 await f.store.authorize(id,input,'a'.repeat(64))
 assert.equal((await f.store.authenticate(grant.token)).uid,'alice')
 const code2=await f.store.authorize(id,input,'a'.repeat(64)),grant2=await f.store.redeem(code2,'v'.repeat(64),input.nonce)
 await assert.rejects(f.store.authenticate(grant.token),{status:401})
 f.advance(3600001);await assert.rejects(f.store.authenticate(grant2.token),{status:401})
})

test('abandoned authorization and failed redemption preserve the active grant until successful redemption',async()=>{
 const f=fixture(),code=await f.store.authorize(id,input,'a'.repeat(64)),active=await f.store.redeem(code,'v'.repeat(64),input.nonce)
 const replacement=await f.store.authorize(id,input,'b'.repeat(64))
 assert.equal((await f.store.authenticate(active.token)).uid,'alice')
 for(const [verifier,nonce] of [['wrong',input.nonce],['v'.repeat(64),'22222222-2222-4222-8222-222222222222']]){
  await assert.rejects(f.store.redeem(replacement,verifier,nonce),{status:401})
  assert.equal((await f.store.authenticate(active.token)).uid,'alice')
 }
 f.rejectNextIdentity()
 await assert.rejects(f.store.redeem(replacement,'v'.repeat(64),input.nonce),/Account lookup unavailable/)
 assert.equal((await f.store.authenticate(active.token)).uid,'alice')
 const next=await f.store.redeem(replacement,'v'.repeat(64),input.nonce)
 assert.equal((await f.store.authenticate(next.token)).uid,'alice')
 await assert.rejects(f.store.authenticate(active.token),{status:401})
})

test('an expired pending code does not change the active grant lifetime or session binding',async()=>{
 const f=fixture(),code=await f.store.authorize(id,input,'a'.repeat(64)),active=await f.store.redeem(code,'v'.repeat(64),input.nonce)
 const replacement=await f.store.authorize({...id,expires:id.expires+3600000},input,'b'.repeat(64))
 f.advance(300001)
 await assert.rejects(f.store.redeem(replacement,'v'.repeat(64),input.nonce),{status:401})
 assert.equal((await f.store.authenticate(active.token)).expires,active.expires)
 f.advance(3300000)
 await assert.rejects(f.store.authenticate(active.token),{status:401})
})
test('disabled Google accounts and console logout invalidate local connections',async()=>{
 for(const change of ['disable','revokeSession']){
 const f=fixture(),code=await f.store.authorize(id,input,'a'.repeat(64)),grant=await f.store.redeem(code,'v'.repeat(64),input.nonce)
 f[change]();await assert.rejects(f.store.authenticate(grant.token),e=>[401,403].includes(e.status))
 }
})
