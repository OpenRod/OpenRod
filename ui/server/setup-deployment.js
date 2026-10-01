import { SETUP_TARGETS, validateSetupTargets } from '../shared/setup-targets.js'
import { setupPython } from './setup-python.js'
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { gateway, sandboxView, contextKey, contextSelection, runWithContext, workspaceName } from './gateway.js'
import { setupStore, resolveSetups, usableSetup, SETUP_ID } from './setups.js'
import { fail, hash } from './setup-discovery.js'
import { hostMatches } from '../src/lib/egress.js'
import { readOrg, blockedBy, orgRoute, managedOpsFor, serializeOrgWrite, syncAll } from './org.js'
import { listPolicies, blockedByPolicy, compileFor } from './egress.js'
import { readSetupMembers, sandboxSetups, addSandboxSetups, removeSandboxSetups } from './setup-members.js'
import { setupPolicyFor } from './setup-egress.js'

import { withSandboxInput } from './setup-transfer.js'
import { installArtifacts } from './setup-artifacts.js'
const verifier = await fs.readFile(path.join(import.meta.dirname, 'setup-verifier.cjs'), 'utf8')
const installer = setupPython('./setup-installer.py')
const COMMAND = Object.fromEntries(SETUP_TARGETS.map(agent => [agent.id, agent.command]))
const stateKey = Symbol.for('openshell.console.setup-deployments.v2')
const contexts = globalThis[stateKey] ??= new Map()
function deploymentState() {
  const key = contextKey()
  if (!contexts.has(key)) contexts.set(key, { previews: new Map(), jobs: new Map(), locks: new Set() })
  return contexts.get(key)
}
const keyFor = (sandbox, id) => `${sandbox.name}:${id}`
export const setupJobsForSandbox = (name, createdAt) => [...deploymentState().jobs.values()].filter(job => job.sandbox === name && (!createdAt || job.at >= createdAt))
// Protobuf maps have no ordering guarantee. Preserve array order and every
// value, but never treat a different object-key order as a permission change.
export function setupAccessIdentity(value) {
  const canonical = value => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value
  return hash(JSON.stringify(canonical(value)))
}
export function launchSetupAccess(setups, recipe, review, includeTemplateAccess = false) {
  const approved = {}
  for (const setup of setups) {
    const inherited = recipe?.setups?.includes(setup.id)
    const pinned = inherited && recipe.setupRevisions?.[setup.id]
    if (inherited && pinned !== setup.revision) throw fail('A Setup baked into this template changed. Rebuild the image template before launching its new revision.')
    if (review && review[setup.id] !== setup.revision) throw fail('A selected Setup changed. Review its runtime access again.')
    // Choosing a template includes its pinned tools and their scoped runtime
    // requirements. Additional tools still require their own reviewed revision.
    if ((inherited && includeTemplateAccess) || review?.[setup.id] === setup.revision) approved[setup.id] = setup.revision
  }
  return approved
}
const narrow = (endpoint) => endpoint.tls === 1 || endpoint.allowedIps?.length || endpoint.denyRules?.length || endpoint.rules?.length || (endpoint.path && endpoint.path !== '/' && endpoint.path !== '/**')

// This is deliberately a conservative policy preflight, not a reachability or
// MCP tool test. A hostname match on its own must never mean "Ready".
export function assessNetwork(requirement, policy, binaries, restrictions = []) {
  if (!binaries.length) return { status: 'missing', reason: 'Target agent executable is missing.' }
  if (restrictions.some((host) => hostMatches(host, requirement.host))) return { status: 'blocked', reason: 'Blocked by organization or scoped Egress policy.' }
  const matches = Object.values(policy?.networkPolicies ?? {}).flatMap((rule) => (rule.endpoints ?? []).filter((e) => hostMatches(e.host, requirement.host) && (e.ports?.length ? e.ports : [e.port]).includes(requirement.port)).map((endpoint) => ({ endpoint, binaries: (rule.binaries ?? []).map((b) => b.path) })))
  if (matches.some(({ endpoint }) => endpoint.denyRules?.length)) return { status: 'review', reason: 'A matching deny rule needs review in Egress.' }
  const permitted = matches.find(({ endpoint: e, binaries: programs }) => binaries.every((binary) => programs.includes('/**') || programs.includes(binary)) && !narrow(e) && (!e.protocol || e.protocol === 'tcp' || (e.protocol === 'rest' && e.enforcement === 1 && [2, 3].includes(e.access))))
  if (permitted) return { status: 'allowed', reason: 'Existing connection access matches. MCP tool access and sign-in are not verified.' }
  if (matches.length) return { status: 'review', reason: 'Matching access is restricted by program, path, IP or protocol. Review the effective policy.' }
  return { status: 'missing', reason: 'No matching runtime access. Add an approved, scoped rule in Egress, then check again.' }
}

// A Setup's egress policy also covers Quick-setup snapshots prepared from it.
const memberIds = (setup) => [setup.id, setup.preparedFrom?.id].filter(Boolean)
// The Setup's egress policy, when it will let these callers reach the
// requirement once the sandbox joins it, on top of the sandbox's current rules.
export function setupPolicyCoverage(requirement, setup, policies, callers = ['/**'], current = null) {
  const policy = setupPolicyFor(policies, setup, requirement)
  return policy && assessNetwork(requirement, { networkPolicies: { ...current?.networkPolicies, ...compileFor({ name: '', groups: [], setups: memberIds(setup) }, [policy]) } }, callers).status === 'allowed' ? policy : null
}

export async function executeInstaller(client, sandbox, setup, targets, operation) {
  sandbox = { ...sandbox, workspace: sandbox.workspace || workspaceName() }
  // A probe reads only names and launchers, so skill files (up to 64 MB) stay behind.
  const data = Buffer.from(JSON.stringify({ setup: operation === 'probe' ? { ...setup, items: setup.items.map(({ files, ...item }) => item) } : setup, targets, operation }))
  const result = await withSandboxInput(client, sandbox, data, file => client.sandbox.exec(sandbox.name, ['python3', '-c', `import sys;sys.stdin=open(sys.argv[1], 'r');\n${installer}`, file], { workspace: sandbox.workspace, noLoginShell: true, timeoutSecs: 60, signal: AbortSignal.timeout(65_000) }))
  let output
  try { output = JSON.parse(result.stdout.toString()) } catch { throw fail('The sandbox needs Python 3.11 or later and writable agent configuration folders.', 409) }
  if (result.exitCode !== 0 || output.error) throw fail(output.error || 'Setup operation failed.', 409)
  return output
}
function validateTargets(targets) { try { validateSetupTargets(targets) } catch (error) { throw fail(error.message) } }
export function accessPolicyIdentity(policy) {
  // Attaching an endpointless credential profile adds an inert provider rule.
  // Ignore only those empty rules; every actual permission stays in the hash.
  return { ...policy, networkPolicies: Object.fromEntries(Object.entries(policy?.networkPolicies || {}).filter(([name, rule]) => !(name.startsWith('_provider_') && !rule.endpoints?.length && !rule.binaries?.length))) }
}
function assertSandboxIdentity(sandbox, endpoint, expected) {
  if (expected && (sandbox.id !== expected.id || endpoint !== expected.gateway)) throw fail('Sandbox was replaced or its gateway changed. Review the Setup for the new sandbox.', 409)
}
async function assertCurrentSandbox(plan) {
  const expected = { id: plan.sandbox.id, gateway: plan.gateway }
  const { target } = await gateway()
  assertSandboxIdentity(plan.sandbox, target.endpoint, expected)
  const current = sandboxView((await plan.client.raw.getSandbox({ name: plan.sandbox.name, workspaceScope: plan.workspaceScope })).sandbox)
  assertSandboxIdentity(current, target.endpoint, expected)
}
async function inspectTarget(name, id, targets, expected) {
  validateTargets(targets)
  const snapshot = await setupStore.get(id)
  const setup = usableSetup(snapshot)
  const inactive = snapshot.items.filter(i => !setup.items.some(a => a.id === i.id)).map(i => ({ name: i.name, issues: i.issues }))
  const { client, target, workspace, workspaceScope } = await gateway()
  const sandbox = { ...sandboxView((await client.raw.getSandbox({ name, workspaceScope })).sandbox), workspace }
  assertSandboxIdentity(sandbox, target.endpoint, expected)
  if (sandbox.phase !== 'ready') throw fail('Start the sandbox before enabling or removing a Setup.', 409)
  const [config, org, scoped, fleet, status] = await Promise.all([client.raw.getSandboxConfig({ name, workspaceScope }), readOrg(), listPolicies(), orgRoute('GET', ['org']), client.raw.getSandboxPolicyStatus({ sandbox: name, workspaceScope })])
  const problems = setup.items.length ? [] : ['This Setup has no prepared items. Open Prepare setup to resolve requirements.']
  if (config.configurationAdmitted === false || (!status.revision || status.revision.status !== 2 || status.activeVersion !== status.revision.version)) problems.push('The effective sandbox policy has not loaded successfully. Resolve it before enabling a Setup.')
  let probe = null
  try { probe = await executeInstaller(client, sandbox, setup, targets, 'probe') } catch (e) { problems.push(e.message) }
  if (probe?.installed && JSON.stringify([...probe.targets].sort()) !== JSON.stringify([...targets].sort())) problems.push(`This Setup is assigned to ${probe.targets.join(', ')}. Select those agents to reapply or remove it.`)
  const binaries = targets.map((t) => probe?.networkExecutables?.[COMMAND[t]] || 'unverified-script-caller')
  if (probe) for (const [command, found] of Object.entries(probe.executables)) if (!found) problems.push(`${command} is missing. Rebuild the image with this executable installed.`)
  if (setup.items.some(i => i.config?.url) && binaries.includes('unverified-script-caller')) problems.push('A selected harness has an unrecognized network launcher. Use a supported native or Node.js harness image.')
  const member = { name, groups: fleet.assignments?.[name] ?? [], setups: [...(fleet.setupMembers?.[name] ?? []), ...memberIds(setup)] }
  const grants = []
  const network = setup.items.flatMap((item) => item.requirements.filter((r) => ['runtime', 'auth'].includes(r.phase)).map((requirement, index) => {
    const callers = requirement.phase === 'auth' ? [...new Set(binaries.filter(b => b !== 'unverified-script-caller'))] : item.config?.command ? [probe?.networkExecutables?.[item.config.command]].filter(Boolean) : [...new Set([...binaries.filter(b => b !== 'unverified-script-caller'), probe?.networkExecutables?.node].filter(Boolean))]
    const blocked = blockedBy(org, [requirement.host]) || blockedByPolicy(scoped, member, [requirement.host], hostMatches)
    let assessment = assessNetwork(requirement, config.policy, callers, blocked ? [requirement.host] : [])
    const ruleName = `setup-${setup.id.slice(0, 8)}-${item.id.slice(0, 8)}-${index}`
    const path = requirement.phase === 'runtime' && item.config?.url && new URL(item.config.url).hostname === requirement.host ? new URL(item.config.url).pathname : requirement.phase === 'auth' ? requirement.path : undefined
    const provider = requirement.phase === 'runtime' ? item.credentialRef?.provider : undefined
    const endpoint = { host: requirement.host, port: requirement.port, protocol: 'rest', enforcement: 1, access: 2, ...(path ? { path } : {}), ...(provider ? { credentialBinding: { provider } } : {}) }
    const own = config.policy?.networkPolicies?.[ruleName]
    if (own && !blocked && callers.length && own.binaries?.length === callers.length && callers.every(p => own.binaries.some(b => b.path === p)) && own.endpoints?.length === 1) {
      const e = own.endpoints[0]
      if (e.host === endpoint.host && e.port === endpoint.port && e.protocol === 'rest' && e.enforcement === 1 && e.access === 2 && (e.path || '') === (path || '') && !e.denyRules?.length && !e.rules?.length && !e.allowedIps?.length && (e.credentialBinding?.provider || '') === (provider || '')) assessment = { status: 'allowed', reason: 'Reviewed Setup access is active.' }
    }
    // The Setup's own egress policy opens this once the sandbox joins it; credentials still need a reviewed grant.
    const covered = !blocked && !provider && assessment.status !== 'allowed' && setupPolicyCoverage(requirement, setup, scoped, callers, config.policy)
    if (covered) assessment = { status: 'policy', reason: `Allowed by the egress policy “${covered.name}”.` }
    else if (!blocked && config.policySource !== 2 && callers.length && (assessment.status === 'missing' || (assessment.status === 'allowed' && provider && !own))) {
      if (own) assessment = { status: 'review', reason: 'Managed access changed. Review this rule in Egress before replacing it.' }
      else {
        grants.push({ ruleName, rule: { name: ruleName, binaries: callers.map(path => ({ path })), endpoints: [endpoint] } })
        assessment = { status: 'proposed', reason: 'Approve this destination for the listed executable. Other destinations remain governed by existing policy.' }
      }
    }
    if (config.policySource === 2 && assessment.status !== 'allowed') assessment = { status: 'blocked', reason: 'Gateway global policy is authoritative. An administrator must update it.' }
    if (!callers.length) assessment = { status: 'review', reason: 'The actual network executable could not be established for this tool.' }
    return { ...requirement, item: item.name, binaries: callers, credentialProvider: provider, ...assessment }
  }))
  const identity = setupAccessIdentity({ gateway: target.endpoint, workspace, id: sandbox.id, createdAt: sandbox.createdAt, policy: accessPolicyIdentity(config.policy), org, scoped, group: member.group, revision: setup.revision, targets, executables: probe?.networkExecutables, grants })
  return { client, gateway: target.endpoint, workspaceScope, sandbox, setup, targets, problems, network, grants, inactive, identity, installed: probe?.installed ?? false }
}
const ENABLEABLE = ['allowed', 'proposed', 'policy']
function planView(plan) {
  const notes = [
    ...(plan.network.some((r) => r.status === 'policy') ? ['Websites allowed by the setup’s egress policy open to any program in this sandbox.'] : []),
    ...(plan.grants.length ? ['Websites you approve here open only to the listed program.'] : []),
    ...(plan.setup.items.some((i) => i.kind === 'skill') ? ['Skills use the sandbox’s existing network access.'] : []),
  ]
  return { name: plan.setup.name, sandbox: plan.sandbox.name, revision: plan.setup.revision, targets: plan.targets, problems: plan.problems, network: plan.network, inactive: plan.inactive, requiresApproval: plan.grants.length > 0, installed: plan.installed, canEnable: !plan.problems.length && plan.network.every((r) => ENABLEABLE.includes(r.status)), notes }
}
export async function deploymentRoute(method, parts, input, options = {}) {
  return runWithContext(contextSelection(), () => runDeploymentRoute(method, parts, input, options))
}
async function runDeploymentRoute(method, parts, input, { expectedSandbox } = {}) {
  const state = deploymentState()
  if (parts[0] !== 'setups' || parts.length !== 3 || !SETUP_ID.test(parts[1])) return undefined
  const [, id, action] = parts
  if (method === 'GET' && action === 'jobs') return [...new Map([...state.jobs.values()].filter((j) => j.setup === id).map((j) => [j.sandbox, j])).values()]
  if (method !== 'POST') return undefined
  const name = String(input.sandbox ?? '')
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(name)) throw fail('Choose a sandbox.')
  if (action === 'preview') {
    for (const [key, p] of state.previews) if (p.expires < Date.now()) state.previews.delete(key)
    if (state.previews.size >= 100) throw fail('Too many previews. Wait for old previews to expire.', 429)
    const plan = await inspectTarget(name, id, input.targets, expectedSandbox)
    const pinnedSandbox = { id: plan.sandbox.id, gateway: plan.gateway }
    const token = randomUUID(); state.previews.set(token, { id, name, targets: input.targets, expectedSandbox: pinnedSandbox, identity: plan.identity, expires: Date.now() + 5 * 60_000 })
    return { ...planView(plan), token }
  }
  if (action === 'enable' || action === 'remove') {
    const preview = state.previews.get(input.token)
    if (!preview || preview.expires < Date.now() || preview.id !== id || preview.name !== name) throw fail('Preview expired. Check the sandbox again.', 409)
    const lock = name
    if (state.locks.has(lock)) throw fail('Another Setup operation is running for this sandbox.', 409)
    state.locks.add(lock)
    try {
      const [plan, members] = await Promise.all([inspectTarget(name, id, preview.targets, preview.expectedSandbox || expectedSandbox), readSetupMembers()])
      if (preview.identity !== plan.identity) throw fail('The sandbox or its policy changed. Review a fresh preview.', 409)
      if (action === 'enable' && !planView(plan).canEnable) throw fail('Resolve the missing requirements before enabling.', 409)
      if (action === 'enable' && plan.grants.length && input.approveAccess !== true) throw fail('Approve the listed runtime access before enabling.', 409)
      if (action === 'enable') { await assertCurrentSandbox(plan); await installArtifacts(plan.client, plan.sandbox, plan.setup.items) }
      const joined = memberIds(plan.setup).filter((setupId) => !sandboxSetups(members, plan.sandbox, plan.gateway).includes(setupId))
      let result
      try {
        if (action === 'enable') await activateAccess(plan)
        await assertCurrentSandbox(plan)
        result = await executeInstaller(plan.client, plan.sandbox, plan.setup, preview.targets, action === 'enable' ? 'apply' : 'remove')
      } catch (e) {
        // A failed enable takes the sandbox back out of the Setup policies it had just joined.
        if (action === 'enable' && joined.length) await leaveSetup(plan, joined)
        throw e
      }
      if (action === 'enable') result.checks = await verifySetup(plan)
      else await leaveSetup(plan, memberIds(plan.setup))
      result.inactive = plan.inactive
      state.previews.delete(input.token)
      const job = { setup: id, sandbox: name, targets: preview.targets, ...result, at: new Date().toISOString() }
      state.jobs.set(keyFor(plan.sandbox, id), job)
      return job
    } finally { state.locks.delete(lock) }
  }
  return undefined
}

// Start with a shell for Setup-bearing templates. Imported code is not invoked
// until after the operator opens/restarts the agent following reconciliation.
export async function startSetupInstall(name, ids, targets, expectedId, approvedRevisions = {}, expectedGateway) {
  return runWithContext(contextSelection(), () => startInstall(name, ids, targets, expectedId, approvedRevisions, expectedGateway))
}
async function startInstall(name, ids, targets, expectedId, approvedRevisions, expectedGateway) {
  const state = deploymentState()
  const expectedSandbox = { id: expectedId, gateway: expectedGateway ?? (await gateway()).target.endpoint }
  const setups = await resolveSetups(ids)
  validateTargets(targets)
  for (const setup of setups) state.jobs.set(`${name}:${setup.id}`, { setup: setup.id, sandbox: name, targets, status: 'waiting', at: new Date().toISOString() })
  void (async () => {
    const { client, workspaceScope } = await gateway()
    let ready = false
    for (let i = 0; i < 60; i++) {
      const box = sandboxView((await client.raw.getSandbox({ name, workspaceScope })).sandbox)
      assertSandboxIdentity(box, (await gateway()).target.endpoint, expectedSandbox)
      if (box.phase === 'ready') { ready = true; break }
      if (['error', 'deleting', 'stopped'].includes(box.phase)) break
      await new Promise((resolve) => setTimeout(resolve, 2000))
    }
    for (const setup of setups) {
      let result
      try {
        if (!ready) throw fail('Sandbox is not ready. Retry from its Setups tab.')
        if ((await setupStore.get(setup.id)).revision !== setup.revision) throw fail('Setup changed after creation. Review the updated version before enabling.')
        const preview = await deploymentRoute('POST', ['setups', setup.id, 'preview'], { sandbox: name, targets }, { expectedSandbox })
        if (!preview.canEnable) result = { status: 'blocked', error: [...preview.problems, ...preview.network.filter((r) => !ENABLEABLE.includes(r.status)).map((r) => `${r.host}: ${r.reason}`)].join(' ') }
        else result = await deploymentRoute('POST', ['setups', setup.id, 'enable'], { sandbox: name, token: preview.token, approveAccess: approvedRevisions[setup.id] === setup.revision }, { expectedSandbox })
      } catch (e) { result = { status: 'failed', error: e.message } }
      state.jobs.set(`${name}:${setup.id}`, { setup: setup.id, sandbox: name, targets, ...result, at: new Date().toISOString() })
    }
  })().catch(() => { for (const setup of setups) state.jobs.set(`${name}:${setup.id}`, { setup: setup.id, sandbox: name, status: 'failed', error: 'Could not reach the sandbox. Retry from its Setups tab.' }) })
}

// Leaving takes the Setup's egress policy out of the sandbox now rather than on the next sweep.
async function leaveSetup({ sandbox, gateway: endpoint }, ids) {
  await removeSandboxSetups({ ...sandbox, gateway: endpoint }, ids)
  try { await syncAll({ only: (s) => s.id === sandbox.id, force: false }) } catch { /* stored revocation is applied by the next policy sync */ }
}
async function activateAccess(plan) {
  const { client, workspaceScope, sandbox, setup } = plan
  const expected = { id: sandbox.id, gateway: plan.gateway }
  // Policy snapshots and their gateway effects share the mutation queue, so
  // a concurrent revocation cannot be overwritten by this enable.
  await serializeOrgWrite(async () => {
    await assertCurrentSandbox(plan)
    for (const provider of new Set(setup.items.map(i => i.credentialRef?.provider).filter(Boolean))) {
      // Recheck the profile: attaching a changed profile must not introduce grants.
      const found = (await client.raw.getProvider({ name: provider, workspaceScope })).provider
      const profile = (await client.raw.getProviderProfile({ id: found.type, workspaceScope })).profile
      if (!profile || profile.endpoints?.length) throw fail('The credential profile changed. Reconnect a dedicated MCP secret.', 409)
      await client.raw.attachSandboxProvider({ sandbox: sandbox.name, provider, workspaceScope, requestId: randomUUID() })
    }
    const resource = (await client.raw.getSandbox({ name: sandbox.name, workspaceScope })).sandbox
    const fresh = await inspectTarget(sandbox.name, setup.id, plan.targets, expected)
    if (fresh.identity !== plan.identity) throw fail('Sandbox access changed while preparing. Review a fresh preview before enabling.',409)
    // Joined only after that check: the 15-second policy sync would otherwise apply the Setup's policy mid-review.
    await addSandboxSetups({ ...sandbox, gateway: plan.gateway }, memberIds(setup))
    if (plan.grants.length || plan.network.some((r) => r.status === 'policy')) {
      const managed = await managedOpsFor(client, workspaceScope, sandbox.name, plan.grants.flatMap(g => g.rule.endpoints.map(e => e.port)), plan.gateway)
      await client.raw.updateConfig({ sandbox: sandbox.name, workspaceScope, global: false, expectedResourceVersion: resource.metadata?.resourceVersion, mergeOperations: [...plan.grants.map(g => ({ operation: { case: 'addRule', value: g } })), ...managed], annotations: { 'openshell.console/setup-revision': setup.revision }, requestId: randomUUID() })
    }
  })
  for (let i = 0; i < 20; i++) {
    const status = await client.raw.getSandboxPolicyStatus({ sandbox: sandbox.name, workspaceScope })
    if (status.revision?.status === 2 && status.activeVersion === status.revision.version) {
      const applied = await inspectTarget(sandbox.name, setup.id, plan.targets, expected)
      if (applied.problems.length || applied.network.some(r => r.status !== 'allowed')) throw fail('Effective access no longer matches the reviewed Setup. Check requirements again.',409)
      return
    }
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  throw fail('Access was submitted but has not loaded. Check requirements again; configuration was not installed.', 409)
}
async function verifySetup({ client, sandbox, setup }) {
  const checks = []
  for (const item of setup.items) {
    if (item.kind === 'skill') { checks.push({ item: item.name, status: 'files-verified', reason: 'Scripts were not executed.' }); continue }
    if (item.auth?.mode === 'agent-session') { checks.push({item:item.name,status:'sign-in-in-agent',reason:'Configuration installed. Authenticate and check tool availability in the selected agent; the console does not read its OAuth session.'}); continue }
    try {
      const result = await client.sandbox.exec(sandbox.name, ['node', '-e', verifier], { workspace: sandbox.workspace, noLoginShell: true, stdin: Buffer.from(JSON.stringify({ config: item.config })), timeoutSecs: 35 })
      const check = JSON.parse(result.stdout.toString())
      checks.push({ item: item.name, ...check })
    } catch { checks.push({ item: item.name, status: 'unverified', reason: 'Check needs Node.js 22 or later and compatible runtime access. Files are installed.' }) }
  }
  return checks
}
