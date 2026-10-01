import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

// Exercise the real importer, preparation loop, SDK metadata discovery and
// snapshot store in a disposable console. Only remote transports are replaced.
async function fixture(t) {
  const source = path.resolve(import.meta.dirname, '..')
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'setup-import-'))
  const keys = ['OPENSHELL_CONSOLE_DATA_DIR', 'OPENSHELL_GATEWAY', 'OPENSHELL_WORKSPACE']
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]))
  Object.assign(process.env, { OPENSHELL_CONSOLE_DATA_DIR: path.join(root, 'state'), OPENSHELL_GATEWAY: 'setup-import-fixture', OPENSHELL_WORKSPACE: 'default' })
  t.after(async () => {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key]
      else process.env[key] = previous[key]
    }
    await fs.rm(root, { recursive: true, force: true })
  })
  for (const dir of ['server', 'shared', 'src']) await fs.cp(path.join(source, dir), path.join(root, dir), { recursive: true })
  await fs.copyFile(path.join(source, 'package.json'), path.join(root, 'package.json'))
  await fs.symlink(path.join(source, 'node_modules'), path.join(root, 'node_modules'), 'dir')
  await fs.writeFile(path.join(root, 'server/setup-remote-check.js'), `
export const checks = []
export let status = 'connected'
export function setStatus(value) { status = value }
export async function checkRemote(item) { checks.push(item); return {status,toolCount:status==='connected'?1:undefined} }
`)
  await fs.writeFile(path.join(root, 'server/setup-http.js'), `
export const metadataRequests = []
export function publicHTTPS(value) { return new URL(value) }
export async function oauthFetch(input) {
  const url = new URL(input); metadataRequests.push(url.pathname)
  // The host's account service is unrelated to its public MCP endpoint.
  if (url.hostname === 'accounts.example.com' && url.pathname === '/.well-known/oauth-authorization-server') return new Response(JSON.stringify({issuer:url.origin,authorization_endpoint:url.origin+'/authorize',token_endpoint:url.origin+'/token',response_types_supported:['code']}))
  return new Response('', {status:404})
}
`)
  const load = file => import(pathToFileURL(path.join(root, file)))
  const { createSetupStore, usableSetup } = await load('server/setups.js')
  const { scopedStateDirectory, policyDirectory } = await load('server/paths.js')
  const { normalizeMcp } = await load('server/setup-discovery.js')
  const { prepareImport, preparationStatus } = await load('server/setup-preparation.js')
  const { importSetup } = await load('src/lib/import-setup.js')
  const policyDir = await policyDirectory()
  const remote = await load('server/setup-remote-check.js')
  const metadata = await load('server/setup-http.js')
  const store = createSetupStore({ home: path.join(root, 'home'), dir: path.join(scopedStateDirectory(), 'setups') })
  const api = {
    prepareSetup: (token, items) => prepareImport(store, { token, items, approved: true }),
    setupPreparation: preparationStatus,
    saveSetup: (token, name, acknowledged) => store.save(token, name, acknowledged),
  }
  const run = (items, choices = {}) => importSetup(api, store.stage(items), 'Mixed setup', choices, { wait: () => new Promise(resolve => setTimeout(resolve, 1)) })
  return { store, run, remote, metadata, normalizeMcp, usableSetup, root, policyDir }
}
const skill = { id:'safe-skill',kind:'skill',name:'Safe skill',sources:['codex'],requirements:[],issues:[],credentialFields:[],files:[{path:'SKILL.md',content:'# Review code\n'}] }
const publicMcp = { id:'public',kind:'mcp',name:'Public MCP',config:{url:'https://accounts.example.com/public-mcp'},requirements:[{phase:'runtime',host:'accounts.example.com',port:443,path:'/public-mcp'}],issues:[],credentialFields:[] }

test('a known unsupported remote stays inactive while a compatible skill saves', async t => {
  const f = await fixture(t)
  f.remote.setStatus('unverified')
  const sse = { ...f.normalizeMcp('Old SSE tool', {url:'https://tool.example.com/mcp',type:'sse'}, 'codex'), id:'old-sse' }
  const result = await f.run([skill, sse])
  assert.equal(result.status, 'saved')
  assert.deepEqual(result.inactive, ['Old SSE tool'])
  const saved = await f.store.get(result.setup.id)
  assert.deepEqual(f.usableSetup(saved).items.map(item => item.id), ['safe-skill'])
  assert.deepEqual(saved.items[1].issues, ['Only Streamable HTTP is supported for remote MCPs.'])
  assert.equal(f.remote.checks.length, 0)
  assert.equal(f.metadata.metadataRequests.length, 0)
})

test('unrelated root OAuth metadata cannot turn a public MCP into agent sign-in', async t => {
  const f = await fixture(t)
  const result = await f.run([publicMcp])
  assert.equal(result.status, 'saved')
  const saved = await f.store.get(result.setup.id)
  assert.equal(saved.items[0].verification.status, 'connected')
  assert.equal(saved.items[0].auth, undefined)
  assert.equal(saved.items[0].state, 'prepared')
  assert.equal(f.remote.checks.length, 1)
})

test('a connected dedicated credential is verified instead of replaced with OAuth', async t => {
  const f = await fixture(t)
  const credentialRef = {provider:'dedicated-mcp',aliases:{AUTHORIZATION:'TEST_ALIAS'}}
  const item = { ...publicMcp, config:{...publicMcp.config,headers:{Authorization:'Bearer openshell:resolve:env:TEST_ALIAS'}},credentialRef }
  const result = await f.run([item])
  const saved = await f.store.get(result.setup.id)
  assert.equal(saved.items[0].verification.status, 'connected')
  assert.equal(saved.items[0].auth, undefined)
  assert.deepEqual(saved.items[0].credentialRef, credentialRef)
  assert.equal(f.remote.checks.length, 1)
  assert.deepEqual(f.remote.checks[0].config.headers, item.config.headers)
})

test('a rejected dedicated credential stays a new import error instead of becoming agent sign-in', async t => {
  const f = await fixture(t)
  f.remote.setStatus('needs-sign-in')
  const credentialRef = {provider:'dedicated-mcp',aliases:{AUTHORIZATION:'TEST_ALIAS'}}
  const result = await f.run([{ ...publicMcp, credentialRef }])
  assert.equal(result.status, 'needs-attention')
  assert.equal(result.review.items[0].auth, undefined)
  assert.deepEqual(await f.store.list(), [])
  assert.equal(f.remote.checks.length, 1)
})

test('explicit source OAuth keeps the metadata-only fast path', async t => {
  const f = await fixture(t)
  const item = { ...f.normalizeMcp('OAuth MCP', {url:publicMcp.config.url,oauth:{existingSession:'never-copy'}}, 'codex'), id:'oauth' }
  const result = await f.run([item])
  const saved = await f.store.get(result.setup.id)
  assert.equal(saved.items[0].verification.status, 'needs-sign-in')
  assert.equal(saved.items[0].auth.mode, 'agent-session')
  assert.equal(saved.items[0].state, 'sign-in-in-sandbox')
  assert.equal(f.remote.checks.length, 0)
  assert.ok(f.metadata.metadataRequests.length > 0)
  assert.ok(!JSON.stringify(saved).includes('never-copy'))
})

test('an endpoint sign-in challenge discovers OAuth after the connection check', async t => {
  const f = await fixture(t)
  f.remote.setStatus('needs-sign-in')
  const result = await f.run([publicMcp])
  const saved = await f.store.get(result.setup.id)
  assert.equal(saved.items[0].verification.status, 'needs-sign-in')
  assert.equal(saved.items[0].auth.mode, 'agent-session')
  assert.equal(saved.items[0].state, 'sign-in-in-sandbox')
  assert.equal(f.remote.checks.length, 1)
  assert.ok(f.metadata.metadataRequests.length > 0)
})


test('a blocked host on a known unsupported row cannot stop a compatible skill import', async t => {
 const f=await fixture(t)
 await fs.mkdir(path.join(f.policyDir,'org'),{recursive:true})
 await fs.writeFile(path.join(f.policyDir,'org/organization.json'),JSON.stringify({blocked:['tool.example.com']}))
 const sse={...f.normalizeMcp('Old SSE tool',{url:'https://tool.example.com/mcp',type:'sse'},'codex'),id:'old-sse'}
 const result=await f.run([skill,sse])
 assert.equal(result.status,'saved')
 assert.deepEqual(result.inactive,['Old SSE tool'])
 assert.equal(f.remote.checks.length,0)
 assert.deepEqual((await f.store.get(result.setup.id)).items[1].issues,['Only Streamable HTTP is supported for remote MCPs.'])
})

test('usable remote, pending package and provided credentials still respect new organization blocks', async t => {
 const f=await fixture(t)
 await fs.mkdir(path.join(f.policyDir,'org'),{recursive:true})
 await fs.writeFile(path.join(f.policyDir,'org/organization.json'),JSON.stringify({blocked:['accounts.example.com','registry.npmjs.org']}))
 const token={...f.normalizeMcp('Token MCP',{url:publicMcp.config.url,bearer_token_env_var:'API_TOKEN'},'codex'),id:'token'}
 const pending={...f.normalizeMcp('Package MCP',{command:'npx',args:['example-mcp']},'codex'),id:'package'}
 for(const item of [publicMcp,pending,token]){
  const result=await f.run([skill,item],item===token?{token:{secrets:{API_TOKEN:'fixture-only'}}}:{})
  assert.equal(result.status,'needs-attention',item.name)
  assert.ok(result.review.items[1].preparationIssues.some(issue=>issue.includes('organization blocks')))
 }
 assert.deepEqual(await f.store.list(),[])
 assert.equal(f.remote.checks.length,0)
})
