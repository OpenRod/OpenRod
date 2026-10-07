import test from 'node:test'
import assert from 'node:assert/strict'
import { ownerOf } from './sandboxes.js'

const user = { uid: 'TestOwnerUid000000000000001', email: 'owner@example.com' }

test('existing UID ownership displays the matching Google email without changing the record', () => {
  const sandbox = { labels: { 'openshell.console/owner': user.uid } }
  assert.equal(ownerOf(sandbox, user), user.email)
  assert.equal(sandbox.labels['openshell.console/owner'], user.uid)
  assert.equal(ownerOf({ owner: user.uid }, user), user.email)
})

test('account changes and missing emails never attribute another owner to the viewer', () => {
  const sandbox = { labels: { 'openshell.console/owner': user.uid } }
  assert.equal(ownerOf(sandbox, { uid: 'another-user', email: 'other@example.com' }), user.uid)
  assert.equal(ownerOf(sandbox), user.uid)
  assert.equal(ownerOf(sandbox, { uid: user.uid }), user.uid)
})

test('local owners, legacy labels, and missing ownership retain their display', () => {
  assert.equal(ownerOf({ owner: 'local-operator' }, user), 'local-operator')
  assert.equal(ownerOf({ labels: { owner: 'legacy-operator' } }, user), 'legacy-operator')
  assert.equal(ownerOf({ owner: 'explicit-owner', labels: { 'openshell.console/owner': user.uid } }, user), 'explicit-owner')
  assert.equal(ownerOf({}, user), 'Not reported')
})
