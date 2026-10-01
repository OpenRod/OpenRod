import test from 'node:test'
import assert from 'node:assert/strict'
import {cloudHandoff} from './cloud-machine.js'
const hash=value=>'#handoff='+Buffer.from(JSON.stringify(value)).toString('base64url'),nonce='12345678-1234-1234-1234-123456789abc'
test('cloud handoff accepts only a nonce-bound localhost opener origin',()=>{
 assert.equal(cloudHandoff(hash({origin:'http://127.0.0.1:4600',nonce})).origin,'http://127.0.0.1:4600')
 for(const origin of ['https://evil.example','http://localhost.evil:4600','http://127.0.0.1:4600/path','http://user@localhost:4600'])assert.equal(cloudHandoff(hash({origin,nonce})),null)
 assert.equal(cloudHandoff(hash({origin:'http://localhost:4600',nonce:'forged'})),null)
})
