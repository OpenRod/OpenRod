import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { createConsoleServer } from './start.js'
import { cloudConfig } from './security.js'

const config = cloudConfig({OPENROD_MODE:'cloud',OPENROD_ORG_ID:'pilot',OPENROD_PUBLIC_ORIGIN:'https://console.example.com',GOOGLE_CLOUD_PROJECT:'fixture',OPENROD_FIREBASE_API_KEY:'public',OPENROD_FIREBASE_AUTH_DOMAIN:'fixture.firebaseapp.com'})

test('actual cloud server closes unsupported anonymous upgrades instead of leaving sockets open', {timeout:5000}, async t => {
  const dist = await fs.mkdtemp(path.join(os.tmpdir(),'openrod-upgrade-'))
  await fs.writeFile(path.join(dist,'index.html'),'fixture')
  t.after(() => fs.rm(dist,{recursive:true,force:true}))
  const auth = {verifySessionCookie:async()=>{throw Error('No session')},getUser:async()=>{throw Error('No account')}}
  const server = await createConsoleServer({config,auth,dist,machines:{},handoffs:{},connections:{}})
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve)}))
  for (const target of ['/api/remote/os/terminal','/api/remote/os/ssh','/api/os/ssh','/wrong']) {
    const reply = await new Promise((resolve,reject)=>{
      const socket=net.connect(server.address().port,'127.0.0.1');let response=''
      socket.setTimeout(500,()=>socket.destroy(Error('Unsupported upgrade remained open')))
      socket.once('connect',()=>socket.write(`GET ${target} HTTP/1.1\r\nHost: console.example.com\r\nOrigin: https://console.example.com\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: MDEyMzQ1Njc4OWFiY2RlZg==\r\n\r\n`))
      socket.on('data',data=>{response+=data});socket.once('error',reject);socket.once('end',()=>{socket.destroy();resolve(response)})
    })
    assert.match(reply,/^HTTP\/1\.1 404 Not Found/)
  }
})
