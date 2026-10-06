import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'

// Real storage, route validators, revisions and policy synchronization; only the
// gateway transport is replaced. This never modifies the operator's resources.
test('configuration export/import persists groups, network and usable setup files in an isolated destination', async () => {
  const source = path.resolve(import.meta.dirname, '..')
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'openrod-import-integration-'))
  const previous = process.env.OPENSHELL_CONSOLE_DATA_DIR
  process.env.OPENSHELL_CONSOLE_DATA_DIR = path.join(root, 'state')
  try {
    for (const directory of ['server', 'shared', 'src']) await fs.cp(path.join(source, directory), path.join(root, directory), { recursive: true })
    await fs.copyFile(path.join(source, 'package.json'), path.join(root, 'package.json'))
    await fs.symlink(path.join(source, 'node_modules'), path.join(root, 'node_modules'), 'dir')
    const gatewayPath = path.join(root, 'server/gateway.js')
    const gatewaySource = await fs.readFile(gatewayPath, 'utf8')
    await fs.writeFile(gatewayPath, gatewaySource.replace('export async function gateway(', 'async function unusedLiveGateway(') + `
export async function gateway() {
  return { workspace: contextSelection().workspace, workspaceScope: workspaceScope(), target: { endpoint: 'http://fixture' }, client: { raw: {
    async listSandboxes() { return { sandboxes: [] } },
  }, sandboxTemplates: { async listAll() { return [] } } } }
}
`)
    const mod = name => import(pathToFileURL(path.join(root, 'server', name + '.js')))
    const { runWithContext } = await mod('gateway')
    const { createResourceImports } = await mod('resource-imports')
    const { orgRoute, listGroups } = await mod('org')
    const { listPolicies } = await mod('egress')
    const { policyRoute, findTemplate } = await mod('policy')
    const { getSetupStore } = await mod('setups')
    const local = { gateway: 'local-fixture', workspace: 'personal' }
    const cloud = { gateway: 'cloud-fixture', workspace: 'personal' }
    const sourceBundle = await runWithContext(local, async () => {
      const npm = await findTemplate('node-packages')
      await policyRoute('POST', ['templates'], { ...npm, rules: [{ ...npm.rules[0], endpoints: [{ ...npm.rules[0].endpoints[0], host: 'registry.internal.example' }] }] })
      const base = await findTemplate('locked-down')
      await policyRoute('POST', ['templates'], { ...base, filesystem: { ...base.filesystem, readWrite: [...base.filesystem.readWrite, '/workspace-cache'] }, accessTemplates: ['node-packages'] })
      await orgRoute('POST', ['org'], { blocked: ['blocked.example.com'] })
      await orgRoute('POST', ['org', 'groups'], { id: 'work', name: 'Work', template: 'locked-down', isNew: true })
      const store = getSetupStore()
      const review = store.stage([{ id: 'skill-1', kind: 'skill', name: 'Review', files: [{ path: 'SKILL.md', content: '# Review\nReview the changes.', executable: false }], issues: [], credentialFields: [], requirements: [] }])
      const saved = await store.save(review.token, 'Review setup', true)
      await orgRoute('POST', ['egress', 'policies'], { id: 'docs', name: 'Docs', action: 'allow', destinations: ['docs.example.com'], appliesTo: { groups: ['work'], setups: [saved.id] }, isNew: true })
      return createResourceImports().export({ types: ['groups', 'network', 'setups'] })
    })
    assert.equal(sourceBundle.resources.length, 5)
    const exportedBase = sourceBundle.resources.find(resource => resource.type === 'policyTemplates')
    assert.equal(exportedBase.id, 'locked-down')
    assert.deepEqual(exportedBase.data.accessTemplates, [])
    assert.equal(exportedBase.data.rules[0].endpoints[0].host, 'registry.internal.example')
    assert.equal(sourceBundle.resources.filter(resource => resource.requiredForGroups?.includes('work')).length, 1)
    const result = await runWithContext(cloud, async () => {
      const service = createResourceImports()
      const plan = await service.plan({ bundle: sourceBundle })
      assert.equal((await listGroups()).length, 0)
      await service.execute(plan.id, { acknowledged: true })
      let job
      for (let attempt = 0; attempt < 200; attempt++) {
        job = await service.get(plan.id)
        if (job.status !== 'running') break
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      assert.equal(job.status, 'completed', JSON.stringify(job))
      const imported = await getSetupStore().get(job.items.find(item => item.type === 'setups').targetId)
      assert.equal(imported.items[0].files[0].content, '# Review\nReview the changes.')
      assert.equal(imported.owner, 'local operator')
      const groups = await listGroups(), rules = await listPolicies()
      assert.equal(groups.length, 1)
      assert.notEqual(groups[0].template, 'locked-down')
      const importedPolicy = await findTemplate(groups[0].template)
      assert.equal(importedPolicy.builtin, false)
      assert.equal(importedPolicy.rules[0].endpoints[0].host, 'registry.internal.example')
      assert.ok(importedPolicy.filesystem.readWrite.includes('/workspace-cache'))
      assert.deepEqual(importedPolicy.accessTemplates, [])
      assert.deepEqual((await findTemplate('locked-down')).rules, [])
      assert.equal((await findTemplate('node-packages')).rules[0].endpoints[0].host, 'registry.npmjs.org')
      assert.deepEqual(rules[0].appliesTo.groups, [groups[0].id])
      assert.deepEqual(rules[0].appliesTo.setups, [imported.id])
      assert.equal(rules.length, 2)
      assert.equal(rules[1].action, 'block')
      assert.deepEqual(rules[1].destinations, ['blocked.example.com'])
      assert.deepEqual(rules[1].appliesTo.groups, [groups[0].id])
      assert.equal((await createResourceImports().list()).jobs[0].status, 'completed')
      return imported.id
    })
    await runWithContext(local, async () => {
      const original = await getSetupStore().list()
      assert.equal(original.length, 1)
      assert.notEqual(original[0].id, result)
      assert.equal((await listGroups())[0].id, 'work')
      assert.equal((await listPolicies())[0].id, 'docs')
    })
  } finally {
    if (previous === undefined) delete process.env.OPENSHELL_CONSOLE_DATA_DIR
    else process.env.OPENSHELL_CONSOLE_DATA_DIR = previous
    await fs.rm(root, { recursive: true, force: true })
  }
})
