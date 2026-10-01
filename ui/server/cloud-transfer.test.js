import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import fs from 'node:fs/promises'
import { transferPathAllowed, validateTransfer, localTransfer, importTransfer, CLOUD_TRANSFER_LIMIT } from './cloud-transfer.js'

const launch = { name: 'my-work', image: 'ubuntu:24.04', session: 'shell' }
const bundle = (files = [{ path: 'src/main.js', data: Buffer.from('hello').toString('base64'), executable: false }]) => ({ version: 1, launch, files })
const request = (value) => Readable.from([JSON.stringify(value)])

test('workspace transfer excludes secrets, dependency trees, caches and invalid paths', () => {
  for (const value of ['.env', '.env.local', 'app/.env.production', '.git/config', 'node_modules/x.js', '.ssh/id_rsa', 'keys/private.pem', 'credentials.json', '.npmrc', '.claude.json', '.git-credentials', '.bash_history', '.pytest_cache/results', '.aws/config', '__pycache__/x', '../escape', '/absolute', 'a/../b', 'a\\b', 'a\0b']) assert.equal(transferPathAllowed(value), false, value)
  for (const value of ['.env.example', 'src/.env.sample', '.env.template', 'app/main.js', 'README.md']) assert.equal(transferPathAllowed(value), true, value)
})

test('bundle validation rejects traversal, duplicate paths, noncanonical base64, keys and limits', () => {
  assert.equal(validateTransfer(bundle()).bytes, 5)
  for (const file of [{ path: '../escape', data: '' }, { path: '.env', data: '' }, { path: 'ok', data: '%%%' }, { path: 'ok', data: Buffer.from('-----BEGIN PRIVATE KEY-----').toString('base64') }]) assert.throws(() => validateTransfer(bundle([file])))
  assert.throws(() => validateTransfer(bundle([bundle().files[0], bundle().files[0]])), /Duplicate/)
  assert.throws(() => validateTransfer(bundle([{ path: 'huge', data: Buffer.alloc(CLOUD_TRANSFER_LIMIT + 1).toString('base64') }])), /25 MiB/)
  assert.throws(() => validateTransfer({ ...bundle(), launch: { ...launch, providers: ['secret'] } }), /launch/)
})

function localClient() {
  return {
    raw: { getSandbox: async () => ({ sandbox: { metadata: { name: 'my-work' }, spec: { template: { image: 'ubuntu:24.04' }, command: ['/bin/sleep', 'infinity'] }, status: { phase: 2 } } }) },
    sandbox: {
      async *execStream(name, argv) {
        const output = argv[2].includes('find ') ? Buffer.from('/sandbox/src/main.js\0/sandbox/.env\0/sandbox/node_modules/a.js\0') : Buffer.from('src/main.js\0' + Buffer.from('hello').toString('base64') + '\0false\0')
        yield { stream: 'stdout', data: output }
        yield { type: 'exit', exitCode: 0 }
      },
    },
  }
}

test('local export sends sanitized data only to the fixed cloud endpoint with one-use ticket', async () => {
  let sent
  const result = await localTransfer({ name: 'my-work', ticket: ('openrod-user-' + 'a'.repeat(24) + '.' + 'b'.repeat(64)) }, { connect: async () => ({ client: localClient() }), fetch: async (url, options) => { sent = { url, ...options }; return Response.json({ name: 'my-work' }) } })
  assert.equal(sent.url, 'https://cloud.example.com/api/cloud/import')
  assert.equal(sent.headers.authorization, 'Bearer ' + ('openrod-user-' + 'a'.repeat(24) + '.' + 'b'.repeat(64)))
  assert.deepEqual(JSON.parse(sent.body).files.map((f) => f.path), ['src/main.js'])
  assert.equal(result.name, 'my-work')
})

test('invalid transfer and cloud rejection do not create or upload a sandbox', async () => {
  let created = false
  await assert.rejects(importTransfer(request(bundle([{ path: '../evil', data: '' }])), { createSandbox: async () => { created = true } }), /path/)
  assert.equal(created, false)
  await assert.rejects(localTransfer({ name: 'my-work', ticket: ('openrod-user-' + 'a'.repeat(24) + '.' + 'b'.repeat(64)) }, { connect: async () => ({ client: localClient() }), fetch: async () => Response.json({ error: 'Ticket expired' }, { status: 401 }) }), /Ticket expired/)
})

test('import stages regular files with safe permissions and uploads to a new sandbox', async () => {
  let uploaded = false, staged
  const result = await importTransfer(request(bundle()), {
    createSandbox: async (spec) => { assert.deepEqual(spec, { ...launch, name: spec.name }); return { name: 'my-work' } },
    waitReady: async () => {},
    upload: async (name, root) => { staged = root; assert.equal(name, 'my-work'); assert.equal(await fs.readFile(root + '/src/main.js', 'utf8'), 'hello'); assert.equal((await fs.stat(root + '/src/main.js')).mode & 0o777, 0o644); uploaded = true },
  })
  assert.equal(uploaded, true)
  assert.equal(result.files, 1)
  assert.equal(result.name, 'my-work')
  await assert.rejects(fs.stat(staged), { code: 'ENOENT' })
})

test('managed templates rebuild on the worker architecture without template environment', async () => {
  const { newRecipe } = await import('../src/lib/image-templates.js')
  const recipe = newRecipe({ name: 'my-template', agents: [], command: '', environment: [] })
  let rebuilt = false
  const result = await importTransfer(request({ ...bundle(), recipe }), {
    rebuild: async (received) => { assert.deepEqual(received.environment, []); rebuilt = true; return 'cloud-template' },
    createSandbox: async (spec) => { assert.equal(spec.imageTemplate, 'cloud-template'); assert.equal(spec.image, undefined); return { name: 'my-work' } },
    waitReady: async () => {}, upload: async () => {},
  })
  assert.equal(rebuilt, true)
  assert.equal(result.name, 'my-work')
  assert.throws(() => validateTransfer({ ...bundle(), recipe: { ...recipe, environment: [{ name: 'SAFE', value: 'not-transferred' }] } }), /environment/)
})

test('local built template sends a rebuild recipe and drops stored environment', async () => {
  const { newRecipe, RECIPE_ANNOTATION } = await import('../src/lib/image-templates.js')
  const client = localClient()
  const record = await client.raw.getSandbox()
  record.sandbox.createdFromWorkloadTemplate = { name: 'local-template' }
  record.sandbox.spec.template.image = 'openshell-template/local-template:arm64'
  client.raw.getSandbox = async () => record
  client.sandboxTemplates = { get: async () => ({ metadata: { name: 'local-template', annotations: { [RECIPE_ANNOTATION]: JSON.stringify(newRecipe({ name: 'local-template', command: 'claude' })) } }, spec: { workload: { image: 'openshell-template/local-template:arm64', environment: { REGION: 'local' } } } }) }
  let payload
  await localTransfer({ name: 'my-work', ticket: ('openrod-user-' + 'a'.repeat(24) + '.' + 'b'.repeat(64)) }, { connect: async () => ({ client }), fetch: async (url, options) => { payload = JSON.parse(options.body); return Response.json({ name: 'my-work' }) } })
  assert.equal(payload.recipe.source, 'build')
  assert.equal(payload.recipe.command, 'claude')
  assert.deepEqual(payload.recipe.environment, [])
  assert.equal(payload.launch.image, 'ubuntu:24.04')
})

test('local-only image without recipe falls back to portable shell with an explicit warning', async () => {
  const client = localClient()
  const record = await client.raw.getSandbox()
  record.sandbox.spec.template.image = 'my-local-arm-image:latest'
  client.raw.getSandbox = async () => record
  let payload
  const result = await localTransfer({ name: 'my-work', ticket: ('openrod-user-' + 'a'.repeat(24) + '.' + 'b'.repeat(64)) }, { connect: async () => ({ client }), fetch: async (url, options) => { payload = JSON.parse(options.body); return Response.json({ name: 'my-work' }) } })
  assert.equal(payload.launch.image, 'ubuntu:24.04')
  assert.equal(payload.launch.session, 'shell')
  assert.match(result.warning, /Rebuild/)
})

test('encoded body limits reject oversized input before creating a sandbox', async () => {
  const { CLOUD_TRANSFER_BODY_LIMIT } = await import('./cloud-transfer.js')
  let created = false
  await assert.rejects(importTransfer(Readable.from([Buffer.alloc(CLOUD_TRANSFER_BODY_LIMIT + 1)]), { createSandbox: async () => { created = true } }), /too large/)
  assert.equal(created, false)
})

test('file-directory conflicts are rejected before staging', () => {
  assert.throws(() => validateTransfer(bundle([{ path: 'src', data: '' }, { path: 'src/main.js', data: '' }])), /Conflicting/)
})

test('real workspace export shell excludes symlinks and credentials and preserves binary executable files', async () => {
  const os = await import('node:os')
  const path = await import('node:path')
  const { execFileSync } = await import('node:child_process')
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'openrod-export-test-')))
  try {
    await fs.mkdir(root + '/node_modules')
    await fs.writeFile(root + '/node_modules/ignored.js', 'not exported')
    await fs.writeFile(root + '/.env', 'token=not exported')
    await fs.writeFile(root + '/.env.example', 'TOKEN=replace-me')
    await fs.writeFile(root + '/run', Buffer.from([0, 255, 1, 10]), { mode: 0o755 })
    await fs.symlink(root + '/.env', root + '/leak')
    const client = localClient()
    client.sandbox.execStream = async function* (name, argv) {
      const script = argv[2].replaceAll('/sandbox', root)
      let data = execFileSync('/bin/sh', ['-c', script], { maxBuffer: 1024 * 1024 })
      if (script.includes('find ')) data = Buffer.from(data.toString().replaceAll(root, '/sandbox'))
      yield { stream: 'stdout', data }
      yield { type: 'exit', exitCode: 0 }
    }
    let payload
    await localTransfer({ name: 'my-work', ticket: ('openrod-user-' + 'a'.repeat(24) + '.' + 'b'.repeat(64)) }, { connect: async () => ({ client }), fetch: async (url, options) => { payload = JSON.parse(options.body); return Response.json({ name: 'my-work' }) } })
    assert.deepEqual(payload.files.map((file) => file.path).sort(), ['.env.example', 'run'])
    const run = payload.files.find((file) => file.path === 'run')
    assert.deepEqual(Buffer.from(run.data, 'base64'), Buffer.from([0, 255, 1, 10]))
    assert.equal(run.executable, true)
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test('deleted local template falls back to a portable workspace transfer', async () => {
  const client = localClient()
  const record = await client.raw.getSandbox()
  record.sandbox.createdFromWorkloadTemplate = { name: 'deleted' }
  client.raw.getSandbox = async () => record
  client.sandboxTemplates = { get: async () => { throw Object.assign(new Error('missing'), { code: 'not_found' }) } }
  let payload
  const result = await localTransfer({ name: 'my-work', ticket: ('openrod-user-' + 'a'.repeat(24) + '.' + 'b'.repeat(64)) }, { connect: async () => ({ client }), fetch: async (url, options) => { payload = JSON.parse(options.body); return Response.json({ name: 'my-work' }) } })
  assert.equal(payload.launch.image, 'ubuntu:24.04')
  assert.match(result.warning, /Reinstall/)
})

test('rebuilt template keeps the source shell session even when the recipe starts Codex', async () => {
  const { newRecipe } = await import('../src/lib/image-templates.js')
  const recipe = newRecipe({ name: 'codex-template', agents: ['codex'], command: 'codex' })
  await importTransfer(request({ ...bundle(), recipe }), {
    rebuild: async () => 'cloud-template',
    createSandbox: async (spec) => { assert.equal(spec.imageTemplate, 'cloud-template'); assert.equal(spec.session, 'shell'); return { name: 'my-work' } },
    waitReady: async () => {}, upload: async () => {},
  })
})

test('sanitized export can be requested independently of the cloud import ticket', async () => {
  const { exportTransfer } = await import('./cloud-transfer.js')
  const exported = await exportTransfer({ name: 'my-work' }, { connect: async () => ({ client: localClient() }) })
  assert.equal(exported.bundle.version, 1)
  assert.equal(exported.bundle.launch.name, 'my-work')
  assert.deepEqual(exported.bundle.files.map((file) => file.path), ['src/main.js'])
  assert.equal(exported.bundle.ticket, undefined)
  await assert.rejects(exportTransfer({ name: '../evil' }), /Invalid/)
})

test('imports create a distinct name so returning to the original local sandbox does not overwrite it', async () => {
  let createdName
  const result = await importTransfer(request(bundle()), {
    createSandbox: async (spec) => { createdName = spec.name; return { name: spec.name } },
    waitReady: async () => {}, upload: async () => {},
  })
  assert.notEqual(createdName, launch.name)
  assert.match(createdName, /^my-work-[a-f0-9]{8}$/)
  assert.ok(createdName.length <= 19)
  assert.equal(result.name, createdName)
})
