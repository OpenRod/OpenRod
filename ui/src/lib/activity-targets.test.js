import test from 'node:test'
import assert from 'node:assert/strict'
import { hostOf, portOf } from './policy-sources.js'
import { foldTraffic } from './fleet.js'
test('full HTTP evidence keeps egress host and port aggregation correct', () => {
  assert.equal(hostOf('https://example.com:8443/path?q=1'), 'example.com')
  assert.equal(portOf('https://example.com:8443/path?q=1'), 8443)
  assert.equal(portOf('http://example.com/path'), 80)
  assert.equal(portOf('example.com:443'), 443)
  assert.equal(hostOf('example.com:443'), 'example.com')
  const traffic = foldTraffic([{ kind: 'audit', verdict: 'allowed', sandbox: 'box', destination: 'https://example.com:8443/path' }])
  assert.equal(traffic.hosts[0].host, 'example.com')
})
