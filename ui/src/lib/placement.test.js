import test from 'node:test'
import assert from 'node:assert/strict'
import { placementOf } from './placement.js'

test('placement follows the gateway report', () => {
  assert.equal(placementOf({ remote: false }), 'local')
  assert.equal(placementOf({ remote: true }), 'remote')
  assert.equal(placementOf({ remote: true, placement: 'cloud' }), 'cloud')
  assert.equal(placementOf({ target: 'cloud', remote: false }), 'cloud')
  assert.equal(placementOf({ cloud: true, target: 'local' }), 'cloud')
  assert.equal(placementOf({ remote: true, placement: 'mainframe' }), 'remote')
  assert.equal(placementOf(undefined), 'local')
})
