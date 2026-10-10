import test from 'node:test'
import assert from 'node:assert/strict'
import * as connect from './local-cloud.js'
import * as compute from './compute-target.js'
const CLOUD = 'https://cloud.example.test'

test('connection parser accepts only exact loopback origins and valid nonce/challenge', () => {
  const value = { origin: 'http://localhost:4600', nonce: '12345678-1234-1234-1234-123456789abc', challenge: 'b'.repeat(64) }
  const hash = '#local-connect=' + Buffer.from(JSON.stringify(value)).toString('base64url')
  assert.deepEqual(connect.localConnectFromHash(hash), value)
  for (const origin of ['https://evil.example', 'http://localhost.evil:4600', 'http://127.0.0.2:4600', 'http://localhost:4600/path', 'http://user@localhost:4600', 'http://localhost:4600/']) {
    assert.equal(connect.localConnectFromHash('#local-connect=' + Buffer.from(JSON.stringify({ ...value, origin })).toString('base64url')), null)
  }
  assert.equal(connect.localConnectFromHash('#local-connect=bad'), null)
})
test('exchange messages require exact popup, cloud origin, nonce and short code', () => {
  const popup = {}, value = { source: popup, origin: 'https://cloud.example.test', data: { type: 'openrod-local-connected', nonce: 'nonce', code: 'a'.repeat(64) + '.' + 'b'.repeat(64) } }
  assert.equal(connect.isLocalConnectedMessage(value, popup, 'nonce', CLOUD), true)
  assert.equal(connect.isLocalConnectedMessage({ ...value, data: { ...value.data, type: 'other-local-connected' } }, popup, 'nonce', CLOUD), false)
  assert.equal(connect.isLocalConnectedMessage({ ...value, source: {} }, popup, 'nonce', CLOUD), false)
  assert.equal(connect.isLocalConnectedMessage({ ...value, origin: 'https://evil.example' }, popup, 'nonce', CLOUD), false)
  assert.equal(connect.isLocalConnectedMessage(value, popup, 'wrong-nonce', CLOUD), false)
  assert.equal(connect.isLocalConnectedMessage(value, popup, 'nonce'), false)
  for (const patch of [{ source: {} }, { origin: 'https://evil.example' }, { data: { ...value.data, nonce: 'other' } }, { data: { ...value.data, code: '' } }]) assert.equal(connect.isLocalConnectedMessage({ ...value, ...patch }, popup, 'nonce', CLOUD), false)
})
test('compute selection is per tab with explicit URL pins taking precedence', () => {
  const storage = { getItem: () => 'cloud' }
  assert.equal(compute.initialComputeTarget('http://localhost:4600/', storage), 'cloud')
  assert.equal(compute.initialComputeTarget('http://localhost:4600/?target=local#terminal/demo', storage), 'local')
  assert.equal(compute.initialComputeTarget('http://localhost:4600/?target=bad', storage), 'cloud')
  assert.equal(compute.computeApiPath('cloud', '/stream'), '/api/remote/os/stream')
  assert.equal(compute.computeApiPath('local', '/stream'), '/api/os/stream')
})

test('cloud readiness is bounded and never falls back to local execution', async () => {
  let polls = 0
  const value = await connect.waitForCloudReady(async () => ({ connected: true, machine: { status: ++polls === 2 ? 'ready' : 'starting' } }), { wait: async () => {}, attempts: 3 })
  assert.equal(value.machine.status, 'ready')
  await assert.rejects(connect.waitForCloudReady(async () => ({ connected: false }), { wait: async () => {} }), /expired/)
  await assert.rejects(connect.waitForCloudReady(async () => ({ connected: true, machine: { status: 'starting' } }), { wait: async () => {}, attempts: 2 }), /still preparing/)
})
test('cloud copy uses a filtered export and import without changing the local source', async () => {
  const calls = [], bundle = { workspace: 'filtered' }
  const result = await connect.copyLocalSandbox({ cloudExport: async name => { calls.push(['export', name]); return { bundle, warning: 'Reconnect agents' } } }, { importCloud: async value => { calls.push(['import', value]); return {name:'cloud-copy'} } }, 'local-source')
  assert.deepEqual(calls, [['export', 'local-source'], ['import', bundle]])
  assert.deepEqual(result, {name:'cloud-copy',warning:'Reconnect agents'})
})

test('cloud-to-local return tabs always import locally despite a remembered cloud selection', () => {
  assert.equal(compute.initialComputeTarget('http://localhost:4600/?handoff=cloud#cloud-return=nonce', {getItem:()=> 'cloud'}), 'local')
})
test('preparation reports capacity and machine errors immediately', async () => {
  await assert.rejects(connect.waitForCloudReady(async () => ({ connected:true,error:'Fleet capacity reached' }), {wait:async()=>{},attempts:1}), /Fleet capacity reached/)
})
test('explicit preparation mutates once then polls the selected cloud owner', async () => {
  const calls = [], progress = []
  const request = async (path, body, options) => {
    calls.push({ path, body, owner: options.owner })
    return { connected: true, owner: 'selected-owner', machine: { status: calls.length === 1 ? 'starting' : 'ready' } }
  }
  const value = await connect.prepareCloudMachine({ owner: 'selected-owner', request, wait: async () => {}, onProgress: value => progress.push(value.machine.status) })
  assert.equal(value.machine.status, 'ready')
  assert.deepEqual(calls, [{ path: 'machine', body: {}, owner: 'selected-owner' }, { path: 'machine', body: undefined, owner: 'selected-owner' }])
  assert.deepEqual(progress, ['starting', 'ready'])
})
test('preparation never accepts another owner or allocates after cancellation', async () => {
  await assert.rejects(connect.prepareCloudMachine({ owner: 'alice', request: async () => ({ connected: true, owner: 'bob', machine: { status: 'ready' } }) }), /account changed/)
  const controller = new AbortController(); controller.abort()
  await assert.rejects(connect.prepareCloudMachine({ owner: 'alice', signal: controller.signal, request: async () => assert.fail('cancelled preparation must not allocate') }), { name: 'AbortError' })
})

test('local sign-in exchanges identity and closes the popup without selecting compute or preparing a machine', async () => {
  const calls = [], identity = {connected:true,user:{uid:'google-user',email:'user@example.com'},expires:Date.now()+60000}
  const flow = signInHarness(async (path,body) => { calls.push({path,body});return path === 'start' ? {nonce:'attempt',url:'https://cloud.example.test/'} : identity })
  await flush();flow.receive('attempt')
  assert.equal(await flow.attempt.promise,identity)
  assert.equal(flow.popup.closed,true)
  assert.deepEqual(calls.map(call=>call.path),['start','finish'])
})
test('failed local sign-in rejects instead of publishing authenticated identity', async () => {
  const flow = signInHarness(async path => { if(path==='start')return {nonce:'attempt',url:'https://cloud.example.test/'}; if(path==='finish')throw Error('Code expired');return {connected:false} })
  const rejected = assert.rejects(flow.attempt.promise,/Code expired/)
  await flush();flow.receive('attempt')
  await rejected
  assert.equal(flow.listeners.size,0)
})
test('authenticated popup returns the exchange code automatically using the fixed cloud endpoint', async () => {
  const handoff = {origin:'http://localhost:4600',nonce:'12345678-1234-1234-1234-123456789abc',challenge:'b'.repeat(64)}
  const code = 'a'.repeat(64)+'.'+'c'.repeat(64), requests = []
  const result = await connect.authorizeLocalConnection(handoff, async (path, options) => { requests.push({path, options}); return {ok:true,json:async()=>({code})} })
  assert.equal(result.code, code)
  assert.equal(requests[0].path, '/api/cloud/local-connect/authorize')
  assert.deepEqual(JSON.parse(requests[0].options.body), handoff)
  await assert.rejects(connect.authorizeLocalConnection(handoff,async()=>({ok:true,json:async()=>({code:'credential'})})), /Invalid sign-in response/)
})
test('pending image recipes are isolated by compute target', () => {
  assert.notEqual(compute.computeStorageKey('recipe','local'), compute.computeStorageKey('recipe','cloud'))
  compute.setComputeTarget('cloud')
  assert.equal(compute.computeStorageKey('recipe'), 'recipe:cloud')
  compute.setComputeTarget('local')
})

test('cloud recipe recovery cannot load the prior local draft', () => {
  const entries = new Map([['recipe',JSON.stringify({recipe:{name:'legacy-local'}})],['recipe:cloud',JSON.stringify({recipe:{name:'remote-build'}})]])
  const storage = {getItem:key=>entries.get(key) ?? null}
  assert.equal(compute.pendingComputeRecipe('recipe', storage, 'local').recipe.name, 'legacy-local')
  assert.equal(compute.pendingComputeRecipe('recipe', storage, 'cloud').recipe.name, 'remote-build')
  entries.delete('recipe:cloud')
  assert.equal(compute.pendingComputeRecipe('recipe', storage, 'cloud'), null)
})

test('saving and clearing local recipe recovery does not resurrect the legacy draft or clear a cloud draft', () => {
  const entries = new Map([['recipe','legacy'],['recipe:cloud','cloud-draft']])
  const storage = {getItem:key=>entries.get(key)??null,setItem:(key,value)=>entries.set(key,value),removeItem:key=>entries.delete(key)}
  compute.saveComputeRecipe('recipe',{recipe:{name:'new-local'}},storage,'local')
  assert.equal(entries.has('recipe'),false)
  assert.equal(compute.pendingComputeRecipe('recipe',storage,'local').recipe.name,'new-local')
  compute.clearComputeRecipe('recipe',storage,'local')
  assert.equal(compute.pendingComputeRecipe('recipe',storage,'local'),null)
  assert.equal(entries.get('recipe:cloud'),'cloud-draft')
})

const deferred = () => { let resolve, reject; const promise = new Promise((yes,no)=>{resolve=yes;reject=no}); return {promise,resolve,reject} }
const flush = () => new Promise(resolve=>setImmediate(resolve))
function signInHarness(request, options = {}) {
  const listeners = new Set(), navigated = []
  const popup = {closed:false,close(){this.closed=true},location:{set href(value){navigated.push(value)}}}
  const events = {addEventListener:(_type,listener)=>listeners.add(listener),removeEventListener:(_type,listener)=>listeners.delete(listener)}
  const attempt = connect.createLocalSignInAttempt({popup,origin:'http://localhost:4600',cloud:CLOUD,request,events,focus:()=>{},setTimer:()=>1,clearTimer:()=>{},...options})
  const receive = (nonce, type = 'openrod-local-connected') => { for (const listener of listeners) listener({source:popup,origin:CLOUD,data:{type,nonce,code:'a'.repeat(64)+'.'+'b'.repeat(64)}}) }
  return {attempt,popup,navigated,receive,listeners}
}
test('a sign-in after disconnect asks the cloud console for an account choice', async () => {
  const url = 'https://cloud.example.test/?handoff=1#local-connect=abc'
  const fresh = signInHarness(async () => ({nonce:'attempt-a',url}))
  const choosing = signInHarness(async () => ({nonce:'attempt-b',url}), {chooseAccount:true})
  await flush()
  assert.deepEqual(fresh.navigated,[url])
  assert.deepEqual(choosing.navigated,['https://cloud.example.test/?handoff=1&account=choose#local-connect=abc'])
  assert.equal(connect.choosesAccount('?handoff=1&account=choose'),true)
  assert.equal(connect.choosesAccount('?handoff=1'),false)
})
test('cancelling before delayed start suppresses popup navigation and cancels the returned nonce', async () => {
  const start = deferred(), calls = []
  const flow = signInHarness(async (path,body)=>{calls.push({path,body});return path==='start'?start.promise:{connected:false}})
  const rejected = assert.rejects(flow.attempt.promise,/cancelled/)
  await flush()
  flow.attempt.cancel('Sign-in cancelled.')
  await rejected
  start.resolve({nonce:'attempt-a',url:'https://cloud.example.test/authorize-a'})
  await flush()
  assert.deepEqual(flow.navigated,[])
  assert.equal(flow.listeners.size,0)
  assert.deepEqual(calls,[{path:'start',body:{origin:'http://localhost:4600'}},{path:'cancel',body:{nonce:'attempt-a'}}])
})
test('late cancelled redemption cannot disconnect a newer successful sign-in', async () => {
  const oldFinish = deferred(), calls = [], identity = {connected:true,user:{uid:'new-user'},expires:Date.now()+60000}
  let generation = 0
  const request = async (path,body) => {
    calls.push({path,body})
    if (path==='start') return {nonce:`attempt-${++generation}`,url:`https://cloud.example.test/authorize-${generation}`}
    if (path==='finish') return body.nonce==='attempt-1'?oldFinish.promise:identity
    return {connected:false}
  }
  const old = signInHarness(request)
  await flush();old.receive('attempt-1');await flush()
  const rejected = assert.rejects(old.attempt.promise,/cancelled/)
  old.attempt.cancel('Sign-in cancelled.');await rejected
  const current = signInHarness(request)
  await flush();current.receive('attempt-2')
  assert.equal(await current.attempt.promise,identity)
  oldFinish.resolve({connected:true,user:{uid:'old-user'},expires:Date.now()+60000})
  await flush()
  assert.equal(calls.some(call=>call.path==='disconnect'),false)
  assert.deepEqual(calls.filter(call=>call.path==='cancel').map(call=>call.body.nonce),['attempt-1','attempt-1'])
  assert.equal(old.listeners.size,0)
  assert.equal(current.listeners.size,0)
})

test('a cloud return message redeems only once and closes the popup', async () => {
  const calls = [], identity = {connected:true,user:{uid:'user'}}
  const flow = signInHarness(async path => { calls.push(path); return path === 'start' ? {nonce:'attempt',url:CLOUD} : identity })
  await flush()
  flow.receive('attempt', 'openrod-local-connected')
  flow.receive('attempt', 'openrod-local-connected')
  assert.equal(await flow.attempt.promise, identity)
  assert.equal(flow.popup.closed, true)
  assert.deepEqual(calls, ['start','finish'])
})
