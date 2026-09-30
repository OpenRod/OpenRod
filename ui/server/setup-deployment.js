import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { gateway, WORKSPACE, sandboxView } from './gateway.js'
import { setupStore, resolveSetups, SETUP_ID } from './setups.js'
import { fail, hash } from './setup-discovery.js'
import { hostMatches } from '../src/lib/egress.js'
import { readOrg, blockedBy, orgRoute } from './org.js'
import { listPolicies, blockedByPolicy } from './egress.js'

const installer = await fs.readFile(path.join(import.meta.dirname, 'setup-installer.py'), 'utf8')
const TARGETS = ['codex', 'claude', 'cursor']
const COMMAND = { codex: 'codex', claude: 'claude', cursor: 'cursor-agent' }
const stateKey = Symbol.for('openshell.console.setup-deployments.v1')
const state = globalThis[stateKey] ??= { previews: new Map(), jobs: new Map(), locks: new Set() }
const keyFor = (sandbox, id) => `${sandbox.name}:${id}`
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

export async function executeInstaller(client, sandbox, setup, targets, operation) {
  const result = await client.sandbox.exec(sandbox.name, ['python3', '-c', installer], { workspace: sandbox.workspace || 'default', noLoginShell: true, timeoutSecs: 60, signal: AbortSignal.timeout(65_000), stdin: Buffer.from(JSON.stringify({ setup, targets, operation })) })
  let output
  try { output = JSON.parse(result.stdout.toString()) } catch { throw fail('The sandbox needs Python 3.11 or later and writable agent configuration folders.', 409) }
  if (result.exitCode !== 0 || output.error) throw fail(output.error || 'Setup operation failed.', 409)
  return output
}
function validateTargets(targets) { if (!Array.isArray(targets) || !targets.length || targets.length > 3 || new Set(targets).size !== targets.length || targets.some((t) => !TARGETS.includes(t))) throw fail('Choose at least one supported target agent.') }
async function inspectTarget(name, id, targets) {
  validateTargets(targets)
  const setup = await setupStore.get(id)
  const { client, target } = await gateway()
  const sandbox = sandboxView((await client.raw.getSandbox({ name, workspaceScope: WORKSPACE })).sandbox)
  if (sandbox.phase !== 'ready') throw fail('Start the sandbox before enabling or removing a Setup.', 409)
  const [config, org, scoped, fleet, status] = await Promise.all([client.raw.getSandboxConfig({ name, workspaceScope: WORKSPACE }), readOrg(), listPolicies(), orgRoute('GET', ['org']), client.raw.getSandboxPolicyStatus({ sandbox: name, workspaceScope: WORKSPACE })])
  const problems = setup.items.flatMap((item) => item.issues.map((issue) => `${item.name}: ${issue}`))
  if (config.configurationAdmitted === false || (!status.revision || status.revision.status !== 2 || status.activeVersion !== status.revision.version)) problems.push('The effective sandbox policy has not loaded successfully. Resolve it before enabling a Setup.')
  let probe = null
  try { probe = await executeInstaller(client, sandbox, setup, targets, 'probe') } catch (e) { problems.push(e.message) }
  if (probe?.installed && JSON.stringify([...probe.targets].sort()) !== JSON.stringify([...targets].sort())) problems.push(`This Setup is assigned to ${probe.targets.join(', ')}. Select those agents to reapply or remove it.`)
  const binaries = targets.map((t) => probe?.networkExecutables?.[COMMAND[t]] || 'unverified-script-caller')
  if (probe) for (const [command, found] of Object.entries(probe.executables)) if (!found) problems.push(`${command} is missing. Rebuild the image with this executable installed.`)
  const member = { name, group: fleet.assignments?.[name] ?? null }
  const network = setup.items.flatMap((item) => item.requirements.filter((r) => r.phase === 'runtime').map((requirement) => {
    const blocked = blockedBy(org, [requirement.host]) || blockedByPolicy(scoped, member, [requirement.host], hostMatches)
    return { ...requirement, item: item.name, ...assessNetwork(requirement, config.policy, binaries, blocked ? [requirement.host] : []) }
  }))
  const identity = hash(JSON.stringify({ gateway: target.endpoint, id: sandbox.id, createdAt: sandbox.createdAt, policy: config.policy, org, scoped, group: member.group, revision: setup.revision, targets }))
  return { client, sandbox, setup, targets, problems, network, identity, installed: probe?.installed ?? false }
}
function planView(plan) {
  return { name: plan.setup.name, sandbox: plan.sandbox.name, revision: plan.setup.revision, targets: plan.targets, problems: plan.problems, network: plan.network, installed: plan.installed, canEnable: !plan.problems.length && plan.network.every((r) => r.status === 'allowed'), notes: ['No network rules are added or changed.', 'Installation verifies files only. Restart the agent and complete any sign-in to test MCP connectivity.', 'Skills and local MCPs use the sandbox’s existing permissions; additional runtime destinations may still be blocked.'] }
}
export async function deploymentRoute(method, parts, input) {
  if (parts[0] !== 'setups' || parts.length !== 3 || !SETUP_ID.test(parts[1])) return undefined
  const [, id, action] = parts
  if (method === 'GET' && action === 'jobs') return [...new Map([...state.jobs.values()].filter((j) => j.setup === id).map((j) => [j.sandbox, j])).values()]
  if (method !== 'POST') return undefined
  const name = String(input.sandbox ?? '')
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(name)) throw fail('Choose a sandbox.')
  if (action === 'preview') {
    for (const [key, p] of state.previews) if (p.expires < Date.now()) state.previews.delete(key)
    if (state.previews.size >= 100) throw fail('Too many previews. Wait for old previews to expire.', 429)
    const plan = await inspectTarget(name, id, input.targets)
    const token = randomUUID(); state.previews.set(token, { id, name, targets: input.targets, identity: plan.identity, expires: Date.now() + 5 * 60_000 })
    return { ...planView(plan), token }
  }
  if (action === 'enable' || action === 'remove') {
    const preview = state.previews.get(input.token)
    if (!preview || preview.expires < Date.now() || preview.id !== id || preview.name !== name) throw fail('Preview expired. Check the sandbox again.', 409)
    const lock = name
    if (state.locks.has(lock)) throw fail('Another Setup operation is running for this sandbox.', 409)
    state.locks.add(lock)
    try {
      const plan = await inspectTarget(name, id, preview.targets)
      if (preview.identity !== plan.identity) throw fail('The sandbox or its policy changed. Review a fresh preview.', 409)
      if (action === 'enable' && !planView(plan).canEnable) throw fail('Resolve the missing requirements before enabling.', 409)
      const result = await executeInstaller(plan.client, plan.sandbox, plan.setup, preview.targets, action === 'enable' ? 'apply' : 'remove')
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
export async function startSetupInstall(name, ids, targets, expectedId) {
  const setups = await resolveSetups(ids)
  validateTargets(targets)
  for (const setup of setups) state.jobs.set(`${name}:${setup.id}`, { setup: setup.id, sandbox: name, targets, status: 'waiting', at: new Date().toISOString() })
  void (async () => {
    const { client } = await gateway()
    let ready = false
    for (let i = 0; i < 60; i++) {
      const box = sandboxView((await client.raw.getSandbox({ name, workspaceScope: WORKSPACE })).sandbox)
      if (expectedId && box.id !== expectedId) throw fail('Sandbox was replaced. Review the Setup for the new sandbox.')
      if (box.phase === 'ready') { ready = true; break }
      if (['error', 'deleting', 'stopped'].includes(box.phase)) break
      await new Promise((resolve) => setTimeout(resolve, 2000))
    }
    for (const setup of setups) {
      let result
      try {
        if (!ready) throw fail('Sandbox is not ready. Retry from its Setups tab.')
        const preview = await deploymentRoute('POST', ['setups', setup.id, 'preview'], { sandbox: name, targets })
        if (!preview.canEnable) result = { status: 'blocked', error: [...preview.problems, ...preview.network.filter((r) => r.status !== 'allowed').map((r) => `${r.host}: ${r.reason}`)].join(' ') }
        else result = await deploymentRoute('POST', ['setups', setup.id, 'enable'], { sandbox: name, token: preview.token })
      } catch (e) { result = { status: 'failed', error: e.message } }
      state.jobs.set(`${name}:${setup.id}`, { setup: setup.id, sandbox: name, targets, ...result, at: new Date().toISOString() })
    }
  })().catch(() => { for (const setup of setups) state.jobs.set(`${name}:${setup.id}`, { setup: setup.id, sandbox: name, status: 'failed', error: 'Could not reach the sandbox. Retry from its Setups tab.' }) })
}
