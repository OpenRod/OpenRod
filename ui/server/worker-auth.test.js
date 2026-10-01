import test from 'node:test'
import assert from 'node:assert/strict'
import { signWorkerRequest, verifyWorkerRequest } from './worker-auth.js'
const key='a'.repeat(64), identity={uid:'alice',email:'alice@example.com',org:'pilot',role:'member',expires:Date.now()+3600000}
test('worker signatures bind owner, request target, method, lifetime and unique worker key',()=>{
 const req={method:'GET',url:'/api/os/overview',headers:{}}
 req.headers['x-openrod-worker-auth']=signWorkerRequest(key,identity,req)
 assert.equal(verifyWorkerRequest(key,'alice',req).uid,'alice')
 for(const [secret,uid,request] of [[key,'bob',req],['b'.repeat(64),'alice',req],[key,'alice',{...req,url:'/api/os/secrets'}],[key,'alice',{...req,method:'POST'}]])assert.throws(()=>verifyWorkerRequest(secret,uid,request),{status:403})
 assert.throws(()=>verifyWorkerRequest(key,'alice',req,Date.now()+61000),{status:403})
})
