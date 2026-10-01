import test from 'node:test'
import assert from 'node:assert/strict'
import { coveredBySetupPolicy, inSetupPolicy, policyRows, setupAccess } from './setup-network.js'

const SETUP = 'a'.repeat(24), OTHER = 'b'.repeat(24)
const policy = { id: `setup-${SETUP}`, action: 'allow', destinations: ['api.github.com', '**.linear.app'], appliesTo: { everyone: false, groups: [], sandboxes: [], setups: [SETUP] }, advanced: { ports: [443] } }
const github = { phase: 'runtime', host: 'api.github.com', port: 443 }

test('a setup policy covers its own hosts and ports, and the snapshots prepared from it', () => {
  assert.equal(coveredBySetupPolicy([policy], { id: SETUP }, github), true)
  assert.equal(coveredBySetupPolicy([policy], { id: OTHER, preparedFrom: { id: SETUP } }, github), true)
  assert.equal(coveredBySetupPolicy([policy], { id: SETUP }, { host: 'mcp.linear.app', port: 443 }), true)
  assert.equal(coveredBySetupPolicy([policy], { id: SETUP }, { host: 'api.github.com', port: 8443 }), false)
  assert.equal(coveredBySetupPolicy([policy], { id: OTHER }, github), false)
  assert.equal(coveredBySetupPolicy([{ ...policy, action: 'block' }], { id: SETUP }, github), false)
  assert.equal(coveredBySetupPolicy([{ ...policy, appliesTo: { everyone: true, groups: [], sandboxes: [] } }], { id: SETUP }, github), false)
  // Narrowed in Egress, the server asks for a grant, so the browser must not call it covered.
  for (const narrowed of [{ programs: ['/usr/bin/node'] }, { requests: 'read-only' }, { deny: [{ method: 'POST', path: '/**' }] }, { privateIps: ['10.0.0.0/8'] }]) assert.equal(coveredBySetupPolicy([{ ...policy, advanced: { ...policy.advanced, ...narrowed } }], { id: SETUP }, github), false)
})

test('the setup policy takes runtime hosts and the MCP’s own sign-in host, never credentialed or named sign-in services', () => {
  const remote = { requirements: [{ phase: 'runtime', host: 'mcp.linear.app' }, { phase: 'auth', host: 'MCP.linear.app', path: '/.well-known/**' }, { phase: 'auth', host: 'auth.example.net' }, { phase: 'build', host: 'registry.npmjs.org' }] }
  assert.deepEqual(remote.requirements.map(r => inSetupPolicy(remote, r)), [true, true, false, false])
  const keyed = { ...remote, credentialRef: { provider: 'mcp-x' } }
  assert.deepEqual(keyed.requirements.map(r => inSetupPolicy(keyed, r)), [false, false, false, false])
  assert.equal(inSetupPolicy({ credentialFields: ['TOKEN'], requirements: [] }, { phase: 'runtime', host: 'api.github.com' }), false)
})

test('setup access lists covered hosts apart from the ones that still need approval', () => {
  const requirements = { [SETUP]: [github, { phase: 'build', host: 'registry.npmjs.org', port: 443 }, { phase: 'auth', host: 'login.example.com', port: 443, path: '/oauth' }], [OTHER]: [{ phase: 'runtime', host: 'api.github.com', port: 443 }, { phase: 'runtime', host: 'api.other.dev', port: 8443 }] }
  const of = setup => [{ requirements: requirements[setup.id] }]
  assert.deepEqual(setupAccess([{ id: SETUP }], [policy], of), { covered: ['api.github.com'], uncovered: ['login.example.com/oauth'] })
  // Another setup still needs the same host, so it stays in the approval list.
  assert.deepEqual(setupAccess([{ id: SETUP }, { id: OTHER }], [policy], of), { covered: [], uncovered: ['login.example.com/oauth', 'api.github.com', 'api.other.dev:8443'] })
  // Policies that failed to load fall back to approving every host.
  assert.deepEqual(setupAccess([{ id: SETUP }], null, of), { covered: [], uncovered: ['api.github.com', 'login.example.com/oauth'] })
  // A policy opens whole hosts, so covered paths of one host are one row.
  const linear = { [SETUP]: [{ phase: 'runtime', host: 'mcp.linear.app', port: 443, path: '/mcp' }, { phase: 'auth', host: 'mcp.linear.app', port: 443, path: '/.well-known/**' }] }
  assert.deepEqual(setupAccess([{ id: SETUP }], [policy], setup => [{ requirements: linear[setup.id] }]), { covered: ['mcp.linear.app'], uncovered: [] })
  // An MCP that sends credentials keeps its per-sandbox grant even when the policy lists the host.
  assert.deepEqual(setupAccess([{ id: SETUP }], [policy], () => [{ credentialRef: { provider: 'mcp-x' }, requirements: [github] }]), { covered: [], uncovered: ['api.github.com'] })
})

test('policy rows show every allowed website with the MCPs that need it', () => {
  const saved = { destinations: ['api.github.com', 'mcp.linear.app', 'extra.example.com'], hosts: [{ host: 'api.github.com', items: ['GitHub'] }, { host: 'api.github.com', items: ['GitHub', 'Issues'] }, { host: 'mcp.linear.app', items: ['Linear'] }, { host: 'pastebin.com', items: ['Paste'] }], blocked: ['pastebin.com'] }
  assert.deepEqual(policyRows(saved), [{ host: 'api.github.com', items: ['GitHub', 'Issues'] }, { host: 'mcp.linear.app', items: ['Linear'] }, { host: 'extra.example.com', items: [] }])
  assert.deepEqual(policyRows({ hosts: [{ host: 'api.github.com', items: ['GitHub'] }, { host: 'pastebin.com', items: ['Paste'] }], blocked: ['pastebin.com'] }), [{ host: 'api.github.com', items: ['GitHub'] }])
})
