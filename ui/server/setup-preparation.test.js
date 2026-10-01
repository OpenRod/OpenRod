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
