import test from 'node:test'
import assert from 'node:assert/strict'
import { packageLaunch, resolvePackage } from './setup-packages.js'
import { normalizeMcp, publicItem } from './setup-discovery.js'
import { runtimeRequirements, clearPreparationIssues } from './setup-preparation.js'
import { usableSetup } from './setups.js'
import { oauthFetch, publicHTTPS } from './setup-http.js'

test('package adapter pins supported npx launchers and rejects shell, arbitrary URLs and secret args', async () => {
  const launch = packageLaunch('npx', ['-y', '@magicuidesign/mcp@latest'])
  assert.equal(launch.name, '@magicuidesign/mcp')
  for (const args of [['https://evil.example/code.js'], ['--package', 'x'], ['x', '--token=secret'], ['x','--token','value'], ['x;touch/tmp/a']]) assert.equal(packageLaunch('npx', args), null)
  const pinned = await resolvePackage(launch, async () => new Response(JSON.stringify({name:launch.name,version:'2.0.0',bin:{mcp:'dist/server.js'},dist:{integrity:'sha512-'+ 'A'.repeat(86) + '=='}})))
  assert.equal(pinned.version, '2.0.0')
  assert.equal(pinned.bin, 'mcp')
  await assert.rejects(resolvePackage(launch, async () => new Response(JSON.stringify({name:'other',version:'1.0.0'}))), /verifiable/)
})
test('ordinary settings, secrets and desktop paths receive separate treatment', () => {
  const item = normalizeMcp('sample', {command:'safe-mcp',env:{LOG_LEVEL:'info',GOOGLE_WORKSPACE_PROJECT_ID:'my-project',API_TOKEN:'private-value',HOME:'/Users/private'}}, 'codex')
  assert.equal(item.config.env.LOG_LEVEL, 'info')
  assert.equal(item.config.env.GOOGLE_WORKSPACE_PROJECT_ID, 'my-project')
  assert.deepEqual(item.credentialFields, ['API_TOKEN'])
  assert.ok(item.issues.some(i => i.includes('Local setting HOME')))
  assert.ok(!JSON.stringify(publicItem(item)).includes('private-value'))
  assert.deepEqual(publicItem(item).sourceCredentialFields, ['API_TOKEN'])
})
test('partial deployment excludes disabled, unresolved and unconfigured MCPs', () => {
  const usable = usableSetup({id:'one',revision:'pinned',items:[{id:'a',kind:'skill',issues:[]},{id:'b',kind:'mcp',issues:[],config:{command:'node'}},{id:'c',kind:'mcp',issues:['needs sign-in']},{id:'d',kind:'mcp',issues:[],disabled:true,config:{command:'node'}},{id:'e',kind:'mcp',issues:[],config:null}]})
  assert.deepEqual(usable.items.map(i=>i.id), ['a','b'])
  assert.equal(usable.revision,'pinned')
})
test('runtime review accepts exact public names and rejects wildcards, URLs and private literals', () => {
  assert.deepEqual(runtimeRequirements(['api.example.com','api.example.com']).map(r=>r.host), ['api.example.com'])
  for (const host of ['*.example.com','https://api.example.com','127.0.0.1','localhost','service.local']) assert.throws(()=>runtimeRequirements([host]), /exact public/)
})
test('OAuth fetch blocks unreviewed destinations before any network access', async () => {
  const pending = new Set()
  await assert.rejects(oauthFetch('https://auth.example.com/token', {}, new Set(), pending), /Review/)
  assert.deepEqual([...pending], ['auth.example.com'])
  await assert.rejects(oauthFetch('https://127.0.0.1/token', {}, new Set(['127.0.0.1'])), /private|reserved/)
  for (const url of ['http://example.com','https://user:pass@example.com','https://example.com:8443']) assert.throws(()=>publicHTTPS(url), /public HTTPS/)
})
test('desktop OAuth sessions are deferred to the sandbox agent without becoming import blockers', () => {
  const item = normalizeMcp('remote', {url:'https://mcp.example.com/mcp',oauth:{existingSession:'do-not-copy'}}, 'codex')
  assert.equal(item.auth.mode, 'agent-session')
  assert.deepEqual(item.issues, [])
  assert.ok(!JSON.stringify(publicItem(item)).includes('do-not-copy'))
})

test('known package registries are proposed separately from build access', () => {
  const item = normalizeMcp('shadcn', {command:'npx',args:['shadcn@latest','mcp']}, 'codex')
  assert.ok(item.requirements.some(r=>r.phase==='runtime'&&r.host==='ui.shadcn.com'))
  assert.ok(item.requirements.some(r=>r.phase==='build'&&r.host==='registry.npmjs.org'))
})
test('retry clears only errors produced by the previous preparation', () => {
  const item=clearPreparationIssues({issues:['Unsupported launcher','Registry failed'],preparationIssues:['Registry failed']})
  assert.deepEqual(item.issues,['Unsupported launcher'])
  assert.deepEqual(item.preparationIssues,[])
})

test('credential attachment ignores only inert provider rules in the access identity', async () => {
  const { accessPolicyIdentity } = await import('./setup-deployment.js')
  const base={version:1,networkPolicies:{}}
  assert.deepEqual(accessPolicyIdentity({...base,networkPolicies:{_provider_test:{endpoints:[],binaries:[]}}}),base)
  assert.notDeepEqual(accessPolicyIdentity({...base,networkPolicies:{_provider_test:{endpoints:[{host:'example.com'}],binaries:[]}}}),base)
})

test('startup timeout distinguishes admitted policy from VM failure and marks the outage', async () => {
  const { waitReady } = await import('./setup-packages.js')
  const client = {raw:{getSandbox:async()=>({sandbox:{metadata:{name:'builder'},status:{phase:1,conditions:[{type:'Ready',status:'False',reason:'ConfigurationPending',message:'Waiting for validation'}]}}}),getSandboxConfig:async()=>({configurationAdmitted:true})}}
  await assert.rejects(waitReady(client,'builder',undefined,{attempts:1,wait:async()=>{}}),error=>error.preparationUnavailable===true&&error.status===503&&error.message.includes('policy, but the VM did not start'))
  client.raw.getSandboxConfig=async()=>({configurationAdmitted:false,configurationError:'Invalid policy'})
  await assert.rejects(waitReady(client,'builder',undefined,{attempts:1,wait:async()=>{}}),/Invalid policy/)
})


test('registry connectivity failure is surfaced before running npm', async () => {
  const { checkPreparationRegistry } = await import('./setup-packages.js')
  let reachable = false
  const client = {sandbox:{exec:async(name,command,options)=>{
    assert.equal(name,'builder')
    assert.ok(command[2].includes("https://registry.npmjs.org/"))
    assert.equal(options.timeoutSecs,15)
    return {exitCode:reachable?0:1}
  }}}
  await assert.rejects(checkPreparationRegistry(client,'builder'),error=>error.preparationUnavailable===true&&error.message.includes('cannot reach registry.npmjs.org'))
  reachable=true
  await checkPreparationRegistry(client,'builder')
})

test('metadata outages stop preparation, but missing package versions remain item errors', async () => {
  const plan = packageLaunch('npx', ['example'])
  for (const fetcher of [async()=>{throw new TypeError('fetch failed')}, async()=>new Response('',{status:503}), async()=>new Response('',{status:429})]) {
    await assert.rejects(resolvePackage(plan, fetcher), error=>error.preparationUnavailable===true)
  }
  await assert.rejects(resolvePackage(plan,async()=>new Response('',{status:404})),error=>!error.preparationUnavailable&&error.status===400)
  const controller=new AbortController();controller.abort()
  await assert.rejects(resolvePackage(plan,async()=>{throw controller.signal.reason},controller.signal),error=>error===controller.signal.reason)
})

test('an outage during npm installation stops the job without repeating the entire install', async () => {
  const { installPackage } = await import('./setup-packages.js')
  let calls=0,code='ETIMEDOUT'
  const client={sandbox:{exec:async(name,command,options)=>{
    calls++
    assert.ok(options.timeoutSecs<=250)
    assert.ok(options.signal)
    return {exitCode:1,stdout:Buffer.from(JSON.stringify({code}))}
  }}}
  await assert.rejects(installPackage(client,'builder',{}),error=>error.preparationUnavailable===true&&error.message.includes('ETIMEDOUT'))
  assert.equal(calls,1)
  code='EACCES'
  await assert.rejects(installPackage(client,'builder',{}),error=>!error.preparationUnavailable&&error.message.includes('EACCES'))
  assert.equal(calls,2)
  client.sandbox.exec=async()=>({exitCode:0,stdout:Buffer.from(JSON.stringify({bin:'node_modules/example/server.js'}))})
  assert.equal((await installPackage(client,'builder',{})).bin,'node_modules/example/server.js')
})

test('gateway execution failures halt preparation and cancellation stays cancellation', async () => {
  const { checkPreparationRegistry, installPackage } = await import('./setup-packages.js')
  const client={sandbox:{exec:async()=>{throw new Error('connection closed')}}}
  await assert.rejects(checkPreparationRegistry(client,'builder'),error=>error.preparationUnavailable===true)
  await assert.rejects(installPackage(client,'builder',{}),error=>error.preparationUnavailable===true)
  const controller=new AbortController();controller.abort()
  await assert.rejects(checkPreparationRegistry(client,'builder',controller.signal),error=>error===controller.signal.reason)
  await assert.rejects(installPackage(client,'builder',{},controller.signal),error=>error===controller.signal.reason)
})
