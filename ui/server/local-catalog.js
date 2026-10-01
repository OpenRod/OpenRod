import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { contextKey, contextSelection, runWithContext, resolveGateway } from './gateway.js'
import { policyDirectory, scopedStateDirectory } from './paths.js'
import { listGroups, readOrg, serializeOrgWrite } from './org.js'
import { listPolicies, validatePolicy } from './egress.js'
import { listTemplates, validateTemplate } from './policy.js'
import { getSetupStore } from './setups.js'
import { artifactFile } from './setup-packages.js'
import { hash } from './setup-discovery.js'
import { PACKAGE_PENDING } from '../shared/setup-launch.js'
import { composeTemplate } from '../shared/policy-templates.js'

const fail = message => Object.assign(new Error(message), { status: 409 })
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')

// A catalog is a versioned snapshot, not a live grant. Changed local definitions
// get new remote identities: neither existing remote rules nor memberships are
// overwritten. Sandbox-specific grants and memberships never cross gateways.
export function planLocalCatalog(snapshot, source, architecture) {
  const generation = digest([contextKey(source), snapshot])
  const id = (kind, original) => 'local-' + digest([generation, kind, original]).slice(0, 32)
  const setupId = original => digest([generation, 'setup', original]).slice(0, 24)
  const groups = new Map(snapshot.groups.map(g => [g.id, id('group', g.id)]))
  const templates = new Map(snapshot.templates.map(t => [t.id, id('template', t.id)]))
  const setups = new Map(snapshot.setups.map(s => [s.id, setupId(s.id)]))
  const localSource = { context: contextKey(source), generation }
  const copiedSetups = snapshot.setups.map(original => {
    const items = original.items.map(originalItem => {
      const item = structuredClone(originalItem)
      if (item.credentialRef) {
        // GetProvider deliberately redacts secrets. Copying its output would
        // silently replace credentials with REDACTED. Require destination login.
        item.credentialFields = Object.keys(item.credentialRef.aliases ?? {})
        delete item.credentialRef
        item.issues = [...new Set([...item.issues, `Connect credentials (${item.credentialFields.join(', ')}) on this remote gateway to use this MCP.`])]
        item.state = 'needs-attention'
      }
      if (item.artifact && item.artifact.arch !== architecture && item.package) {
        delete item.artifact
        item.config = null
        item.issues = [...new Set([...item.issues, PACKAGE_PENDING])]
        item.state = 'needs-attention'
      }
      return item
    })
    return { ...original, id: setups.get(original.id), items, revision: hash(JSON.stringify(items)), localSource,
      ...(original.preparedFrom ? { preparedFrom: { ...original.preparedFrom, id: setups.get(original.preparedFrom.id) ?? original.preparedFrom.id } } : {}) }
  })
  // Materialize composed access rules, including local edits to built-ins,
  // rather than resolving those ids against the destination's built-ins.
  const copiedTemplates = snapshot.templates.map(t => validateTemplate({ ...composeTemplate(t, [], snapshot.templates), id: templates.get(t.id), accessTemplates: [] }))
  const copiedGroups = snapshot.groups.map(g => ({ ...g, id: groups.get(g.id), template: g.template ? templates.get(g.template) : null, localSource }))
  const copiedPolicies = snapshot.policies.map(p => {
    const appliesTo = { everyone: false, sandboxes: [], groups: p.appliesTo.everyone ? [...groups.values()] : p.appliesTo.groups.map(v => groups.get(v)).filter(Boolean), setups: p.appliesTo.setups.map(v => setups.get(v)).filter(Boolean) }
    if (!appliesTo.groups.length && !appliesTo.setups.length) return null
    const setup = p.setup && setups.has(p.setup.id) ? { ...p.setup, id: setups.get(p.setup.id) } : null
    return validatePolicy({ ...p, id: setup ? `setup-${setup.id}` : id('policy', p.id), appliesTo, setup })
  }).filter(Boolean)
  for (let offset = 0; offset < snapshot.organization.blocked.length && copiedGroups.length; offset += 200) copiedPolicies.push(validatePolicy({
    id: id('policy', 'organization-blocked-' + offset), name: 'Local organization restrictions', action: 'block',
    destinations: snapshot.organization.blocked.slice(offset, offset + 200),
    appliesTo: { everyone: false, groups: [...groups.values()], sandboxes: [], setups: [] },
  }))
  return { generation, groups: copiedGroups, templates: copiedTemplates, policies: copiedPolicies, setups: copiedSetups }
}

async function writeExclusive(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  try { await fs.writeFile(file, JSON.stringify(value), { mode: 0o600, flag: 'wx' }) }
  catch (error) { if (error.code !== 'EEXIST') throw error }
}

export async function syncLocalCatalog(source, { architecture, target = contextSelection() } = {}) {
  if (!source) return { groups: [], setups: [], templates: [], available: false }
  if (contextKey(source) === contextKey(target) || resolveGateway(source.gateway).remote || !resolveGateway(target.gateway).remote) throw fail('Choose a local source and a remote destination.')
  const snapshot = await runWithContext(source, async () => {
    const store = getSetupStore()
    const [groups, templates, policies, organization, setupViews] = await Promise.all([listGroups(), listTemplates(), listPolicies(), readOrg(), store.list()])
    const setups = await Promise.all(setupViews.filter(s => !s.localSource).map(s => store.get(s.id)))
    return { groups, templates, policies, organization, setups }
  })
  const plan = planLocalCatalog(snapshot, source, architecture)
  // Verify all package archives before publishing any selectable Setup.
  const artifacts = await runWithContext(source, async () => Promise.all(
    [...new Map(plan.setups.flatMap(s => s.items.filter(i => i.artifact).map(i => [i.artifact.digest, i.artifact]))).values()]
      .map(async artifact => ({ artifact, data: (await artifactFile(artifact)).data })),
  ))
  const importedGroups = await runWithContext(target, () => serializeOrgWrite(async () => {
    const policies = await policyDirectory(), state = scopedStateDirectory()
    for (const { artifact, data } of artifacts) {
      const file = path.join(state, 'setup-artifacts', artifact.digest + '.tar.gz')
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
      try { await fs.writeFile(file, data, { mode: 0o600, flag: 'wx' }) } catch (error) { if (error.code !== 'EEXIST') throw error }
    }
    for (const template of plan.templates) await writeExclusive(path.join(policies, template.id + '.json'), template)
    for (const group of plan.groups) await writeExclusive(path.join(policies, 'org/groups', group.id + '.json'), group)
    for (const policy of plan.policies) await writeExclusive(path.join(policies, 'egress', policy.id + '.json'), policy)
    for (const setup of plan.setups) await writeExclusive(path.join(state, 'setups', setup.id + '.json'), setup)
    const groupFiles = await fs.readdir(path.join(policies, 'org/groups')).catch(error => { if (error.code === 'ENOENT') return []; throw error })
    const imported = await Promise.all(groupFiles.filter(file => file.endsWith('.json')).map(async file => {
      const group = JSON.parse(await fs.readFile(path.join(policies, 'org/groups', file), 'utf8'))
      return group.localSource ? group.id : null
    }))
    return imported.filter(Boolean)
  }))
  return { available: true, generation: plan.generation, groups: plan.groups.map(g => g.id), importedGroups, setups: plan.setups.map(s => s.id), templates: plan.templates.map(t => t.id) }
}
