import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { SETUP_AGENTS, SETUP_TARGETS, setupTargetsFor, validateSetupTargets } from '../shared/setup-targets.js'
import { AGENTS } from '../src/lib/image-templates.js'
import { setupPython } from './setup-python.js'

const installer = setupPython('./setup-installer.py')
const probe = setupPython('./agent-resources.py')
test('non-login installer finds Antigravity in the image user bin and installs skills for both agents', async t => {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'setup-user-bin-')))
  t.after(() => fs.rm(home, { recursive: true, force: true }))
  const bin = path.join(home, '.local/bin')
  await fs.mkdir(bin, { recursive: true })
  for (const name of ['agy', 'opencode']) await fs.writeFile(path.join(bin, name), '#!/bin/sh\nexit 99\n', { mode: 0o700 })
  const setup = { id: '1234567890abcdef12345678', revision: 'test', items: [{ id: 'skill1234', kind: 'skill', name: 'review', files: [{ path: 'SKILL.md', content: '---\nname: review\ndescription: Review code\n---\n# Review' }] }] }
  const env = { ...process.env, HOME: home, OPENSHELL_SETUP_HOME: home }
  const run = operation => JSON.parse(spawnSync('python3', ['-c', installer], { env, input: JSON.stringify({ operation, setup, targets: ['antigravity', 'opencode'] }), encoding: 'utf8' }).stdout)
  assert.equal(run('probe').executables.agy, path.join(bin, 'agy'))
  assert.equal(run('apply').status, 'installed')
  for (const target of SETUP_TARGETS.filter(t => ['antigravity', 'opencode'].includes(t.id))) assert.match(await fs.readFile(path.join(home, target.skills, 'review/SKILL.md'), 'utf8'), /name: review/)
  await fs.chmod(path.join(bin, 'agy'), 0o600)
  assert.equal(run('probe').executables.agy, null)
})

test('every offered agent has an explicit setup capability and quick creation accepts all supported targets', () => {
  assert.deepEqual(new Set(SETUP_AGENTS.map(a => a.id)), new Set(AGENTS.map(a => a.id)))
  assert.equal(validateSetupTargets(SETUP_TARGETS.map(a => a.id)).length, 9)
  assert.deepEqual(setupTargetsFor(['pi','opencode','aider']), ['pi','opencode'])
  assert.throws(() => validateSetupTargets(['aider']), /Aider/)
  assert.throws(() => validateSetupTargets(['pi','pi']), /Choose/)
  assert.throws(() => validateSetupTargets(['unknown']), /Unknown/)
  assert.throws(() => validateSetupTargets([]), /Choose/)
})

test('Antigravity reapply migrates managed skills to the current runtime discovery root', async t => {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'setup-agy-migrate-')))
  t.after(() => fs.rm(home, { recursive: true, force: true }))
  await fs.mkdir(path.join(home, '.local/bin'), { recursive: true })
  await fs.writeFile(path.join(home, '.local/bin/agy'), '#!/bin/sh\nexit 99\n', { mode: 0o700 })
  const setup = { id: '1234567890abcdef12345678', revision: 'test', items: [{ id: 'skill1234', kind: 'skill', name: 'review', files: [{ path: 'SKILL.md', content: '---\nname: review\ndescription: Review code\n---\n# Review' }] }] }
  const env = { ...process.env, HOME: home, OPENSHELL_SETUP_HOME: home }
  const run = script => JSON.parse(spawnSync('python3', ['-c', script], { env, input: JSON.stringify({ operation: 'apply', setup, targets: ['antigravity'] }), encoding: 'utf8' }).stdout)
  assert.equal(run(installer.replaceAll('.gemini/config/skills', '.gemini/antigravity-cli/skills')).status, 'installed')
  assert.equal(run(installer).status, 'installed')
  assert.match(await fs.readFile(path.join(home, '.gemini/config/skills/review/SKILL.md'), 'utf8'), /name: review/)
  await assert.rejects(fs.stat(path.join(home, '.gemini/antigravity-cli/skills/review/SKILL.md')), { code: 'ENOENT' })
})

for (const adapter of SETUP_TARGETS) test(`${adapter.name}: install, inventory, idempotence, collision and removal`, async t => {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'setup-adapter-')))
  t.after(() => fs.rm(home, {recursive:true, force:true}))
  const put = async (file, text) => { const name=path.join(home,file); await fs.mkdir(path.dirname(name), {recursive:true}); await fs.writeFile(name,text); return name }
  const executable = await put('bin/'+adapter.command, '#!/bin/sh\nexit 99\n')
  await fs.chmod(executable,0o700)
  const env = {...process.env, HOME:home, OPENSHELL_SETUP_HOME:home, PATH:path.join(home,'bin')+path.delimiter+process.env.PATH}
  const setup = {id:'1234567890abcdef12345678',revision:'test',items:[
    {id:'local1234',kind:'mcp',name:'local-tool',config:{command:'node',args:['server.js'],env:{MODE:'safe'}}},
    {id:'remote123',kind:'mcp',name:'remote-tool',config:{url:'https://example.com/mcp',headers:{'X-Test':'safe'}}},
    {id:'skill1234',kind:'skill',name:'review',files:[{path:'SKILL.md',content:'---\nname: review\ndescription: Review code\n---\n# Review'},{path:'scripts/check.sh',content:'#!/bin/sh\nexit 99',executable:true}]}
  ]}
  const configPath = adapter.alternateConfig || adapter.config
  const initial = adapter.format==='codex' ? '# Keep\nmodel="existing"\n[mcp_servers."local-tool"]\nurl="https://existing.example.com"\n' : JSON.stringify({theme:'existing',[adapter.key]:{'local-tool':{url:'https://existing.example.com'}}})
  await put(configPath, adapter.format==='opencode' ? '// A config comment\n'+initial.replace('"theme":"existing"','"theme":"existing // literal ,} /* retained */"') : initial)
  const run = operation => {
    const result=spawnSync('python3',['-c',installer],{env,input:JSON.stringify({operation,setup,targets:[adapter.id]}),encoding:'utf8'})
    assert.ok(result.stdout,result.stderr)
    return {code:result.status,...JSON.parse(result.stdout)}
  }
  assert.equal(run('probe').installed,false)
  const first=run('apply');assert.equal(first.code,0,first.error)
  const names=run('probe').mcpNames[adapter.id]
  assert.equal(names.local1234,'local-tool-12345678-local123')
  assert.equal(names.remote123,'remote-tool')
  if(adapter.format!=='codex') {
    const config=JSON.parse(await fs.readFile(path.join(home,configPath),'utf8'))
    assert.equal(config.theme, adapter.format==='opencode'?'existing // literal ,} /* retained */':'existing')
    assert.equal(config[adapter.key]['local-tool'].url,'https://existing.example.com')
    const local=config[adapter.key][names.local1234], remote=config[adapter.key][names.remote123]
    assert.deepEqual(local.command,adapter.format==='opencode'?['node','server.js']:'node')
    assert.equal((local.environment || local.env).MODE,'safe')
    assert.equal(remote[adapter.format==='antigravity'?'serverUrl':'url'],'https://example.com/mcp')
    assert.equal(remote.headers['X-Test'],'safe')
    if(['claude','droid','copilot'].includes(adapter.format)) assert.equal(remote.type,'http')
    if(adapter.format==='copilot') { assert.equal(local.type,'local');assert.deepEqual(local.tools,['*']) }
    if(adapter.format==='opencode') { assert.equal(local.type,'local');assert.equal(remote.type,'remote') }
  }
  assert.equal((await fs.stat(path.join(home,adapter.skills,'review/scripts/check.sh'))).mode & 0o777,0o700)
  const inventory = spawnSync('python3',['-c',probe],{env,encoding:'utf8'})
  assert.equal(inventory.status,0,inventory.stderr)
  const resourceLine=inventory.stdout.split('\n').find(line => line.startsWith('openshell-agent-resources:'))
  assert.ok(resourceLine, 'Resource inventory was reported')
  const resources=JSON.parse(resourceLine.slice('openshell-agent-resources:'.length))[adapter.name]
  assert.ok(resources.mcps.items.some(i => i.name==='remote-tool'))
  assert.ok(resources.skills.items.some(i => i.name==='review'))
  assert.equal(run('apply').code,0)
  // A user's real MCP change must still prevent overwriting or removal.
  const installed=await fs.readFile(path.join(home,configPath),'utf8')
  await put(configPath,installed.replace('https://example.com/mcp','https://changed.example.com/mcp'))
  assert.equal(run('remove').code,1)
  await put(configPath,installed)
  assert.equal(run('remove').code,0)
  await assert.rejects(fs.stat(path.join(home,adapter.skills,'review/SKILL.md')),{code:'ENOENT'})
  assert.match(await fs.readFile(path.join(home,configPath),'utf8'),/existing.example.com/)
})

test('OpenCode JSONC parser preserves quoted comment/comma text and supports trailing commas', () => {
  const source=setupPython('./agent-resources.py').split('"""Read only')[0]
  const text='{"url":"https://example.com/a//b",/*comment*/"value":",}","list":[1,2,],}'
  const result=spawnSync('python3',['-c',source+'\nimport sys;print(json.dumps(parse_agent_json(sys.stdin.read())))'],{input:text,encoding:'utf8'})
  assert.equal(result.status,0,result.stderr)
  assert.deepEqual(JSON.parse(result.stdout),{url:'https://example.com/a//b',value:',}',list:[1,2]})
})

test('Copilot network checks resolve the native platform executable rather than its Node loader', async t => {
  const home=await fs.mkdtemp(path.join(os.tmpdir(),'copilot-launcher-'))
  t.after(()=>fs.rm(home,{recursive:true,force:true}))
  const loader=path.join(home,'@github/copilot/npm-loader.js')
  await fs.mkdir(path.dirname(loader),{recursive:true})
  await fs.writeFile(loader,'#!/usr/bin/env node\n')
  const source=installer.slice(0,installer.lastIndexOf('\ntry:\n    request = json.load(sys.stdin)'))
  const command=source+'\nprint(network_executable(sys.argv[1]))'
  assert.equal(spawnSync('python3',['-c',command,loader],{encoding:'utf8'}).stdout.trim(),'None')
  for(const platform of ['linux','linuxmusl']) for(const arch of ['arm64','x64']) {
    const native=path.join(home,`@github/copilot/node_modules/@github/copilot-${platform}-${arch}/copilot`)
    await fs.mkdir(path.dirname(native),{recursive:true});await fs.writeFile(native,Buffer.from([0x7f,0x45,0x4c,0x46]))
  }
  const result=spawnSync('python3',['-c',command,loader],{encoding:'utf8'})
  assert.equal(result.status,0,result.stderr)
  assert.match(result.stdout,/copilot-(linux|linuxmusl)-(arm64|x64)\/copilot/)
})

test('Kiro network checks resolve the chat executable launched by the CLI', async t => {
  const home=await fs.mkdtemp(path.join(os.tmpdir(),'kiro-launcher-'))
  t.after(()=>fs.rm(home,{recursive:true,force:true}))
  const cli=path.join(home,'kiro-cli'), chat=path.join(home,'kiro-cli-chat')
  await fs.writeFile(cli,Buffer.from([0x7f,0x45,0x4c,0x46]))
  await fs.writeFile(chat,Buffer.from([0x7f,0x45,0x4c,0x46]))
  const source=installer.slice(0,installer.lastIndexOf('\ntry:\n    request = json.load(sys.stdin)'))
  const result=spawnSync('python3',['-c',source+'\nprint(network_executable(sys.argv[1]))',cli],{encoding:'utf8'})
  assert.equal(result.status,0,result.stderr)
  assert.equal(result.stdout.trim(),await fs.realpath(chat))
})
