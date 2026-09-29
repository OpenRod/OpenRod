import test from 'node:test'
import assert from 'node:assert/strict'
import { compileFor, validatePolicy } from './egress.js'

const policy = (over) => validatePolicy({ id: 'p', name: 'P', action: 'allow', destinations: ['github.com'], appliesTo: { everyone: true }, ...over })
const ports = (e) => e.ports ?? [e.port]

test('an allow with defaults opens the web ports without inspection, for any program', () => {
  const rules = compileFor({ name: 'a', group: null }, [policy()])
  const rule = rules.egress_p
  assert.deepEqual(rule.binaries.map((b) => b.path), ['/**'])
  assert.equal(rule.endpoints[0].protocol, '')
  assert.deepEqual(ports(rule.endpoints[0]), [443, 80])
})

test('Advanced requests turn on inspection', () => {
  const rules = compileFor({ name: 'a', group: null }, [policy({ advanced: { requests: 'read-only', ports: [443] } })])
  assert.equal(rules.egress_p.endpoints[0].protocol, 'rest')
  assert.equal(rules.egress_p.endpoints[0].access, 1)
})

test('a block denies every request on the host and its subdomains, on every port the allows open', () => {
  const rules = compileFor({ name: 'a', group: null }, [
    policy({ advanced: { ports: [8443] } }),
    validatePolicy({ id: 'b', name: 'B', action: 'block', destinations: ['gist.github.com'], appliesTo: { everyone: true } }),
  ], ['pastebin.com'])
  const block = rules.egress_b
  assert.deepEqual(block.endpoints.map((e) => e.host), ['gist.github.com', '**.gist.github.com'])
  assert.deepEqual(ports(block.endpoints[0]), [80, 443, 8443])
  assert.deepEqual(block.endpoints[0].denyRules.map((r) => r.path), ['/', '/**'])
  assert.deepEqual(rules.org_blocked.endpoints.map((e) => e.host), ['pastebin.com', '**.pastebin.com'])
})

test('a block also covers the ports the sandbox opens on its own', () => {
  const block = validatePolicy({ id: 'b', name: 'B', action: 'block', destinations: ['db.example.com'], appliesTo: { everyone: true } })
  const rules = compileFor({ name: 'a', group: null }, [block], ['pastebin.com'], [5432, 443])
  assert.deepEqual(ports(rules.egress_b.endpoints[0]), [80, 443, 5432])
  assert.deepEqual(ports(rules.org_blocked.endpoints[0]), [80, 443, 5432])
})

test('a policy reaches only the sandboxes it applies to', () => {
  const p = policy({ appliesTo: { groups: ['coding'], sandboxes: ['one'] } })
  assert.ok(compileFor({ name: 'x', group: 'coding' }, [p]).egress_p)
  assert.ok(compileFor({ name: 'one', group: null }, [p]).egress_p)
  assert.deepEqual(compileFor({ name: 'x', group: null }, [p]), {})
})

test('hosts OpenShell would reject are refused up front', () => {
  assert.throws(() => policy({ destinations: ['*'] }), /OpenShell support/)
  assert.throws(() => policy({ destinations: ['**.com'] }), /too broad/)
})
