import test from 'node:test'
import assert from 'node:assert/strict'
import * as module from './api.js'
import { setComputeTarget } from './compute-target.js'
import { terminalHref } from './sandbox-session.js'

test('a workflow API keeps requests and downloads pinned through target changes', async () => {
  const paths = [], oldFetch = globalThis.fetch
  globalThis.fetch = async path => { paths.push(path); return { ok: true, json: async () => ({}) } }
  try {
    const local = module.createApi('local'), cloud = module.createApi('cloud')
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
    const result = module.createApi('cloud', controller.signal).create({name:'demo'})
    await new Promise(resolve => setImmediate(resolve))
    controller.abort()
    release({name:'demo'})
    await assert.rejects(result, {name:'AbortError'})
  } finally { globalThis.fetch = oldFetch }
})
