import test from 'node:test'
import assert from 'node:assert/strict'
import { agentAccessFor, agentAccessRules } from '../shared/agent-access.js'
import { planSandbox, addAgentAccess } from './org.js'
import { ruleToProto } from './policy.js'

test('Cursor agent transport retains scoped TLS passthrough through launch composition', async () => {
  const rules = agentAccessRules({ source: 'build', agents: ['cursor'] })
  const { policy } = await planSandbox({ template: 'locked-down', agentRules: rules })
  const rule = policy.networkPolicies['agent-cursor']
  const agent = rule.endpoints.find(e => e.host === 'agentn.global.api5.cursor.sh')
  assert.equal(agent.tls, 1)
  assert.equal(agent.port, 443)
  assert.equal(agent.protocol, '')
  assert.equal(agent.access, 0)
  assert(rule.binaries.every(b => b.path.includes('cursor-agent')))
  assert(rule.endpoints.filter(e => e.host !== agent.host).every(e => !e.tls && e.protocol === 'rest'))
  assert.throws(() => ruleToProto({ name: 'invalid', binaries: ['/usr/bin/node'], endpoints: [{ host: 'example.com', ports: [443], protocol: 'rest', access: 'read-write', tlsSkip: true }] }), /TLS passthrough requires plain TCP/)
})

const recipe = { source: 'build', agents: ['claude', 'codex', 'opencode'] }
test('multi-agent image gets additive access with a locked-down preset', async () => {
  const { policy } = await planSandbox({ template: 'locked-down', agentRules: agentAccessRules(recipe) })
  assert.deepEqual(Object.keys(policy.networkPolicies), ['agent-claude', 'agent-codex', 'agent-opencode'])
  const opencode = policy.networkPolicies['agent-opencode']
  assert(opencode.binaries.some(b => b.path === '/usr/local/lib/node_modules/opencode-ai/bin/opencode.exe'))
  assert(opencode.endpoints.some(e => e.host === 'opencode.ai' && e.port === 443 && e.access === 2))
  assert(opencode.endpoints.some(e => e.host === 'models.opencode.ai' && e.access === 1))
  assert(!opencode.binaries.some(b => b.path === '/usr/local/bin/node' || b.path === '*'))
  assert(opencode.endpoints.some(e => e.host === 'api.anthropic.com'))
  assert.equal(policy.filesystem.includeWorkdir, true)
})
test('runtime requirements cannot be replaced by recipe-supplied policy or unknown IDs', () => {
  const rules = agentAccessRules({ ...recipe, agents: ['opencode', 'opencode'], policy: { host: '*' } })
  assert.equal(rules.length, 1)
  assert(rules[0].endpoints.every(e => e.host !== '*'))
  assert.throws(() => agentAccessRules({ ...recipe, agents: ['unreviewed'] }), /not configured/)
  assert.deepEqual(agentAccessFor({ source: 'image', agents: ['opencode'] }).profiles, [])
})
test('ordinary sandboxes retain their selected policy; agent requirements expose blocked destinations', async () => {
  const { policy } = await planSandbox({ template: 'locked-down' })
  assert.deepEqual(policy.networkPolicies, {})
  assert.throws(() => addAgentAccess(policy, agentAccessRules(recipe), { blocked: ['*.opencode.ai'] }), /organization blocks/)
  assert.deepEqual(policy.networkPolicies, {})
  assert.throws(() => addAgentAccess({ networkPolicies: { 'agent-opencode': {} } }, agentAccessRules({ ...recipe, agents: ['opencode'] }), { blocked: [] }), /conflicts/)
})

 test('every offered agent has automatic, scoped access and composes at launch', async () => {
  const { AGENTS } = await import('../src/lib/image-templates.js')
  for (const agent of AGENTS) {
    const selected = { source: 'build', agents: [agent.id] }
    assert.deepEqual(agentAccessFor(selected).unsupported, [], agent.name)
    const rules = agentAccessRules(selected)
    assert.equal(rules.length, 1)
    assert(rules[0].binaries.length > 0)
    assert(rules[0].endpoints.length > 0)
    assert(rules[0].endpoints.every(e => e.host !== '*' && e.ports.every(p => p === 443)))
    const { policy } = await planSandbox({ template: 'locked-down', agentRules: rules })
    assert(policy.networkPolicies[`agent-${agent.id}`], agent.name)
  }
})
