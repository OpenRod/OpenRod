import test from 'node:test'
import assert from 'node:assert/strict'
import { workingLocation } from './working-location.js'

const local = { target: 'local', context: '["local","default"]', remote: false, connected: true }
const remote = { target: 'local', context: '["ssh","default"]', remote: true, connected: false }
test('unscoped pages prefer reachable Local when the saved SSH gateway is offline', () => {
  assert.equal(workingLocation([remote, local], null), local)
  assert.equal(workingLocation([remote], null), null)
})
test('an explicit owner stays selected when it disconnects or disappears', () => {
  assert.equal(workingLocation([local, remote], { ...remote, connected: true }), remote)
  assert.deepEqual(workingLocation([local], remote), remote)
})
test('compute targets with identical gateway contexts stay separate', () => {
  const cloud = { ...local, target: 'cloud' }
  assert.equal(workingLocation([local, cloud], cloud), cloud)
  assert.equal(workingLocation([local, cloud], null, 'cloud'), cloud)
})