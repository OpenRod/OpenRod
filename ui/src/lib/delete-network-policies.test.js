import test from 'node:test'
import assert from 'node:assert/strict'
import { deleteNetworkPolicies } from './delete-network-policies.js'

test('bulk deletion is sequential, continues after failures, and separates sync failures', async () => {
  const calls = []
  let active = 0
  const policies = ['first', 'protected', 'last'].map((id) => ({ id, name: id }))
  const result = await deleteNetworkPolicies(policies, async (id) => {
    assert.equal(active++, 0, 'requests must not race group coverage checks')
    calls.push(id)
    await Promise.resolve()
    active--
    if (id === 'protected') throw new Error('Last network rule for an occupied group')
    return { failed: id === 'last' ? [{ sandbox: 'web', error: 'Offline' }] : [] }
  })
  assert.deepEqual(calls, ['first', 'protected', 'last'])
  assert.deepEqual(result.deleted, ['first', 'last'])
  assert.deepEqual(result.failed, [{ id: 'protected', name: 'protected', message: 'Last network rule for an occupied group' }])
  assert.deepEqual(result.syncFailures, [{ sandbox: 'web', error: 'Offline', rule: 'last' }])
})

test('single deletion uses the same result contract', async () => {
  const result = await deleteNetworkPolicies([{ id: 'one', name: 'One' }], async (id) => { assert.equal(id, 'one'); return {} })
  assert.deepEqual(result, { deleted: ['one'], failed: [], syncFailures: [] })
})
