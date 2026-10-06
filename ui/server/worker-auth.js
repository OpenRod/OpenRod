import { createHmac, timingSafeEqual } from 'node:crypto'
const denied=()=>Object.assign(Error('Worker request rejected'),{status:403})
export function signWorkerRequest(key,identity,req,now=Date.now()) {
 const payload=Buffer.from(JSON.stringify({...identity,method:req.method,target:req.url,validUntil:now+30000})).toString('base64url')
 return `${payload}.${createHmac('sha256',key).update(payload).digest('base64url')}`
}
export function verifyWorkerRequest(key,owner,req,now=Date.now(),header='x-openrod-worker-auth') {
 const token=req.headers[header]
 if(typeof token!=='string'||token.length>5000)throw denied()
 const [payload,mac,extra]=token.split('.')
 if(!payload||!mac||extra)throw denied()
 const expected=createHmac('sha256',key).update(payload).digest(),actual=Buffer.from(mac,'base64url')
 if(actual.length!==expected.length||!timingSafeEqual(actual,expected))throw denied()
 let value
 try{value=JSON.parse(Buffer.from(payload,'base64url').toString())}catch{throw denied()}
 if(value.uid!==owner||value.method!==req.method||value.target!==req.url||!Number.isFinite(value.validUntil)||value.validUntil<=now||value.validUntil>now+60000||!Number.isFinite(value.expires)||value.expires<=now)throw denied()
 return {uid:value.uid,email:value.email,org:value.org,role:value.role,expires:value.expires}
}
