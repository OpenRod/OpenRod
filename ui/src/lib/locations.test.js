import test from 'node:test'
import assert from 'node:assert/strict'
import { connectLocalGateway } from './locations.js'

const fakeApi = (first, ...later) => {
  const calls = []
  return { calls, connect: async (body) => { calls.push(['connect', body]); return first }, connectionJob: async (id) => { calls.push(['job', id]); return later.shift() } }
}

test('a local gateway that is ready at once needs no polling', async () => {
  const api = fakeApi({ id: 'a', status: 'ready', gateway: 'openshell' })
  assert.equal((await connectLocalGateway(api, 'openshell', 0)).gateway, 'openshell')
  assert.deepEqual(api.calls, [['connect', { localGateway: 'openshell' }]])
})

test('a working job is polled until it is ready', async () => {
  const api = fakeApi({ id: 'a', status: 'working' }, { id: 'a', status: 'working' }, { id: 'a', status: 'ready' })
  assert.equal((await connectLocalGateway(api, 'openshell', 0)).status, 'ready')
  assert.deepEqual(api.calls.map(([kind]) => kind), ['connect', 'job', 'job'])
})

test('a failed job rejects with its error', async () => {
  await assert.rejects(connectLocalGateway(fakeApi({ id: 'a', status: 'working' }, { id: 'a', status: 'failed', error: 'Gateway unreachable' }), 'openshell', 0), { message: 'Gateway unreachable' })
  await assert.rejects(connectLocalGateway(fakeApi({ id: 'a', status: 'failed' }), 'openshell', 0), { message: 'Couldn’t connect to openshell.' })
})

test('a rejected connect request is not swallowed', async () => {
  const api = { connect: async () => { throw new Error('A connection operation is already running.') } }
  await assert.rejects(connectLocalGateway(api, 'openshell', 0), { message: 'A connection operation is already running.' })
})
