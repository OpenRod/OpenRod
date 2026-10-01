import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { planLocalCatalog } from './local-catalog.js'
import { BUILTIN_TEMPLATES, composeTemplate, toggleAccessTemplate } from '../shared/policy-templates.js'
import { createTemplateStore } from './policy-template-store.js'
import { validateTemplate, templateToPolicy } from './policy.js'
import { DEFAULT_ADVANCED } from './egress.js'

const source = { gateway: 'local', workspace: 'default' }
const snapshot = () => ({
  groups: [{ id: 'dev', name: 'Developers', template: 'locked-down', outside: 'block' }],
  templates: BUILTIN_TEMPLATES,
  organization: { blocked: ['blocked.example.com'], outside: 'block' },
  policies: [{ id: 'git', name: 'Git', action: 'allow', destinations: ['github.com'], advanced: DEFAULT_ADVANCED,
    appliesTo: { everyone: true, groups: [], sandboxes: ['same-name'], setups: ['a'.repeat(24)] } },
    { id: 'private', name: 'Sandbox only', action: 'allow', destinations: ['private.example.com'], advanced: DEFAULT_ADVANCED,
      appliesTo: { everyone: false, groups: [], sandboxes: ['same-name'], setups: [] } }],
  setups: [{ id: 'a'.repeat(24), name: 'Tools', items: [{ id: 'skill', kind: 'skill', name: 'Review', issues: [], files: [{ path: 'SKILL.md', content: 'Review changes' }] }] }],
})

test('local catalog remaps dependencies and scopes everyone rules without copying sandbox grants', () => {
  const plan = planLocalCatalog(snapshot(), source, 'x64')
  assert.notEqual(plan.groups[0].id, 'dev')
  assert.equal(plan.groups[0].template, plan.templates[0].id)
  assert.deepEqual(plan.policies[0].appliesTo, { everyone: false, groups: [plan.groups[0].id], sandboxes: [], setups: [plan.setups[0].id] })
  assert.equal(plan.policies.length, 2, 'sandbox-only rule is excluded; organization restrictions included')
  assert.equal(plan.policies[1].action, 'block')
  assert.deepEqual(plan.policies[1].appliesTo.groups, [plan.groups[0].id])
  assert.equal(plan.setups[0].items[0].files[0].content, 'Review changes')
})

test('repeated imports reuse identities while local edits and other workspaces get separate snapshots', () => {
  const original = snapshot(), first = planLocalCatalog(original, source, 'x64')
  assert.deepEqual(planLocalCatalog(original, source, 'x64'), first)
  original.policies[0].destinations.push('new.example.com')
  const updated = planLocalCatalog(original, source, 'x64')
  assert.notEqual(updated.groups[0].id, first.groups[0].id)
  assert.notEqual(planLocalCatalog(snapshot(), { ...source, workspace: 'other' }, 'x64').setups[0].id, first.setups[0].id)
})

test('MCP credentials require destination setup and incompatible bundles are prepared on the remote architecture', () => {
  const original = snapshot()
  original.setups[0].items.push({ id: 'mcp', kind: 'mcp', name: 'Service', issues: [], config: { url: 'https://example.com/mcp' }, credentialRef: { provider: 'secret', aliases: { TOKEN: 'OS_TOKEN' } } },
    { id: 'npm', kind: 'mcp', name: 'Package', issues: [], config: { command: 'node' }, package: { name: 'test' }, artifact: { arch: 'arm64', digest: 'b'.repeat(64) } })
  const plan = planLocalCatalog(original, source, 'x64'), items = plan.setups[0].items
  assert.equal(items[1].credentialRef, undefined)
  assert.deepEqual(items[1].credentialFields, ['TOKEN'])
  assert.match(items[1].issues[0], /remote gateway/)
  assert.equal(items[2].artifact, undefined)
  assert.equal(items[2].config, null)
  assert.match(items[2].issues[0], /Not downloaded/)
  assert.deepEqual(original.setups[0].items[1].credentialRef, { provider: 'secret', aliases: { TOKEN: 'OS_TOKEN' } })
})

test('local access-template edits are materialized instead of resolving against remote presets', () => {
  const original = structuredClone(snapshot())
  original.templates[1].rules[0].endpoints[0].host = 'git.example.com'
  const copied = planLocalCatalog(original, source, 'x64').templates[1]
  assert.equal(copied.rules[0].endpoints[0].host, 'git.example.com')
  assert.deepEqual(copied.accessTemplates, [])
})

test('imported access presets remain selectable and saved combinations survive a store restart', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'imported-access-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const original = structuredClone(snapshot())
  original.templates.find(template => template.id === 'github-read').rules[0].endpoints[0].host = 'git.example.com'
  const plan = planLocalCatalog(original, source, 'x64')
  // Exercise the same legacy-file storage path used by syncLocalCatalog.
  for (const template of plan.templates) await fs.writeFile(path.join(directory, template.id + '.json'), JSON.stringify(template))
  const reopen = () => createTemplateStore({ directory, builtins: BUILTIN_TEMPLATES, validate: validateTemplate })
  const store = reopen(), catalog = await store.list()
  const github = catalog.find(template => template.name === 'GitHub - Read' && template.id.startsWith('local-'))
  const npm = catalog.find(template => template.name === 'Node.js - Packages' && template.id.startsWith('local-'))
  assert.equal(github.kind, 'access')
  assert.equal(npm.kind, 'access')
  const selected = toggleAccessTemplate(toggleAccessTemplate([], github.id, catalog), npm.id, catalog)
  await store.save({ ...BUILTIN_TEMPLATES[0], id: 'remote-project', accessTemplates: selected })
  const restarted = reopen()
  const saved = await restarted.find('remote-project')
  assert.deepEqual(saved.accessTemplates, selected)
  const policy = templateToPolicy(composeTemplate(saved, [], await restarted.list()))
  assert.equal(policy.networkPolicies['github-access'].endpoints[0].host, 'git.example.com')
  assert.equal(policy.networkPolicies.npm.endpoints[0].host, 'registry.npmjs.org')
  await assert.rejects(store.save({ ...saved, accessTemplates: ['missing-access'] }), /valid additional access/)
  await assert.rejects(store.save({ ...saved, accessTemplates: [plan.templates[0].id] }), /valid additional access/)
  await assert.rejects(store.save({ ...github, accessTemplates: [npm.id] }), /cannot include other access policies/)
})
