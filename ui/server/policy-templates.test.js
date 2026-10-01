import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createTemplateStore } from './policy-template-store.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import { BUILTIN_TEMPLATES, composeTemplate, normalizeAccessTemplates, toggleAccessTemplate } from '../shared/policy-templates.js'
import { agentAccessRules } from '../shared/agent-access.js'
import { AGENTS, dockerfileFor } from '../src/lib/image-templates.js'
import { quickRecipe } from '../src/lib/quick-setup.js'
import { findTemplate, listTemplates, validateTemplate, templateToPolicy } from './policy.js'
import { planSandbox, addAgentAccess } from './org.js'

test('catalog exposes Restricted and four additions while old Claude references still resolve', async () => {
  const catalog = await listTemplates()
  assert.deepEqual(catalog.filter(t => t.builtin).map(t => t.name), [
    'Restricted', 'GitHub - Read', 'GitHub - Read & Write', 'Python - Packages', 'Node.js - Packages',
  ])
  for (const id of ['claude-subscription', 'claude-github-readonly']) {
    assert(!catalog.some(t => t.id === id))
    assert((await findTemplate(id)).rules.length)
  }
})

test('every selected agent retains its installation recipe and connections with each access combination', async () => {
  for (const agent of AGENTS) {
    const recipe = quickRecipe([agent.id])
    assert.match(dockerfileFor(recipe), /RUN /)
    const agentRules = agentAccessRules(recipe)
    for (const accessTemplates of [[], ['github-read', 'node-packages'], ['github-write', 'python-packages'], ['python-packages', 'node-packages']]) {
      const plan = await planSandbox({ template: 'locked-down', accessTemplates, agentRules })
      const expected = templateToPolicy({ ...BUILTIN_TEMPLATES[0], rules: agentRules }).networkPolicies
      assert.deepEqual(plan.policy.networkPolicies[`agent-${agent.id}`], expected[`agent-${agent.id}`])
      assert.equal(plan.policy.filesystem.includeWorkdir, true)
      for (const id of accessTemplates) {
        const addition = BUILTIN_TEMPLATES.find(t => t.id === id)
        for (const rule of addition.rules) assert(plan.policy.networkPolicies[rule.name])
      }
    }
  }
})

test('GitHub write replaces read without retaining its push denial; package rules remain read-only', async () => {
  const read = await planSandbox({ accessTemplates: ['github-read'] })
  const github = read.policy.networkPolicies['github-access']
  assert(github.endpoints.find(e => e.host === 'github.com').rules.some(r => r.allow.method === 'POST' && r.allow.path.endsWith('/git-upload-pack')))
  assert(github.endpoints.find(e => e.host === 'github.com').denyRules.some(r => r.path.endsWith('/git-receive-pack')))
  const write = await planSandbox({ accessTemplates: ['github-read', 'github-write', 'python-packages', 'node-packages'] })
  assert(write.policy.networkPolicies['github-access'].endpoints.every(e => e.denyRules.length === 0))
  assert.equal(write.policy.networkPolicies['github-access'].endpoints.find(e => e.host === 'api.github.com').access, 2)
  for (const key of ['pypi', 'npm']) assert(write.policy.networkPolicies[key].endpoints.every(e => e.access === 1))
  assert.deepEqual(toggleAccessTemplate(['github-write', 'node-packages'], 'github-read'), ['node-packages', 'github-read'])
})

test('invalid additions and colliding rules fail before launch, and organization blocks still apply', async () => {
  for (const ids of [null, 'github-write', ['unknown'], [{ host: '*' }]]) {
    assert.throws(() => normalizeAccessTemplates(ids), /valid additional access/)
    await assert.rejects(planSandbox({ accessTemplates: ids }), /valid additional access/)
  }
  assert.throws(() => composeTemplate({ rules: [{ name: 'npm' }] }, ['node-packages']), /conflicts/)
  const base = templateToPolicy(BUILTIN_TEMPLATES[0])
  const addition = BUILTIN_TEMPLATES.find(t => t.id === 'node-packages')
  assert.throws(() => addAgentAccess(base, addition.rules, { blocked: ['registry.npmjs.org'] }), /organization blocks/)
  assert.deepEqual(base.networkPolicies, {})
})

test('custom policies persist reusable combinations and compose with launch additions', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'policy-composition-'))
  const store = createTemplateStore({ directory, builtins: BUILTIN_TEMPLATES, validate: validateTemplate })
  const id = 'test-combination'
  try {
    const saved = await store.save({
      ...BUILTIN_TEMPLATES[0], id, name: 'Test combination',
      accessTemplates: ['github-read', 'python-packages'],
    })
    assert.deepEqual(saved.accessTemplates, ['github-read', 'python-packages'])
    const plan = { policy: templateToPolicy(composeTemplate(await store.find(id), ['github-write', 'node-packages'], await store.list())) }
    assert.deepEqual(Object.keys(plan.policy.networkPolicies).filter(k => !k.startsWith('egress_')).sort(), ['github-access', 'npm', 'pypi'])
    assert(plan.policy.networkPolicies['github-access'].endpoints.every(e => !e.denyRules.length))
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})
