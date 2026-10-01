import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cloudHandoffUrl, isCloudReadyMessage, CLOUD_ORIGIN } from './cloud-transfer.js'

test('handoff URL contains only local origin and fresh nonce', () => {
  const url = new URL(cloudHandoffUrl('http://localhost:5173', 'fresh-nonce'))
  assert.equal(url.origin, CLOUD_ORIGIN)
  assert.equal(url.searchParams.get('handoff'), '1')
  assert.deepEqual(JSON.parse(Buffer.from(url.hash.slice('#handoff='.length), 'base64url')), { origin: 'http://localhost:5173', nonce: 'fresh-nonce' })
})

test('ticket messages require exact cloud origin, popup source and nonce', () => {
  const popup = {}
  const event = { origin: CLOUD_ORIGIN, source: popup, data: { type: 'openrod-cloud-ready', nonce: 'nonce', ticket: ('openrod-user-' + 'a'.repeat(24) + '.' + 'b'.repeat(64)) } }
  assert.equal(isCloudReadyMessage(event, popup, 'nonce'), true)
  for (const changed of [{ origin: 'https://evil.test' }, { source: {} }, { data: { ...event.data, nonce: 'old' } }, { data: { ...event.data, type: 'other' } }, { data: { ...event.data, ticket: '' } }]) assert.equal(isCloudReadyMessage({ ...event, ...changed }, popup, 'nonce'), false)
  assert.equal(isCloudReadyMessage(event, null, 'nonce'), false)
})

test('return handoff fixes local destination and binds messages to the opened window', async () => {
  const { LOCAL_ORIGIN, localHandoffUrl, isLocalHandoffMessage } = await import('./cloud-transfer.js')
  assert.equal(localHandoffUrl('nonce'), 'http://127.0.0.1:4600/?handoff=cloud#cloud-return=nonce')
  const popup = {}
  const event = { origin: LOCAL_ORIGIN, source: popup, data: { type: 'openrod-local-ready', nonce: 'nonce' } }
  assert.equal(isLocalHandoffMessage(event, popup, 'nonce', 'openrod-local-ready'), true)
  for (const changed of [{ origin: 'http://localhost:4600' }, { source: {} }, { data: { ...event.data, nonce: 'other' } }, { data: { ...event.data, type: 'openrod-local-result' } }]) assert.equal(isLocalHandoffMessage({ ...event, ...changed }, popup, 'nonce', 'openrod-local-ready'), false)
})
