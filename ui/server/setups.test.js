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
test('removing MCPs and Skills from a review preserves prepared items and saves only the remaining selection', async (t) => {
  const { home, put } = await fixture(t)
  await put('.cursor/mcp.json', JSON.stringify({ mcpServers: { working: { url: 'https://example.com/mcp' }, broken: { command: '/missing/server' } } }))
  await put('.agents/skills/testing/SKILL.md', '# Test skill')
  const store = createSetupStore({ home, dir: path.join(home, 'catalog') })
  const scan = await store.scan(['cursor', 'codex'])
  const review = await store.review(scan.token, scan.items.map(item => item.id))
  const working = review.items.find(item => item.name === 'working')
  const broken = review.items.find(item => item.name === 'broken')
  const skill = review.items.find(item => item.kind === 'skill')
  const items = store.preview(review.token).items.map(item => item.id === working.id ? { ...item, verification: { status: 'connected' }, artifact: { digest: 'prepared-artifact' } } : item)
  const prepared = store.stage(items, { [working.id]: { retained: 'private-value' }, [broken.id]: { removed: 'private-value' } })
  assert.throws(() => store.removeReviewItem(prepared.token, 'unknown'), /not found/)
  const withoutMcp = store.removeReviewItem(prepared.token, broken.id)
  assert.throws(() => store.preview(prepared.token), /expired/)
  assert.deepEqual(Object.keys(store.preview(withoutMcp.token).credentials), [working.id])
  assert.ok(!JSON.stringify(withoutMcp).includes('private-value'))
  const withoutSkill = store.removeReviewItem(withoutMcp.token, skill.id)
  const saved = await store.save(withoutSkill.token, 'Remaining tools', true)
  const raw = await store.get(saved.id)
  assert.deepEqual(raw.items.map(item => item.id), [working.id])
  assert.equal(raw.items[0].verification.status, 'connected')
  assert.equal(raw.items[0].artifact.digest, 'prepared-artifact')
  const last = store.stage(items.slice(0, 1))
  assert.deepEqual(store.removeReviewItem(last.token, items[0].id).items, [])
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
  assert.equal((await fs.stat(path.join(home,'.agents/skills/testing/scripts/run.sh'))).mode & 0o777,0o700)
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
  await put('.agents/skills/testing/SKILL.md','user changed this')
  const config = await fs.readFile(path.join(home,'.codex/config.toml'),'utf8')
  assert.match(run('remove').error,/modified/)
  assert.match(run('apply').error,/modified/)
  assert.equal(await fs.readFile(path.join(home,'.codex/config.toml'),'utf8'),config)
  assert.equal(await fs.readFile(path.join(home,'.agents/skills/testing/SKILL.md'),'utf8'),'user changed this')
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

test('automatic preparation preserves source snapshots and reuses the first pinned build', async t => {
  const {home}=await fixture(t)
  const store=createSetupStore({dir:path.join(home,'store')})
  const item={id:'mcp',kind:'mcp',issues:['Prepare package dependencies in the next step.'],package:{name:'shadcn'},requirements:[]}
  const source=await store.save(store.stage([item]).token,'My tools',true)
  const pinned={...item,issues:[],artifact:{digest:'a'.repeat(64)},config:{command:'node',args:[]}}
  const results=await Promise.all([store.buildSnapshot(source,[pinned]),store.buildSnapshot(source,[{...pinned,artifact:{digest:'b'.repeat(64)}}])])
  assert.equal(results[0].id,results[1].id)
  assert.equal(results[0].revision,results[1].revision)
  assert.notEqual(results[0].id,source.id)
  assert.equal((await store.get(source.id)).revision,source.revision)
  await store.deleteItem(source.id,'mcp',source.revision)
  await assert.rejects(store.buildSnapshot(source,[pinned]),/changed/)
})

test('ZIP skills survive review, save, install for every agent, and removal byte-for-byte', async (t) => {
  const { zipSync, strToU8 } = await import('fflate')
  const { home, put, setup, run } = await installerFixture(t)
  const zip = Buffer.from(zipSync({ 'resources/run.sh': strToU8('#!/bin/sh\nexit 99'), '__MACOSX/._run.sh': new Uint8Array([0, 5, 1]) }))
  await put('.codex/skills/bundled/SKILL.md', '# Bundled skill')
  await put('.codex/skills/bundled/Archive.zip', zip)
  const store = createSetupStore({ home, dir: path.join(home, 'catalog') })
  const scan = await store.scan(['codex'])
  const review = await store.review(scan.token, scan.items.map(i => i.id))
  const skill = review.items[0]
  assert.deepEqual(skill.issues, [])
  assert.equal(skill.files.find(f => f.path === 'Archive.zip').bytes, zip.length)
  const preview = await store.file(review.token, skill.id, 'Archive.zip')
  assert.match(preview.content, /resources\/run.sh/)
  assert.match(preview.content, /not extracted/)
  const saved = await store.save(review.token, 'ZIP setup', true)
  const pinned = (await store.get(saved.id)).items[0]
  assert.deepEqual(Buffer.from(pinned.files.find(f => f.path === 'Archive.zip').content, 'base64'), zip)
  setup.items = [pinned]
  assert.equal(run('apply').code, 0)
  for (const dir of ['.agents', '.claude', '.cursor']) {
    const file = path.join(home, dir, 'skills/bundled/Archive.zip')
    assert.deepEqual(await fs.readFile(file), zip)
    assert.equal((await fs.stat(file)).mode & 0o111, 0)
    await assert.rejects(fs.stat(path.join(path.dirname(file), 'resources/run.sh')), { code: 'ENOENT' })
  }
  assert.equal(run('apply').code, 0)
  await put('.agents/skills/bundled/Archive.zip', 'modified')
  assert.match(run('remove').error, /modified/)
  await put('.agents/skills/bundled/Archive.zip', zip)
  assert.equal(run('remove').code, 0)
  await assert.rejects(fs.stat(path.join(home, '.agents/skills/bundled/Archive.zip')), { code: 'ENOENT' })
})

test('ZIP review rejects traversal, credentials, nested archives, corrupt data and expansion limits', async (t) => {
  const { zipSync, strToU8 } = await import('fflate')
  const { home, put } = await fixture(t)
  const root = path.dirname(await put('skill/SKILL.md', '# Safe'))
  for (const [name, contents, expected] of [
    ['../escape.sh', 'exit 0', /unsafe/],
    ['/absolute.md', '# No', /unsafe/],
    ['secret.txt', 'token = abcdefghijklmnopqrstuvwxyz123456', /credentials/],
    ['nested.zip', 'not text', /unsupported/],
    ['large.txt', 'a'.repeat(513 * 1024), /expanded limit/],
  ]) {
    await put('skill/archive.zip', zipSync({ [name]: strToU8(contents) }))
    await assert.rejects(readSkill(root, home), expected)
  }
  await put('skill/archive.zip', 'not a zip')
  await assert.rejects(readSkill(root, home), /could not be read/)
  await put('skill/archive.zip', zipSync(Object.fromEntries(Array.from({length: 201}, (_, i) => [`${i}.md`, strToU8('safe')]))))
  await assert.rejects(readSkill(root, home), /200 entry/)
})

test('MCP names are readable, collision-safe and stable across all agents', async (t) => {
  const { home, put, setup, run } = await installerFixture(t)
  setup.items = [{id:'first1234',name:'shadcn',kind:'mcp',config:{url:'https://example.com/first'}},{id:'second123',name:'shadcn',kind:'mcp',config:{url:'https://example.com/second'}},{id:'third1234',name:'magicui',kind:'mcp',config:{url:'https://example.com/third'}}]
  await put('.codex/config.toml', '[mcp_servers.shadcn]\nurl="https://existing.example.com"\n')
  assert.equal(run('apply').code, 0)
  const probe = run('probe')
  assert.equal(probe.mcpNames.codex.first1234, 'shadcn-12345678-first123')
  assert.equal(probe.mcpNames.claude.first1234, 'shadcn')
  assert.equal(probe.mcpNames.cursor.second123, 'shadcn-12345678-second12')
  assert.equal(probe.mcpNames.codex.third1234, 'magicui')
  assert.equal(run('apply').code, 0)
  assert.deepEqual(run('probe').mcpNames, probe.mcpNames)
  assert.equal(run('remove').code, 0)
  assert.match(await fs.readFile(path.join(home,'.codex/config.toml'),'utf8'), /existing.example.com/)
})

test('reapplying a legacy setup migrates generated MCP IDs and retains managed removal', async (t) => {
  const { home, setup, run } = await installerFixture(t)
  setup.items[0].name = 'magicui'
  assert.equal(run('apply').code, 0)
  const manifestPath = path.join(home,'.openshell/installed-setups',setup.id+'.json')
  const manifest = JSON.parse(await fs.readFile(manifestPath))
  const legacy = 'os-12345678-abcdef12'
  for (const config of manifest.configs) {
    delete config.names
    if (config.target === 'codex') {
      const filename = path.join(home,'.codex/config.toml')
      config.block = config.block.replace('"magicui"', JSON.stringify(legacy))
      await fs.writeFile(filename, (await fs.readFile(filename,'utf8')).replace('"magicui"', JSON.stringify(legacy)))
    } else {
      const filename = path.join(home, config.target === 'claude' ? '.claude.json' : '.cursor/mcp.json')
      const doc = JSON.parse(await fs.readFile(filename))
      doc.mcpServers[legacy] = doc.mcpServers.magicui; delete doc.mcpServers.magicui
      config.values[legacy] = config.values.magicui; delete config.values.magicui
      await fs.writeFile(filename, JSON.stringify(doc))
    }
  }
  await fs.writeFile(manifestPath, JSON.stringify(manifest))
  assert.equal(run('apply').code, 0)
  for (const target of ['codex','claude','cursor']) assert.equal(run('probe').mcpNames[target].abcdef1234,'magicui')
  assert.ok(!(await fs.readFile(path.join(home,'.codex/config.toml'),'utf8')).includes(legacy))
  assert.equal(run('remove').code, 0)
})

test('MCP reapply preserves Codex preferences inserted inside the managed block', async (t) => {
  const { home, setup, run } = await installerFixture(t)
  setup.items[0].name = 'shadcn'
  assert.equal(run('apply').code, 0)
  const file = path.join(home,'.codex/config.toml')
  const text = await fs.readFile(file,'utf8')
  await fs.writeFile(file, text.replace(':end\n', ':end\n').replace('# openshell-setup:' + setup.id + ':end', '[tui]\nscreen_reader_detection_done = true\n[projects."/sandbox"]\ntrust_level = "trusted"\n# openshell-setup:' + setup.id + ':end'))
  assert.equal(run('apply').code, 0)
  assert.match(await fs.readFile(file,'utf8'), /screen_reader_detection_done = true/)
  assert.equal(run('remove').code, 0)
  assert.match(await fs.readFile(file,'utf8'), /trust_level = "trusted"/)
})

test('skill names stay readable and preserve colliding user folders for every agent', async (t) => {
  const { home, put, setup, run } = await installerFixture(t)
  await put('.agents/skills/testing/SKILL.md', '# Existing user skill')
  const applied = run('apply'); assert.equal(applied.code, 0, applied.error)
  assert.equal(await fs.readFile(path.join(home,'.agents/skills/testing/SKILL.md'),'utf8'), '# Existing user skill')
  assert.equal(await fs.readFile(path.join(home,'.agents/skills/testing-12345678-skill123/SKILL.md'),'utf8'), '# Test')
  for (const agent of ['.claude','.cursor']) assert.equal(await fs.readFile(path.join(home,agent,'skills/testing/SKILL.md'),'utf8'), '# Test')
  assert.equal(run('apply').code, 0)
  assert.equal(run('remove').code, 0)
  assert.equal(await fs.readFile(path.join(home,'.agents/skills/testing/SKILL.md'),'utf8'), '# Existing user skill')
})

test('legacy skill paths migrate without losing files and refuse modified originals', async (t) => {
  const { home, setup, run } = await installerFixture(t)
  assert.equal(run('apply').code, 0)
  const manifestPath = path.join(home,'.openshell/installed-setups',setup.id+'.json')
  const manifest = JSON.parse(await fs.readFile(manifestPath))
  delete manifest.skillNames
  for (const agent of ['.agents','.claude','.cursor']) await fs.rename(path.join(home,agent,'skills/testing'),path.join(home,agent,'skills/os-12345678-testing'))
  manifest.files = Object.fromEntries(Object.entries(manifest.files).map(([file,digest])=>[file.replace('/testing/','/os-12345678-testing/'),digest]))
  await fs.writeFile(manifestPath,JSON.stringify(manifest))
  const legacy = path.join(home,'.agents/skills/os-12345678-testing/SKILL.md')
  await fs.writeFile(legacy,'# Modified')
  assert.match(run('apply').error,/modified/)
  await assert.rejects(fs.stat(path.join(home,'.agents/skills/testing/SKILL.md')),{code:'ENOENT'})
  await fs.writeFile(legacy,'# Test')
  const applied = run('apply'); assert.equal(applied.code,0,applied.error)
  for (const agent of ['.agents','.claude','.cursor']) {
    assert.equal(await fs.readFile(path.join(home,agent,'skills/testing/SKILL.md'),'utf8'),'# Test')
    await assert.rejects(fs.stat(path.join(home,agent,'skills/os-12345678-testing/SKILL.md')),{code:'ENOENT'})
    assert.equal((await fs.stat(path.join(home,agent,'skills/testing/scripts/run.sh'))).mode & 0o777,0o700)
  }
  assert.equal(run('apply').code,0)
  assert.equal(run('remove').code,0)
})

test('imports a local npm executable as a pinned portable package without executing it', async (t) => {
  const { home, put } = await fixture(t)
  const directory = '.nvm/versions/node/v24/lib/node_modules/@magicuidesign/mcp'
  const executable = await put(`${directory}/dist/server.js`, 'throw new Error("must never execute")')
  await put(`${directory}/package.json`, JSON.stringify({ name: '@magicuidesign/mcp', version: '2.0.0', bin: { mcp: './dist/server.js' } }))
  await fs.mkdir(path.join(home, '.nvm/versions/node/v24/bin'), { recursive: true })
  const command = path.join(home, '.nvm/versions/node/v24/bin/mcp')
  await fs.symlink(executable, command)
  await put('.claude.json', JSON.stringify({ mcpServers: { magicui: { command, args: [] } } }))
  const store = createSetupStore({ home, dir: path.join(home, 'catalog') })
  const item = (await store.scan(['claude'])).items[0]
  assert.equal(item.package.name, '@magicuidesign/mcp')
  assert.equal(item.package.requested, '2.0.0')
  assert.deepEqual(item.issues, ['Prepare package dependencies in the next step.'])
  assert.ok(item.requirements.some(r => r.host === 'magicui.design'))
  await put(`${directory}/package.json`, JSON.stringify({ name: '@magicuidesign/mcp', version: '2.0.0', bin: { mcp: './other.js' } }))
  assert.equal((await store.scan(['claude'])).items[0].package, undefined)
})

test('does not translate arbitrary scripts or executable links outside the selected home', async (t) => {
  const { home, put } = await fixture(t)
  const { portableMcpConfig } = await import('./setup-discovery.js')
  const arbitrary = { command: await put('bin/mcp', '#!/bin/sh\nexit 1'), args: [] }
  assert.deepEqual(await portableMcpConfig(arbitrary, home), arbitrary)
  const external = path.join(home, 'bin/external')
  await fs.symlink('/usr/bin/true', external)
  const raw = { command: external, args: [] }
  assert.deepEqual(await portableMcpConfig(raw, home), raw)
})

test('reviewed revisions can add and remove MCPs while retaining drift and target protections', async (t) => {
  const { home, setup, run, put } = await installerFixture(t)
  setup.items[0].name = 'figma'
  assert.equal(run('apply').code, 0)
  setup.revision = 'second'
  setup.items.push({id:'magicui123', name:'magicui', kind:'mcp', config:{command:'node',args:['/sandbox/magicui.js']}})
  const updated = run('apply'); assert.equal(updated.code, 0, updated.error)
  assert.match(await fs.readFile(path.join(home,'.codex/config.toml'),'utf8'), /magicui/)
  setup.revision = 'third'
  setup.items = setup.items.filter(i => i.kind !== 'mcp')
  assert.equal(run('apply').code, 0)
  assert.doesNotMatch(await fs.readFile(path.join(home,'.codex/config.toml'),'utf8'), /magicui|figma/)
  assert.equal(run('apply',['codex']).code, 1)
  await put('.agents/skills/testing/SKILL.md','user edits')
  setup.revision = 'fourth'
  assert.match(run('apply').error, /modified/)
})

test('multiple sources merge MCP aliases and copied skills, preserving real differences', async (t) => {
  const {home,put} = await fixture(t)
  await put('.claude.json', JSON.stringify({mcpServers:{docs:{url:'https://docs.example.com/mcp',env:{B:'two',A:'one'}},account:{url:'https://account.example.com/mcp',headers:{Authorization:'Bearer account-one'}}}}))
  await put('.cursor/mcp.json', JSON.stringify({mcpServers:{documentation:{env:{A:'one',B:'two'},url:'https://docs.example.com/mcp'},account:{url:'https://account.example.com/mcp',headers:{Authorization:'Bearer account-two'}},other:{url:'https://other.example.com/mcp'}}}))
  for (const source of ['claude','cursor']) {
    await put(`.${source}/skills/shared/SKILL.md`,'# Shared')
    await put(`.${source}/skills/shared/scripts/run.js`,'console.log("same")')
    await put(`.${source}/skills/versioned/SKILL.md`,'# Same documentation')
    await put(`.${source}/skills/versioned/scripts/run.js`,source)
  }
  const store=createSetupStore({home,dir:path.join(home,'catalog')})
  const scan=await store.scan(['claude','cursor'])
  const mcps=scan.items.filter(i=>i.kind==='mcp')
  assert.equal(mcps.length,4)
  assert.deepEqual(mcps.find(i=>i.name==='docs').sources,['claude','cursor'])
  assert.equal(mcps.filter(i=>i.name==='account').length,2)
  assert.equal(scan.items.filter(i=>i.name==='shared').length,1)
  assert.deepEqual(scan.items.find(i=>i.name==='shared').sources,['claude','cursor'])
  assert.equal(scan.items.filter(i=>i.name==='versioned').length,2)
  assert.ok(!JSON.stringify(scan).includes('account-one'))
  const selected=scan.items.filter(i=>i.name==='shared'||i.name==='docs')
  const review=await store.review(scan.token,selected.map(i=>i.id))
  const saved=await store.save(review.token,'Unified',true)
  assert.equal(saved.items.length,2)
  assert.ok(saved.items.every(i=>i.sources.length===2))
})

test('MCP merging preserves package environment differences and merges identical credentials privately', async (t) => {
  const { home, put } = await fixture(t)
  const authenticated = {url:'https://docs.example.com/mcp',headers:{Authorization:'Bearer identical-value'}}
  await put('.claude.json',JSON.stringify({mcpServers:{docs:authenticated,magicui:{command:'npx',args:['-y','@magicuidesign/mcp@2.0.0'],env:{MODE:'one'}}}}))
  await put('.cursor/mcp.json',JSON.stringify({mcpServers:{docs:authenticated,magicui:{command:'npx',args:['-y','@magicuidesign/mcp@2.0.0'],env:{MODE:'two'}}}}))
  const store=createSetupStore({home,dir:path.join(home,'catalog')})
  const scan=await store.scan(['cursor','claude'])
  assert.equal(scan.items.length,3)
  assert.deepEqual(scan.items.find(i=>i.name==='docs').sources,['cursor','claude'])
  assert.equal(scan.items.filter(i=>i.name==='magicui').length,2)
  assert.ok(!JSON.stringify(scan).includes('identical-value'))
})

test('Cursor display names with spaces and scoped package names survive scan, review and save', async t => {
  const { home, put } = await fixture(t)
  const names = ['Datadog MCP', 'Playwright MCP', 'Jira MCP', '@magicuidesign/mcp', 'כלים (Dev)']
  await put('.cursor/mcp.json', JSON.stringify({mcpServers:Object.fromEntries(names.map((name,index)=>[name,{url:`https://example.com/mcp/${index}`}]))}))
  const store=createSetupStore({home,dir:path.join(home,'catalog')})
  const scan=await store.scan(['cursor'])
  assert.deepEqual(scan.items.map(item=>item.name),names)
  assert.ok(scan.items.every(item=>item.issues.length===0))
  const review=await store.review(scan.token,scan.items.map(item=>item.id))
  const saved=await store.save(review.token,'Cursor tools',true)
  assert.deepEqual((await store.get(saved.id)).items.map(item=>item.name),names)
  for (const name of ['', '   ', 'bad\nname', 'bad\u202ename', 'x'.repeat(201), 'sk-'+ 'a'.repeat(24)]) {
    const item=normalizeMcp(name,{url:'https://example.com/mcp'},'cursor')
    assert.equal(item.name,'Unrecognized item')
    assert.equal(item.config,null)
  }
})
