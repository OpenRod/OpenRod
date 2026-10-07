import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cloudHandoffUrl, isCloudReadyMessage, CLOUD_ORIGIN as DEFAULT_ORIGIN } from './cloud-transfer.js'
const CLOUD_ORIGIN = 'https://cloud.example.test'

test('cloud handoffs default to the hosted console and refuse an explicitly disabled origin', () => {
  assert.equal(DEFAULT_ORIGIN, 'https://console.openrod.io')
  assert.equal(new URL(cloudHandoffUrl('http://localhost:5173', 'nonce')).origin, DEFAULT_ORIGIN)
  assert.throws(() => cloudHandoffUrl('http://localhost:5173', 'nonce', ''), /coming soon/)
})

test('handoff URL contains only local origin and fresh nonce', () => {
  const url = new URL(cloudHandoffUrl('http://localhost:5173', 'fresh-nonce', CLOUD_ORIGIN))
  assert.equal(url.origin, CLOUD_ORIGIN)
  assert.equal(url.searchParams.get('handoff'), '1')
  assert.deepEqual(JSON.parse(Buffer.from(url.hash.slice('#handoff='.length), 'base64url')), { origin: 'http://localhost:5173', nonce: 'fresh-nonce' })
})

test('ticket messages require exact cloud origin, popup source and nonce', () => {
  const popup = {}
  const event = { origin: CLOUD_ORIGIN, source: popup, data: { type: 'openrod-cloud-ready', nonce: 'nonce', ticket: ('openrod-user-' + 'a'.repeat(24) + '.' + 'b'.repeat(64)) } }
  assert.equal(isCloudReadyMessage(event, popup, 'nonce', CLOUD_ORIGIN), true)
  assert.equal(isCloudReadyMessage({ ...event, data: { ...event.data, ticket: 'legacy-worker-123.' + 'c'.repeat(64) } }, popup, 'nonce', CLOUD_ORIGIN), true)
  assert.equal(isCloudReadyMessage({ ...event, data: { ...event.data, ticket: '../worker.' + 'c'.repeat(64) } }, popup, 'nonce', CLOUD_ORIGIN), false)
  for (const changed of [{ origin: 'https://evil.test' }, { source: {} }, { data: { ...event.data, nonce: 'old' } }, { data: { ...event.data, type: 'other' } }, { data: { ...event.data, ticket: '' } }]) assert.equal(isCloudReadyMessage({ ...event, ...changed }, popup, 'nonce', CLOUD_ORIGIN), false)
  assert.equal(isCloudReadyMessage(event, null, 'nonce', CLOUD_ORIGIN), false)
})

test('return handoff fixes local destination and binds messages to the opened window', async () => {
  const { LOCAL_ORIGIN, localHandoffUrl, isLocalHandoffMessage } = await import('./cloud-transfer.js')
  assert.equal(localHandoffUrl('nonce'), 'http://127.0.0.1:4600/?handoff=cloud&target=local#cloud-return=nonce')
  const popup = {}
  const event = { origin: LOCAL_ORIGIN, source: popup, data: { type: 'openrod-local-ready', nonce: 'nonce' } }
  assert.equal(isLocalHandoffMessage(event, popup, 'nonce', 'openrod-local-ready'), true)
  for (const changed of [{ origin: 'http://localhost:4600' }, { source: {} }, { data: { ...event.data, nonce: 'other' } }, { data: { ...event.data, type: 'openrod-local-result' } }]) assert.equal(isLocalHandoffMessage({ ...event, ...changed }, popup, 'nonce', 'openrod-local-ready'), false)
})
