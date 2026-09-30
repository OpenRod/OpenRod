import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createSetupStore } from './setups.js'
import { normalizeMcp, readSkill } from './setup-discovery.js'
import { assessNetwork } from './setup-deployment.js'

async function fixture(t) {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'setup-test-')))
  t.after(() => fs.rm(home, { recursive: true, force: true }))
  const put = async (name, value) => { const p = path.join(home, name); await fs.mkdir(path.dirname(p), { recursive: true }); await fs.writeFile(p, value); return p }
  return { home, put }
}
test('opt-in discovery deduplicates, excludes auth values, and pins selected files', async (t) => {
  const { home, put } = await fixture(t)
  await put('.codex/config.toml', '[mcp_servers.docs]\nurl="https://docs.example.com/mcp"\n[mcp_servers.private]\nurl="https://private.example.com/mcp"\n[mcp_servers.private.http_headers]\nAuthorization="do-not-serialize-me"\n')
  await put('.cursor/mcp.json', JSON.stringify({ mcpServers: { docs: { url: 'https://docs.example.com/mcp' } } }))
  const skill = await put('.agents/skills/testing/SKILL.md', '# Test skill\nUse this safe text.')
  await fs.mkdir(path.join(home, '.codex/skills'), { recursive: true })
  await fs.symlink(path.dirname(skill), path.join(home, '.codex/skills/testing'))
  const store = createSetupStore({ home, dir: path.join(home, 'catalog') })
  const scan = await store.scan(['codex', 'cursor'])
  assert.equal(scan.items.length, 3)
  assert.deepEqual(scan.items.find((i) => i.name === 'docs').sources, ['codex', 'cursor'])
  assert.ok(!JSON.stringify(scan).includes('do-not-serialize-me'))
  assert.ok(scan.items.find((i) => i.name === 'private').issues.length)
  const preview = await store.review(scan.token, scan.items.filter((i) => i.name !== 'private').map((i) => i.id))
  const selected = preview.items.find((i) => i.kind === 'skill')
  assert.equal((await store.file(preview.token, selected.id, 'SKILL.md')).content, '# Test skill\nUse this safe text.')
  await put('.agents/skills/testing/SKILL.md', 'changed after review')
  await assert.rejects(store.save(preview.token, 'My tools', false), /acknowledge/)
  const saved = await store.save(preview.token, 'My tools', true)
  assert.equal((await store.get(saved.id)).items.find((i) => i.kind === 'skill').files[0].content, '# Test skill\nUse this safe text.')
  assert.equal((await fs.stat(path.join(home, 'catalog', saved.id + '.json'))).mode & 0o777, 0o600)
  await assert.rejects(store.save(preview.token, 'Again', true), /expired/)
  assert.ok(!JSON.stringify(await store.list()).includes('Use this safe text.'))
  const raw = await store.get(saved.id); raw.items[0].name = 'tampered'
  await put('catalog/' + saved.id + '.json', JSON.stringify(raw))
  await assert.rejects(store.get(saved.id), /integrity/)
})
test('discovery rejects arbitrary sources, selection IDs and expired tokens', async (t) => {
  const { home, put } = await fixture(t); let now = 1
  await put('.cursor/mcp.json', '{"mcpServers":{"a":{"url":"https://example.com/mcp"}}}')
  const store = createSetupStore({ home, dir: path.join(home, 'catalog'), now: () => now })
  await assert.rejects(store.scan(['../../elsewhere']), /Select/)
  const scan = await store.scan(['cursor'])
  await assert.rejects(store.review(scan.token, ['arbitrary']), /Unknown/)
  now += 16 * 60_000
  await assert.rejects(store.review(scan.token, [scan.items[0].id]), /expired/)
})
test('skills block secret files, symlinks, oversized files and changed roots', async (t) => {
  const { home, put } = await fixture(t)
  const file = await put('skill/SKILL.md', '# Safe'); const root = path.dirname(file)
  await put('skill/secret.txt', 'token = abcdefghijklmnopqrstuvwxyz123456')
  await assert.rejects(readSkill(root, home), /credentials/)
  await fs.unlink(path.join(root, 'secret.txt'))
  await fs.symlink('/etc/passwd', path.join(root, 'escape.txt'))
  await assert.rejects(readSkill(root, home), /link/)
  await fs.unlink(path.join(root, 'escape.txt'))
  await put('skill/large.txt', 'a'.repeat(513 * 1024))
  await assert.rejects(readSkill(root, home), /512 KB/)
  await fs.rm(root, { recursive: true }); await fs.symlink('/tmp', root)
  await assert.rejects(readSkill(root, home), /location changed/)
})
test('unsafe MCP launchers and URL credentials never become portable configurations', () => {
  for (const raw of [{command:'npx',args:['-y','package']},{command:'/Users/me/tool'},{command:'tool',args:['--token=privatevalue']},{url:'https://example.com/mcp?token=secret'},{url:'http://localhost:8000'},{url:'https://me:secret@example.com'}]) {
    const item = normalizeMcp('test', raw, 'codex'); assert.equal(item.config, null); assert.ok(item.issues.length)
  }
  assert.deepEqual(normalizeMcp('test', {command:'safe-mcp',args:['--readonly']}, 'codex').config, {command:'safe-mcp',args:['--readonly']})
})
test('network preflight requires exact program/port and respects restrictions', () => {
  const requirement = {host:'api.example.com',port:443}
  const rule = (endpoint = {}, binaries = ['/usr/bin/claude']) => ({networkPolicies:{test:{binaries:binaries.map(path=>({path})),endpoints:[{host:'api.example.com',port:443, ...endpoint}]}}})
  assert.equal(assessNetwork(requirement, {}, ['/usr/bin/claude']).status, 'missing')
  assert.equal(assessNetwork(requirement, rule(), []).status, 'missing')
  assert.equal(assessNetwork(requirement, rule(), ['/usr/bin/claude']).status, 'allowed')
  assert.equal(assessNetwork(requirement, rule(), ['/usr/bin/codex']).status, 'review')
  assert.equal(assessNetwork(requirement, rule({port:8443}), ['/usr/bin/claude']).status, 'missing')
  assert.equal(assessNetwork(requirement, rule(), ['/usr/bin/claude'], ['*.example.com']).status, 'blocked')
  for (const e of [{path:'/only'}, {denyRules:[{}]}, {allowedIps:['1.2.3.4']}, {tls:1}, {protocol:'mcp'}, {protocol:'rest',access:1,enforcement:1}]) assert.equal(assessNetwork(requirement, rule(e), ['/usr/bin/claude']).status, 'review')
})

async function installerFixture(t) {
  const f = await fixture(t)
  for (const exe of ['claude','codex','cursor-agent']) { const p = await f.put('bin/' + exe, '#!/bin/sh\nexit 99\n'); await fs.chmod(p, 0o700) }
  const setup = {id:'1234567890abcdef12345678',revision:'fixed',items:[{id:'abcdef1234',kind:'mcp',config:{url:'https://example.com/mcp'}},{id:'skill12345',name:'testing',kind:'skill',files:[{path:'SKILL.md',content:'# Test',executable:false},{path:'scripts/run.sh',content:'#!/bin/sh\nexit 99',executable:true}]}]}
  const run = (operation, targets=['codex','claude','cursor']) => {
    const result = spawnSync('python3', [path.join(import.meta.dirname,'setup-installer.py')], {input:JSON.stringify({operation,setup,targets}),encoding:'utf8',env:{...process.env,OPENSHELL_SETUP_HOME:f.home,PATH:path.join(f.home,'bin')+path.delimiter+process.env.PATH}})
    assert.ok(result.stdout, result.stderr); return {code:result.status, ...JSON.parse(result.stdout)}
  }
  return {...f,setup,run}
}
test('installer preserves configs, is idempotent, verifies executable files and removes only owned entries', async (t) => {
  const {home,put,run} = await installerFixture(t)
  const toml = '# Keep comment\nmodel = "existing"\n'; await put('.codex/config.toml',toml)
  await put('.claude.json',JSON.stringify({theme:'dark',mcpServers:{existing:{command:'keep-me'}}}))
  const beforeProbe = await fs.readdir(home)
  assert.equal(run('probe').installed,false)
  assert.deepEqual(await fs.readdir(home),beforeProbe)
  const first = run('apply'); assert.equal(first.code,0,first.error); assert.equal(first.connectivityVerified,false)
  assert.equal(run('apply').code,0)
  assert.equal((await fs.stat(path.join(home,'.agents/skills/os-12345678-testing/scripts/run.sh'))).mode & 0o777,0o700)
  assert.equal(JSON.parse(await fs.readFile(path.join(home,'.claude.json'))).mcpServers.existing.command,'keep-me')
  assert.deepEqual(run('probe',['codex']).targets,['codex','claude','cursor'])
  assert.equal(run('apply',['codex']).code,1)
  const removed = run('remove'); assert.equal(removed.code,0,removed.error)
  assert.equal(await fs.readFile(path.join(home,'.codex/config.toml'),'utf8'),toml)
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(home,'.claude.json'))),{theme:'dark',mcpServers:{existing:{command:'keep-me'}}})
  assert.equal(run('probe').installed,false)
})
test('installer detects drift and does not partially remove or overwrite', async (t) => {
  const {home,put,run} = await installerFixture(t)
  assert.equal(run('apply').code,0)
  await put('.agents/skills/os-12345678-testing/SKILL.md','user changed this')
  const config = await fs.readFile(path.join(home,'.codex/config.toml'),'utf8')
  assert.match(run('remove').error,/modified/)
  assert.match(run('apply').error,/modified/)
  assert.equal(await fs.readFile(path.join(home,'.codex/config.toml'),'utf8'),config)
  assert.equal(await fs.readFile(path.join(home,'.agents/skills/os-12345678-testing/SKILL.md'),'utf8'),'user changed this')
})
test('installer refuses symlink destinations and malformed existing configuration', async (t) => {
  const {home,put,run} = await installerFixture(t)
  await fs.symlink('/tmp',path.join(home,'.codex'))
  assert.match(run('apply').error,/symlink/)
  await fs.unlink(path.join(home,'.codex'))
  await put('.claude.json','broken-private-content')
  const result = run('apply'); assert.equal(result.code,1); assert.ok(!result.error.includes('broken-private-content'))
  await assert.rejects(fs.stat(path.join(home,'.codex/config.toml')), {code:'ENOENT'})
})

test('bulk review and save accepts all discovered MCPs and Skills beyond 25 items', async (t) => {
  const { home, put } = await fixture(t)
  await put('.cursor/mcp.json', JSON.stringify({ mcpServers: Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`server-${i}`, { url: `https://server-${i}.example.com/mcp` }])) }))
  for (let i = 0; i < 30; i++) await put(`.cursor/skills/skill-${i}/SKILL.md`, `# Skill ${i}\nSafe fixture.`)
  const store = createSetupStore({ home, dir: path.join(home, 'catalog') })
  const scan = await store.scan(['cursor'])
  assert.equal(scan.items.length, 60)
  const ids = scan.items.map((item) => item.id)
  await assert.rejects(store.review(scan.token, [ids[0], ids[0]]), /unique/)
  const reviewed = await store.review(scan.token, ids)
  assert.equal(reviewed.items.filter((item) => item.kind === 'mcp').length, 30)
  assert.equal(reviewed.items.filter((item) => item.kind === 'skill').length, 30)
  assert.ok(reviewed.items.every((item) => !item.issues.length))
  const saved = await store.save(reviewed.token, 'Bulk fixture', true)
  assert.equal((await store.get(saved.id)).items.length, 60)
})

test('bulk review retains the bundle-size limit', async (t) => {
  const { home, put } = await fixture(t)
  for (let i = 0; i < 5; i++) {
    await put(`.cursor/skills/large-${i}/SKILL.md`, '# Safe fixture')
    for (let j = 0; j < 6; j++) await put(`.cursor/skills/large-${i}/file-${j}.txt`, 'a'.repeat(300 * 1024))
  }
  const store = createSetupStore({ home, dir: path.join(home, 'catalog') })
  const scan = await store.scan(['cursor'])
  await assert.rejects(store.review(scan.token, scan.items.map((item) => item.id)), /exceeds 8 MB/)
})

test('deleting setup rows persists a new revision and rejects stale edits', async (t) => {
  const { home, put } = await fixture(t)
  const source = JSON.stringify({ mcpServers: { a: { url: 'https://a.example.com/mcp' }, b: { url: 'https://b.example.com/mcp' } } })
  await put('.cursor/mcp.json', source)
  const dir = path.join(home, 'catalog')
  const store = createSetupStore({ home, dir })
  const scan = await store.scan(['cursor'])
  const preview = await store.review(scan.token, scan.items.map((item) => item.id))
  const saved = await store.save(preview.token, 'My setup', true)
  await assert.rejects(store.deleteItem(saved.id, 'unknown', saved.revision), /not found/)
  const [first, second] = await Promise.allSettled(saved.items.map((item) => store.deleteItem(saved.id, item.id, saved.revision)))
  assert.equal(first.status, 'fulfilled')
  assert.equal(second.status, 'rejected')
  assert.match(second.reason.message, /changed/)
  const updated = first.value
  assert.notEqual(updated.revision, saved.revision)
  assert.deepEqual(updated.items, [saved.items[1]])
  assert.deepEqual((await createSetupStore({ home, dir }).get(saved.id)).items.map((item) => item.id), [saved.items[1].id])
  const empty = await store.deleteItem(saved.id, saved.items[1].id, updated.revision)
  assert.deepEqual(empty.items, [])
  assert.deepEqual((await store.list())[0].items, [])
  assert.equal(await fs.readFile(path.join(home, '.cursor/mcp.json'), 'utf8'), source)
  assert.equal((await fs.stat(path.join(dir, saved.id + '.json'))).mode & 0o777, 0o600)
  await assert.rejects(store.deleteItem('../escape', saved.items[0].id, saved.revision), /not found/)
})

test('deleting an entire setup persists and preserves other setups and source files', async (t) => {
  const { home, put } = await fixture(t)
  const source = '{"mcpServers":{"a":{"url":"https://example.com/mcp"}}}'
  await put('.cursor/mcp.json', source)
  const dir = path.join(home, 'catalog')
  const store = createSetupStore({ home, dir })
  const scan = await store.scan(['cursor'])
  const save = async (name) => {
    const preview = await store.review(scan.token, scan.items.map((item) => item.id))
    return store.save(preview.token, name, true)
  }
  const first = await save('My setup'), second = await save('Codex MCPs')
  await assert.rejects(store.delete(first.id, 'stale'), /changed/)
  assert.equal((await store.list()).length, 2)
  assert.deepEqual(await store.delete(first.id, first.revision), { deleted: first.id })
  assert.deepEqual((await createSetupStore({ home, dir }).list()).map((setup) => setup.id), [second.id])
  await assert.rejects(store.get(first.id), /not found/)
  await assert.rejects(store.delete(first.id, first.revision), /not found/)
  await assert.rejects(store.delete('../escape', second.revision), /not found/)
  await store.delete(second.id, second.revision)
  assert.deepEqual(await store.list(), [])
  assert.equal(await fs.readFile(path.join(home, '.cursor/mcp.json'), 'utf8'), source)
})

test('module reload refreshes store methods instead of reusing the legacy singleton', async () => {
  const legacyKey = Symbol.for('openshell.console.setup-store.v1')
  const previous = globalThis[legacyKey]
  globalThis[legacyKey] = { list: async () => [] }
  try {
    const first = await import('./setups.js?reload-test=first')
    const second = await import('./setups.js?reload-test=second')
    assert.notEqual(first.setupStore, second.setupStore)
    assert.equal(typeof second.setupStore.delete, 'function')
    assert.equal(typeof second.setupStore.deleteItem, 'function')
    await assert.rejects(second.setupRoute('POST', ['setups', 'invalid', 'delete'], { revision: 'test' }), /Setup not found/)
    await assert.rejects(second.setupRoute('POST', ['setups', 'invalid', 'delete-item'], { item: 'test', revision: 'test' }), /Setup not found/)
  } finally {
    if (previous === undefined) delete globalThis[legacyKey]
    else globalThis[legacyKey] = previous
  }
})
