import test from 'node:test'
import assert from 'node:assert/strict'
import * as module from './api.js'
import { setComputeTarget, advanceComputeOwner, setCloudOwner } from './compute-target.js'
import { terminalHref } from './sandbox-session.js'

test('a workflow API keeps requests and downloads pinned through target changes', async () => {
  const paths = [], oldFetch = globalThis.fetch
  globalThis.fetch = async path => { paths.push(path); return { ok: true, json: async () => ({}) } }
  try {
    const local = module.createApi('local', undefined, '["local-gw","default"]'), cloud = module.createApi('cloud', undefined, '["cloud-gw","default"]')
    await local.startUpload('demo')
    setComputeTarget('cloud')
    await local.commitUpload('demo', 'upload', '.')
    await cloud.sandbox('demo')
    assert.deepEqual(paths, ['/api/os/files/demo/uploads', '/api/os/files/demo/uploads/upload/commit', '/api/remote/os/sandboxes/demo'])
    assert.equal(cloud.path('/downloads/token'), '/api/remote/os/downloads/token')
  } finally { globalThis.fetch = oldFetch; setComputeTarget('local') }
})
test('retired target workflow cannot send a later request', async () => {
  const oldFetch = globalThis.fetch, controller = new AbortController()
  let calls = 0
  globalThis.fetch = async () => { calls++; return { ok: true, json: async () => ({}) } }
  try {
    const api = module.createApi('cloud', controller.signal)
    controller.abort()
    await assert.rejects(api.create({name:'demo'}), {name:'AbortError'})
    assert.equal(calls, 0)
  } finally { globalThis.fetch = oldFetch }
})
test('terminal links explicitly pin the selected target in each new tab', () => {
  setComputeTarget('cloud')
  assert.equal(terminalHref('demo', 'shell'), '?target=cloud#terminal/demo?session=shell')
  assert.equal(terminalHref('demo', undefined, 'local'), '?target=local#terminal/demo')
  setComputeTarget('local')
})

test('late responses from retired targets reject instead of navigating or publishing stale results', async () => {
  const oldFetch = globalThis.fetch, controller = new AbortController()
  let release
  globalThis.fetch = async () => ({ ok: true, json: () => new Promise(resolve => { release = resolve }) })
  try {
    const result = module.createApi('cloud', controller.signal, '["gw","default"]').create({name:'demo'})
    await new Promise(resolve => setImmediate(resolve))
    controller.abort()
    release({name:'demo'})
    await assert.rejects(result, {name:'AbortError'})
  } finally { globalThis.fetch = oldFetch }
})

test('location context stays attached to cloud requests and uploads', async () => {
  const calls = [], oldFetch = globalThis.fetch
  globalThis.fetch = async (path, options) => { calls.push({path,options}); return {ok:true,json:async()=>({})} }
  try {
    const cloud = module.createApi('cloud').forContext('["cloud-gw","team"]')
    await cloud.create({name:'demo'})
    await cloud.uploadFile('demo','upload','x.txt',new Uint8Array([1]))
    assert.deepEqual(calls.map(call=>call.path), ['/api/remote/os/sandboxes','/api/remote/os/files/demo/uploads/upload?path=x.txt'])
    for (const {options} of calls) {
      assert.equal(options.headers['x-openshell-context'], '["cloud-gw","team"]')
      assert.equal(options.headers['x-openshell-location'],'1')
    }
    assert.equal(await cloud.contextKey(),'["cloud-gw","team"]')
  } finally {globalThis.fetch=oldFetch}
})
test('terminal links preserve both gateway/workspace and compute target', () => {
  assert.equal(terminalHref('demo','shell',{gateway:'gw',workspace:'team'},'cloud'),'?target=cloud#terminal/demo?session=shell&gateway=gw&workspace=team')
})

test('automatic context discovery is pinned to the API compute target', async () => {
  const calls = [], oldFetch = globalThis.fetch
  globalThis.fetch = async (path, options) => { calls.push({path,options}); return {ok:true,json:async()=>path.endsWith('/context') ? {gateway:'cloud-gw',workspace:'team',configured:true} : {}} }
  try {
    const cloud = module.createApi('cloud')
    setComputeTarget('local')
    await cloud.sandbox('demo')
    assert.deepEqual(calls.map(call=>call.path),['/api/remote/os/context','/api/remote/os/sandboxes/demo'])
    assert.equal(calls[1].options.headers['x-openshell-context'],'["cloud-gw","team"]')
  } finally {globalThis.fetch=oldFetch;setComputeTarget('local')}
})

test('first sign-in preserves its workflow, but disconnect and account replacement retire it', () => {
  const first = advanceComputeOwner({uid:null,revision:0},'alice')
  assert.equal(first.revision,0)
  const same = advanceComputeOwner(first,'alice')
  assert.equal(same.revision,0)
  const disconnected = advanceComputeOwner(same,null)
  assert.equal(disconnected.revision,1)
  assert.equal(advanceComputeOwner(first,'bob').revision,1)
  assert.equal(advanceComputeOwner(disconnected,'bob').revision,1)
})

test('a retained browser API and its scoped child keep the verified owner through another account change', async () => {
  const calls = [], oldFetch=globalThis.fetch
  globalThis.fetch=async(path,options)=>{calls.push({path,options});return {ok:true,json:async()=>({})}}
  try {
    setCloudOwner('aaaaaaaaaaaaaaaa')
    const retained=module.createApi('cloud',undefined,'["gw","default"]')
    setCloudOwner('bbbbbbbbbbbbbbbb')
    await retained.sandbox('demo')
    await retained.forContext('["gw","team"]').lifecycle('demo','delete')
    assert.equal(retained.url('/terminal',{ticket:'ticket'}),'/api/remote/os/terminal?ticket=ticket&owner=aaaaaaaaaaaaaaaa')
    assert.equal(retained.url('/downloads/file'),'/api/remote/os/downloads/file?owner=aaaaaaaaaaaaaaaa')
    for(const call of calls)assert.equal(call.options.headers['x-openrod-local-owner'],'aaaaaaaaaaaaaaaa')
  }finally{globalThis.fetch=oldFetch;setCloudOwner(null)}
})
