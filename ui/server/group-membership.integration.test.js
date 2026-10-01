import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'

// Exercise the actual storage, routes, compiler and sync path in a disposable
// console copy. Only the gateway transport is mocked; no live policies change.
test('multi-group memberships persist, compose and synchronize without losing other groups', async () => {
  const source = path.resolve(import.meta.dirname, '..')
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'openshell-memberships-'))
  try {
    for (const dir of ['server', 'shared', 'src']) await fs.cp(path.join(source, dir), path.join(root, dir), { recursive: true })
    await fs.copyFile(path.join(source, 'package.json'), path.join(root, 'package.json'))
    await fs.symlink(path.join(source, 'node_modules'), path.join(root, 'node_modules'), 'dir')
    const write = async (file, value) => {
      const target = path.join(root, file)
      await fs.mkdir(path.dirname(target), { recursive: true })
      await fs.writeFile(target, JSON.stringify(value))
    }
    for (const id of ['frontend', 'data', 'extra']) await write(`policies/org/groups/${id}.json`, { id, name: id })
    const rule = (id, action = 'allow') => ({ id, name: id, action, destinations: ['example.com'], appliesTo: { groups: [id] } })
    await write('policies/egress/frontend.json', rule('frontend'))
    await write('policies/egress/data.json', rule('data', 'block'))
    await write('policies/org/members.json', { web: 'frontend' })
    const gatewayPath = path.join(root, 'server/gateway.js')
    const gatewaySource = await fs.readFile(gatewayPath, 'utf8')
    await fs.writeFile(gatewayPath, gatewaySource.replace('export async function gateway()', 'async function unusedLiveGateway()') + `
export const membershipTestState = { updates: [], rules: {} }
export async function gateway() {
  return { client: { raw: {
    async listSandboxes() { return { sandboxes: [
      { metadata: { name: 'web', labels: { 'openshell.console/group': 'frontend' } }, status: { phase: 2 } },
      { metadata: { name: 'etl', labels: { 'openshell.console/group': 'data' } }, status: { phase: 2 } },
    ] } },
    async getSandboxPolicyStatus({ sandbox }) { return { revision: { policy: { networkPolicies: membershipTestState.rules[sandbox] || {} } } } },
    async updateConfig(input) {
      membershipTestState.updates.push(input)
      const rules = { ...(membershipTestState.rules[input.sandbox] || {}) }
      for (const { operation } of input.mergeOperations) {
        if (operation.case === 'removeRule') delete rules[operation.value.ruleName]
        else rules[operation.value.ruleName] = operation.value.rule
      }
      membershipTestState.rules[input.sandbox] = rules
      return { version: 1 }
    }
  } } }
}
`)
    const { orgRoute, planSandbox, readMembers } = await import(pathToFileURL(path.join(root, 'server/org.js')))
    const { membershipTestState: state } = await import(pathToFileURL(gatewayPath))
    const { groupsFromLabels } = await import(pathToFileURL(path.join(root, 'shared/group-membership.js')))
    const route = (names, groups, mode) => orgRoute('POST', ['org', 'members'], { sandboxes: names, groups, mode })
    const launch = await planSandbox({ name: 'new', groups: ['frontend', 'data'], requireGroup: true })
    assert.deepEqual(groupsFromLabels(launch.labels), ['frontend', 'data'])
    assert.deepEqual(Object.keys(launch.policy.networkPolicies).sort(), ['egress_data', 'egress_frontend'])
    await route(['web'], ['data'], 'add')
    assert.deepEqual((await readMembers()).web, ['frontend', 'data'])
    assert.deepEqual(Object.keys(state.rules.web).sort(), ['egress_data', 'egress_frontend'])
    let overview = await orgRoute('GET', ['org'])
    assert.deepEqual(overview.members.frontend, ['web'])
    assert.deepEqual(overview.members.data, ['web', 'etl'])
    await route(['web'], ['frontend'], 'remove')
    assert.deepEqual((await readMembers()).web, ['data'])
    assert.deepEqual(Object.keys(state.rules.web), ['egress_data'])
    await assert.rejects(route(['web'], ['data'], 'remove'), /at least one group/)
    await Promise.all([route(['web'], ['frontend'], 'add'), route(['web'], ['extra'], 'add')])
    assert.deepEqual((await readMembers()).web, ['data', 'frontend', 'extra'])
    const before = await readMembers()
    await assert.rejects(route(['web', 'etl'], ['data'], 'remove'), /at least one group/)
    assert.deepEqual(await readMembers(), before, 'failed bulk operation must not partially persist')
    await orgRoute('POST', ['egress', 'policies', 'frontend', 'delete'], {})
    assert.deepEqual(Object.keys(state.rules.web), ['egress_data'])
    await assert.rejects(orgRoute('POST', ['egress', 'policies', 'data', 'delete'], {}), /last network rule/)
    await assert.rejects(orgRoute('POST', ['org', 'groups', 'data', 'delete'], {}), /sandboxes/)
    await orgRoute('POST', ['egress', 'policies'], { ...rule('shared'), appliesTo: { groups: ['frontend', 'data'] } })
    assert.ok(state.rules.web.egress_shared)
    assert.ok(state.rules.etl.egress_shared)
    overview = await orgRoute('GET', ['org'])
    assert.deepEqual(overview.assignments.web, ['data', 'frontend', 'extra'])
    // web and etl inherit only "data" and "shared". Deleting both at once must
    // leave one: the second request has to see the first one's deletion.
    const deletions = await Promise.allSettled(['data', 'shared'].map((id) => orgRoute('POST', ['egress', 'policies', id, 'delete'], {})))
    assert.equal(deletions.filter((d) => d.status === 'fulfilled').length, 1)
    assert.match(deletions.find((d) => d.status === 'rejected').reason.message, /last network rule/)
    const kept = ['data', 'shared'][deletions.findIndex((d) => d.status === 'rejected')]
    const { listPolicies } = await import(pathToFileURL(path.join(root, 'server/egress.js')))
    assert.deepEqual((await listPolicies()).map((p) => p.id), [kept])
    assert.deepEqual(Object.keys(state.rules.web), [`egress_${kept}`])
    assert.deepEqual(Object.keys(state.rules.etl), [`egress_${kept}`])
    await write('policies/org/groups/frontend.json', { id: 'frontend', template: 'locked-down' })
    await write('policies/org/groups/data.json', { id: 'data', template: 'claude' })
    await assert.rejects(planSandbox({ groups: ['frontend', 'data'], requireGroup: true }), /different base policies/)
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})
