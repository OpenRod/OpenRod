import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'

const SETUP = 'a'.repeat(24)
async function fixture(t, saved) {
  const source = path.resolve(import.meta.dirname, '..')
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'openshell-setup-identity-')))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const previousData = process.env.OPENSHELL_CONSOLE_DATA_DIR
  process.env.OPENSHELL_CONSOLE_DATA_DIR = path.join(root, 'state')
  t.after(() => {
    if (previousData === undefined) delete process.env.OPENSHELL_CONSOLE_DATA_DIR
    else process.env.OPENSHELL_CONSOLE_DATA_DIR = previousData
  })
  for (const dir of ['server', 'shared', 'src']) await fs.cp(path.join(source, dir), path.join(root, dir), { recursive: true })
  await fs.copyFile(path.join(source, 'package.json'), path.join(root, 'package.json'))
  await fs.symlink(path.join(source, 'node_modules'), path.join(root, 'node_modules'), 'dir')
  const gatewayPath = path.join(root, 'server/gateway.js'), original = await fs.readFile(gatewayPath, 'utf8')
  await fs.writeFile(gatewayPath, original.replace('export async function gateway(', 'async function unusedLiveGateway(') + `
export const setupIdentityState = { endpoint: 'https://gateway-a', id: 'box-original', rules: {}, updates: [], staged: null, failApply: false, created: [] }
const record = () => ({ metadata: { id: setupIdentityState.id, name: 'web' }, status: { phase: 2 } })
const client = { raw: {
  async listSandboxes() { return { sandboxes: [record()] } },
  async getSandbox() { return { sandbox: record() } },
  async getSandboxPolicyStatus() { return { activeVersion: 1, revision: { version: 1, status: 2, policy: { networkPolicies: setupIdentityState.rules } } } },
  async getSandboxConfig() { return { configurationAdmitted: true, policy: { networkPolicies: setupIdentityState.rules } } },
  async updateConfig(input) {
    setupIdentityState.updates.push(input)
    for (const { operation } of input.mergeOperations) {
      if (operation.case === 'removeRule') delete setupIdentityState.rules[operation.value.ruleName]
      else setupIdentityState.rules[operation.value.ruleName] = operation.value.rule
    }
    return { version: 1 }
  },
  async getGatewayConfig() { return { settings: { proposal_approval_mode: { value: { value: 'manual' } }, agent_policy_proposals_enabled: { value: { value: false } } } } },
  async getDraftPolicy() { return { chunks: [] } },
}, sandbox: {
  async create(spec) { setupIdentityState.created.push(spec); setupIdentityState.id = 'box-created'; setupIdentityState.rules = spec.policy.networkPolicies; return { name: spec.name, id: setupIdentityState.id, phase: 'ready' } },
  async exec(name, args, options) {
    if (options.stdin) { setupIdentityState.staged = JSON.parse(options.stdin.toString()); return { exitCode: 0, stdout: Buffer.from('') } }
    if (!args[2].startsWith("import sys;sys.stdin=open")) return { exitCode: 0, stdout: Buffer.from('') }
    const request = setupIdentityState.staged
    if (request.operation === 'probe') return { exitCode: 0, stdout: Buffer.from(JSON.stringify({ installed: false, targets: ['claude'], executables: { claude: '/usr/bin/claude' }, networkExecutables: { claude: '/usr/bin/node', node: '/usr/bin/node' } })) }
    if (request.operation === 'apply' && setupIdentityState.failApply) { setupIdentityState.failApply = false; return { exitCode: 1, stdout: Buffer.from(JSON.stringify({ error: 'Injected installer failure' })) } }
    return { exitCode: 0, stdout: Buffer.from(JSON.stringify({ status: request.operation === 'remove' ? 'removed' : 'installed' })) }
  }
} }
export async function gateway() { return { client, target: { endpoint: setupIdentityState.endpoint } } }
`)
  const { policyDirectory, scopedStateDirectory } = await import(pathToFileURL(path.join(root, 'server/paths.js')))
  const policyDir = await policyDirectory(), stateDir = scopedStateDirectory()
  const write = async (file, value) => { const dest = file.startsWith('policies/') ? path.join(policyDir, file.slice(9)) : file.startsWith('.state/') ? path.join(stateDir, file.slice(7)) : path.join(root, file); await fs.mkdir(path.dirname(dest), { recursive: true }); await fs.writeFile(dest, JSON.stringify(value)) }
  await write('.state/setup-members.json', saved)
  await write(`policies/egress/setup-${SETUP}.json`, { id: `setup-${SETUP}`, name: 'Setup access', action: 'allow', destinations: ['setup.example.com'], appliesTo: { setups: [SETUP] } })
  const org = await import(pathToFileURL(path.join(root, 'server/org.js')))
  const gateway = await import(pathToFileURL(gatewayPath))
  const members = await import(pathToFileURL(path.join(root, 'server/setup-members.js')))
  const deployment = await import(pathToFileURL(path.join(root, 'server/setup-deployment.js')))
  const setups = await import(pathToFileURL(path.join(root, 'server/setups.js')))
  return { ...org, ...members, ...gateway, ...deployment, ...setups, setupStore: setups.getSetupStore(), root, stateDir, write }
}

test('actual sync and overview never grant legacy name-only setup membership', async t => {
  const h = await fixture(t, { web: [SETUP] })
  await h.syncAll()
  assert.deepEqual(h.setupIdentityState.rules, {})
  assert.deepEqual((await h.orgRoute('GET', ['org'])).setupMembers, {})
})

test('actual sync, port edits and overview bind setup access to the sandbox and gateway', async t => {
  const endpoint = 'https://gateway-a', key = JSON.stringify([endpoint, 'box-original'])
  const h = await fixture(t, { [key]: [SETUP] }), state = h.setupIdentityState
  await h.syncAll()
  assert.ok(Object.keys(state.rules).some(k => k.startsWith('egress_setup-')))
  assert.deepEqual((await h.orgRoute('GET', ['org'])).setupMembers, { web: [SETUP] })
  state.id = 'box-replacement'
  await h.syncAll()
  assert.deepEqual(state.rules, {}, 'replacement must lose original setup grants')
  assert.deepEqual((await h.orgRoute('GET', ['org'])).setupMembers, {})
  state.id = 'box-original'; state.endpoint = 'https://gateway-b'
  await h.syncAll()
  assert.deepEqual(state.rules, {}, 'same name/id on another gateway has no setup membership')
  const { client, workspaceScope } = await h.gateway()
  const ops = await h.managedOpsFor(client, workspaceScope, 'web', [8443], state.endpoint)
  assert.equal(ops.filter(op => op.operation.case === 'addRule').length, 0)
  state.endpoint = endpoint
  await h.syncAll()
  assert.ok(Object.keys(state.rules).some(k => k.startsWith('egress_setup-')), 'returning to original gateway restores its recorded membership')
})

const OTHER_SETUP = 'b'.repeat(24)
const currentIdentity = state => ({ name: 'web', id: state.id, gateway: state.endpoint })
const saveSkill = async h => {
  const review = h.setupStore.stage([{ id: 'skill-review', name: 'review', kind: 'skill', issues: [], requirements: [], files: [{ path: 'SKILL.md', content: '# Review' }] }])
  return h.setupStore.save(review.token, 'Review skills', true)
}

test('actual enabling, rollback and removal preserve unrelated identities and existing setup memberships', async t => {
  const h = await fixture(t, {}), state = h.setupIdentityState, setup = await saveSkill(h)
  const current = currentIdentity(state), elsewhere = { ...current, gateway: 'https://gateway-b' }
  await h.setSandboxSetups(current, [OTHER_SETUP])
  await h.setSandboxSetups(elsewhere, [SETUP])
  const route = (action, input = {}) => h.deploymentRoute('POST', ['setups', setup.id, action], { sandbox: 'web', targets: ['claude'], ...input })
  let preview = await route('preview')
  assert.equal(preview.canEnable, true)
  state.failApply = true
  await assert.rejects(route('enable', { token: preview.token }), /Injected installer failure/)
  let saved = await h.readSetupMembers()
  assert.deepEqual(h.sandboxSetups(saved, current, current.gateway), [OTHER_SETUP], 'rollback removes only memberships joined by this enable')
  assert.deepEqual(h.sandboxSetups(saved, elsewhere, elsewhere.gateway), [SETUP])
  preview = await route('preview')
  await route('enable', { token: preview.token })
  saved = await h.readSetupMembers()
  assert.deepEqual(h.sandboxSetups(saved, current, current.gateway), [OTHER_SETUP, setup.id])
  preview = await route('preview')
  await route('remove', { token: preview.token })
  saved = await h.readSetupMembers()
  assert.deepEqual(h.sandboxSetups(saved, current, current.gateway), [OTHER_SETUP])
  assert.deepEqual(h.sandboxSetups(saved, elsewhere, elsewhere.gateway), [SETUP], 'removing on one gateway leaves the other untouched')
  preview = await route('preview')
  state.endpoint = elsewhere.gateway
  await assert.rejects(route('enable', { token: preview.token }), /replaced|gateway changed|sandbox or its policy changed/)
})

test('actual creation records only the new sandbox identity returned by the gateway', async t => {
  const h = await fixture(t, {}), state = h.setupIdentityState, setup = await saveSkill(h)
  const old = currentIdentity(state)
  await h.setSandboxSetups(old, [OTHER_SETUP])
  await h.write('policies/org/groups/tools.json', { id: 'tools', name: 'Tools' })
  await h.write('policies/egress/tools.json', { id: 'tools', name: 'Tools', action: 'allow', destinations: ['example.com'], appliesTo: { groups: ['tools'] } })
  const { createSandbox } = await import(pathToFileURL(path.join(h.root, 'server/api.js')))
  await createSandbox({ name: 'web', image: 'test/image', groups: ['tools'], setups: [setup.id], setupTargets: ['claude'] })
  assert.equal(state.id, 'box-created')
  const saved = await h.readSetupMembers()
  assert.deepEqual(h.sandboxSetups(saved, state, state.endpoint), [setup.id])
  assert.deepEqual(h.sandboxSetups(saved, old, old.gateway), [OTHER_SETUP])
  for (let i = 0; i < 30 && h.setupJobsForSandbox('web').some(job => job.status === 'waiting'); i++) await new Promise(resolve => setTimeout(resolve, 10))
  assert.ok(h.setupJobsForSandbox('web').every(job => job.status !== 'waiting'))
})

test('setup removal reports a failed membership write so the operator can retry revocation', async t => {
  const h = await fixture(t, {}), state = h.setupIdentityState, setup = await saveSkill(h)
  const current = currentIdentity(state)
  await h.setSandboxSetups(current, [setup.id])
  const preview = await h.deploymentRoute('POST', ['setups', setup.id, 'preview'], { sandbox: 'web', targets: ['claude'] })
  const rename = fs.rename
  fs.rename = async (from, to) => {
    if (to === path.join(h.stateDir, 'setup-members.json')) throw Object.assign(new Error('Membership revocation denied'), { code: 'EACCES' })
    return rename(from, to)
  }
  try {
    await assert.rejects(h.deploymentRoute('POST', ['setups', setup.id, 'remove'], { sandbox: 'web', token: preview.token }), /Membership revocation denied/)
  } finally { fs.rename = rename }
  assert.deepEqual(h.sandboxSetups(await h.readSetupMembers(), current, current.gateway), [setup.id])
  await h.deploymentRoute('POST', ['setups', setup.id, 'remove'], { sandbox: 'web', token: preview.token })
  assert.deepEqual(h.sandboxSetups(await h.readSetupMembers(), current, current.gateway), [])
})

test('actual sandbox deletion forgets only the deleted identity and retains membership when deletion fails', async t => {
  const h = await fixture(t, {}), state = h.setupIdentityState, original = currentIdentity(state)
  const replacement = { ...original, id: 'box-replacement' }, elsewhere = { ...original, gateway: 'https://gateway-b' }
  await h.setSandboxSetups(original, [SETUP])
  await h.setSandboxSetups(replacement, [OTHER_SETUP])
  await h.setSandboxSetups(elsewhere, [OTHER_SETUP])
  // Expose the existing route helper in this disposable copy so its real
  // deletion and cleanup path can run without starting an HTTP server.
  const apiPath = path.join(h.root, 'server/api.js')
  await fs.writeFile(apiPath, (await fs.readFile(apiPath, 'utf8')).replace('async function lifecycle(', 'export async function lifecycle('))
  const { lifecycle } = await import(pathToFileURL(apiPath))
  const { client } = await h.gateway()
  client.sandbox.delete = async () => { throw new Error('Injected delete failure') }
  await assert.rejects(lifecycle('web', 'delete'), /Injected delete failure/)
  assert.deepEqual(h.sandboxSetups(await h.readSetupMembers(), original, original.gateway), [SETUP])
  client.sandbox.delete = async () => { state.id = replacement.id; return { deleted: true } }
  assert.deepEqual(await lifecycle('web', 'delete'), { deleted: true })
  const saved = await h.readSetupMembers()
  assert.deepEqual(h.sandboxSetups(saved, original, original.gateway), [])
  assert.deepEqual(h.sandboxSetups(saved, replacement, replacement.gateway), [OTHER_SETUP])
  assert.deepEqual(h.sandboxSetups(saved, elsewhere, elsewhere.gateway), [OTHER_SETUP])
})


for (const change of ['sandbox', 'gateway']) test(`creation installation rejects a ${change} replacement after readiness`, async t => {
 const h=await fixture(t,{}), current=h.setupIdentityState, setup=await saveSkill(h)
 const original={id:current.id,gateway:current.endpoint}
 const readFile=fs.readFile;let reads=0
 fs.readFile=async (...args)=>{
  const value=await readFile(...args)
  if(args[0]===path.join(h.stateDir,'setups',setup.id+'.json')&&++reads===2){
   if(change==='sandbox')current.id='box-replacement'
   else current.endpoint='https://gateway-b'
  }
  return value
 }
 try {
  await h.startSetupInstall('web',[setup.id],['claude'],original.id,{[setup.id]:setup.revision},original.gateway)
  for(let i=0;i<50&&h.setupJobsForSandbox('web').some(job=>job.status==='waiting');i++)await new Promise(resolve=>setTimeout(resolve,10))
 } finally {fs.readFile=readFile}
 assert.deepEqual(h.sandboxSetups(await h.readSetupMembers(),current,current.endpoint),[])
 const job=h.setupJobsForSandbox('web').find(job=>job.setup===setup.id)
 assert.equal(job.status,'failed')
 assert.match(job.error,/replaced|gateway changed/i)
 assert.equal(current.staged,null,'the replacement must not even receive an installer probe')
})


test('a concurrent setup-policy revocation cannot be reopened by enabling its setup', async t => {
 const h=await fixture(t,{}), current=h.setupIdentityState
 const review=h.setupStore.stage([{id:'remote-mcp',name:'Remote MCP',kind:'mcp',issues:[],requirements:[{phase:'runtime',host:'keep.example.com',port:443}],config:{url:'https://keep.example.com/mcp'}}])
 const setup=await h.setupStore.save(review.token,'Network tools',true)
 const {syncSetupPolicy}=await import(pathToFileURL(path.join(h.root,'server/setup-egress.js')))
 await syncSetupPolicy(await h.setupStore.get(setup.id))
 const policy=(await h.orgRoute('GET',['org'])).policies.find(p=>p.setup?.id===setup.id)
 const {policy:before}=await h.orgRoute('POST',['egress','policies'],{...policy,destinations:[...policy.destinations,'old.example.com']})
 const {client}=await h.gateway(), status=client.raw.getSandboxPolicyStatus
 let release,paused,calls=0
 const blocked=new Promise(resolve=>{release=resolve}),captured=new Promise(resolve=>{paused=resolve})
 client.raw.getSandboxPolicyStatus=async (...args)=>{const value=await status(...args);if(++calls===4){paused();await blocked}return value}
 try {
  const preview=await h.deploymentRoute('POST',['setups',setup.id,'preview'],{sandbox:'web',targets:['claude']})
  const enable=h.deploymentRoute('POST',['setups',setup.id,'enable'],{sandbox:'web',token:preview.token})
  await captured
  const revoke=h.orgRoute('POST',['egress','policies'],{...before,destinations:['keep.example.com']})
  await Promise.race([revoke,new Promise(resolve=>setTimeout(resolve,100))])
  release()
  await Promise.all([enable,revoke])
  const hosts=[...new Set(Object.values(current.rules).flatMap(r=>r.endpoints.map(e=>e.host)))].sort()
  assert.deepEqual(hosts,['keep.example.com'])
 } finally {release();client.raw.getSandboxPolicyStatus=status}
})

for (const change of ['sandbox', 'gateway']) test(`creation installation rejects a ${change} replacement during access polling and rolls back membership`, async t => {
 const h=await fixture(t,{}), current=h.setupIdentityState, setup=await saveSkill(h)
 const original={id:current.id,gateway:current.endpoint}
 const {client}=await h.gateway(), status=client.raw.getSandboxPolicyStatus, exec=client.sandbox.exec
 let replaced=false;const applies=[]
 client.raw.getSandboxPolicyStatus=async (...args)=>{
  const value=await status(...args)
  const joined=h.sandboxSetups(await h.readSetupMembers(),original,original.gateway).includes(setup.id)
  if(joined&&!replaced){replaced=true;if(change==='sandbox')current.id='box-replacement';else current.endpoint='https://gateway-b'}
  return value
 }
 client.sandbox.exec=async (...args)=>{
  if(args[1][2].startsWith('import sys;sys.stdin=open')&&current.staged?.operation==='apply')applies.push({id:current.id,gateway:current.endpoint})
  return exec(...args)
 }
 await h.startSetupInstall('web',[setup.id],['claude'],original.id,{[setup.id]:setup.revision},original.gateway)
 for(let i=0;i<100&&h.setupJobsForSandbox('web').some(job=>job.status==='waiting');i++)await new Promise(resolve=>setTimeout(resolve,10))
 const job=h.setupJobsForSandbox('web').find(job=>job.setup===setup.id)
 assert.equal(replaced,true)
 assert.equal(job.status,'failed')
 assert.match(job.error,/replaced|gateway changed/i)
 assert.deepEqual(applies,[],'the replacement must not receive setup files')
 assert.deepEqual(h.sandboxSetups(await h.readSetupMembers(),original,original.gateway),[],'a failed activation revokes only its original membership')
})

test('a public preview pins identity before any probe or credential attachment on enable', async t => {
 const h=await fixture(t,{}), current=h.setupIdentityState, setup=await saveSkill(h)
 const preview=await h.deploymentRoute('POST',['setups',setup.id,'preview'],{sandbox:'web',targets:['claude']})
 current.id='box-replacement';current.staged=null
 await assert.rejects(h.deploymentRoute('POST',['setups',setup.id,'enable'],{sandbox:'web',token:preview.token}),/replaced|gateway changed|policy changed/)
 assert.equal(current.staged,null,'a stale preview must fail before probing the replacement')
})

test('remove rechecks identity immediately before its installer effects', async t => {
 const h=await fixture(t,{}), current=h.setupIdentityState, setup=await saveSkill(h)
 const original={id:current.id,gateway:current.endpoint}
 await h.setSandboxSetups({...original,name:'web'},[setup.id])
 const preview=await h.deploymentRoute('POST',['setups',setup.id,'preview'],{sandbox:'web',targets:['claude']})
 const {client}=await h.gateway(), exec=client.sandbox.exec;const removals=[]
 client.sandbox.exec=async (...args)=>{
  const operation=args[1][2].startsWith('import sys;sys.stdin=open')&&current.staged?.operation
  const value=await exec(...args)
  if(operation==='probe')current.id='box-replacement'
  if(operation==='remove')removals.push(current.id)
  return value
 }
 await assert.rejects(h.deploymentRoute('POST',['setups',setup.id,'remove'],{sandbox:'web',token:preview.token}),/replaced|gateway changed/)
 assert.deepEqual(removals,[])
 assert.deepEqual(h.sandboxSetups(await h.readSetupMembers(),original,original.gateway),[setup.id])
})
