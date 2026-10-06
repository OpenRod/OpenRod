import test from 'node:test'
import assert from 'node:assert/strict'
import { directLocation } from './location-choice.js'

const local = { target: 'local', context: '["local","default"]', remote: false, connected: true }
const remote = { target: 'local', context: '["ssh","default"]', remote: true, connected: true }
test('a Local-only console acts on This computer without asking', () => {
  assert.equal(directLocation([local]), local)
})
test('any Remote, even a disconnected saved one, keeps the choice', () => {
  assert.equal(directLocation([local, remote]), null)
  assert.equal(directLocation([local, { ...remote, connected: false }]), null)
})
test('an unreachable or missing Local still asks, so it can be connected', () => {
  assert.equal(directLocation([{ ...local, connected: false }]), null)
  assert.equal(directLocation([]), null)
})
test('Cloud next to This computer keeps the choice', () => {
  const cloud = { target: 'cloud', context: '["cloud","default"]', remote: false, connected: true }
  assert.equal(directLocation([local, cloud]), null)
  assert.equal(directLocation([cloud, local]), null)
})
