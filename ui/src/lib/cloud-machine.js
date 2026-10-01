export function cloudHandoff(hash) {
 try {
  if(!hash.startsWith('#handoff='))return null
  const value=JSON.parse(atob(hash.slice(9).replaceAll('-','+').replaceAll('_','/')))
  const origin=new URL(value.origin)
  if(origin.origin!==value.origin||origin.protocol!=='http:'||!['localhost','127.0.0.1','[::1]'].includes(origin.hostname)||!/^\d{1,5}$/.test(origin.port)||!/^[a-f0-9-]{36}$/.test(value.nonce))return null
  return {origin:origin.origin,nonce:value.nonce}
 }catch{return null}
}
