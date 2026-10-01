import {createHash,randomBytes} from 'node:crypto'
const digest=value=>createHash('sha256').update(value).digest('hex')
const fail=(message,status=401)=>Object.assign(Error(message),{status})
const TOKEN=/^[a-f0-9]{64}\.[a-f0-9]{64}$/
const NONCE=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
export function validateLocalConnection(value={}) {
 let url
 try{url=new URL(value.origin)}catch{throw fail('Invalid local connection',400)}
 if(url.origin!==value.origin||url.protocol!=='http:'||!['localhost','127.0.0.1','[::1]'].includes(url.hostname)||!url.port||Number(url.port)<1||Number(url.port)>65535||!NONCE.test(value.nonce??'')||!/^[a-f0-9]{64}$/.test(value.challenge??''))throw fail('Invalid local connection',400)
 return {origin:value.origin,nonce:value.nonce,challenge:value.challenge}
}
export function createCloudConnections(db,auth,{org,now=Date.now,isSessionRevoked=()=>false}={}) {
 const records=db.collection('localConnections')
 const refFor=token=>{if(typeof token!=='string'||!TOKEN.test(token))throw fail('Cloud connection expired. Reconnect local OpenRod.');return records.doc(token.split('.')[0])}
 async function identity(row){
  if(!row||row.revoked||row.expires<=now()||isSessionRevoked(row.sessionHash))throw fail('Cloud connection expired. Reconnect local OpenRod.')
  const user=await auth.getUser(row.uid)
  if(user.uid!==row.uid||user.disabled||!user.emailVerified||!user.providerData?.some(p=>p.providerId==='google.com'))throw fail('Google account unavailable',403)
  return {uid:user.uid,email:user.email,org,role:'member',expires:row.expires}
 }
 return {
  async authorize(owner,input,sessionHash){
   const bound=validateLocalConnection(input)
   if(!owner?.uid||!Number.isFinite(owner.expires)||owner.expires<=now()||!/^[a-f0-9]{64}$/.test(sessionHash??''))throw fail('Sign in to connect local OpenRod')
   const id=digest(owner.uid),code=`${id}.${randomBytes(32).toString('hex')}`
   const pending={...bound,uid:owner.uid,sessionHash,codeHash:digest(code),codeExpires:Math.min(owner.expires,now()+300000),expires:Math.min(owner.expires,now()+3600000),used:false,revoked:false}
   // An unredeemed browser sign-in must not replace a working local grant.
   // Keep the active record until verifier and account checks both succeed.
   await db.runTransaction(async tx=>{const ref=records.doc(id),snap=await tx.get(ref);tx.set(ref,{...(snap.exists?snap.data():{expires:pending.expires}),pending})})
   return code
  },
  async redeem(code,verifier,nonce){
   const ref=refFor(code),token=`${ref.id}.${randomBytes(32).toString('hex')}`
   if(typeof verifier!=='string'||verifier.length>256)throw fail('Invalid local connection verifier')
   const user=await db.runTransaction(async tx=>{
    const snap=await tx.get(ref),stored=snap.exists?snap.data():null
    // Accept pre-upgrade pending codes as well as the nested pending format.
    const row=stored?.pending??stored
    if(!row||row.used||row.revoked||row.codeExpires<=now()||row.codeHash!==digest(code)||row.challenge!==digest(verifier)||row.nonce!==nonce)throw fail('Local sign-in code expired or already used')
    const user=await identity(row)
    tx.set(ref,{...row,used:true,codeHash:null,challenge:null,grantHash:digest(token)})
    return user
   })
   return {token,expires:user.expires,user:{uid:user.uid,email:user.email}}
  },
  async authenticate(token){
   const snap=await refFor(token).get(),row=snap.exists?snap.data():null
   if(!row?.used||row.grantHash!==digest(token))throw fail('Cloud connection expired. Reconnect local OpenRod.')
   return identity(row)
  },
  async revoke(token){
   const ref=refFor(token)
   await db.runTransaction(async tx=>{const snap=await tx.get(ref),row=snap.exists?snap.data():null;if(row?.grantHash===digest(token))tx.update(ref,{revoked:true})})
  },
 }
}
