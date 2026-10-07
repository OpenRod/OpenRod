import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { buildPackage, createPackagePreparation } from './setup-packages.js'
import { checkConnection, CONNECT_FAILED } from './setup-preparation.js'

const plan = { ecosystem: 'npm', name: 'example-mcp', requested: 'latest', args: ['serve'], registry: 'registry.npmjs.org' }
const fetcher = async () => new Response(JSON.stringify({ name: 'example-mcp', version: '1.2.3', bin: { 'example-mcp': 'server.js' }, dist: { integrity: 'sha512-' + 'A'.repeat(86) + '==' } }))
function builder(status = 'connected', runtime = { node: '22.22.0', arch: 'arm64', platform: 'linux', libc: 'glibc' }) {
  const calls = { create: 0, delete: 0, install: 0, probe: 0, images: [], boxes: [], installs: [], checks: [] }
  const client = {
    raw: { getSandbox: async ({ name }) => ({ sandbox: { metadata: { name }, status: { phase: 2 } } }), getSandboxConfig: async () => ({ policySource: 1 }) },
    sandbox: {
      create: async spec => { calls.create++; calls.images.push(spec.image); calls.boxes.push(spec) },
      delete: async () => { calls.delete++ },
      exec: async (name, command, options) => {
        if (command[2].includes('package-lock-only')) { calls.install++; calls.installs.push({name,package:JSON.parse(options.stdin)}); return { exitCode: 0, stdout: Buffer.from(JSON.stringify({ bin: 'node_modules/example-mcp/server.js', bytes: 10, ...runtime })) } }
        if (command[2].includes('process.arch')) { calls.probe++; return { exitCode: 0, stdout: Buffer.from(JSON.stringify(runtime)) } }
        if(options.timeoutSecs===35)calls.checks.push(name)
        return options.timeoutSecs === 15 ? { exitCode: 0 } : { exitCode: 0, stdout: Buffer.from(JSON.stringify({ status, ...(status === 'connected' ? { toolCount: 1 } : {}) })) }
      },
      execStream: async function* () { yield { stream: 'stdout', data: Buffer.from('tarball-' + calls.create) }; yield { type: 'exit', exitCode: 0 } },
    },
  }
  return { calls, connect: async () => ({ client }) }
}
const build = async (dir, connect, progress = async () => {}) => buildPackage(plan, { dir, connect, fetcher, settle: 0, progress })
const temp = () => fs.mkdtemp(path.join(os.tmpdir(), 'setup-artifacts-'))
const indexFiles = async dir => (await fs.readdir(path.join(dir, 'index')).catch(() => [])).filter(f => f.endsWith('.json'))

test('one job shares downloads but executes each MCP in a separate offline sandbox', async () => {
  const dir=await temp(), fixture=builder()
  const session=createPackagePreparation({dir,connect:fixture.connect,fetcher,settle:0})
  try {
    await session.build(plan)
    await session.build({...plan,args:['different']})
    const downloads=fixture.calls.boxes.filter(box=>box.labels['openshell.console/setup-builder'])
    const checks=fixture.calls.boxes.filter(box=>box.labels['openshell.console/setup-check'])
    assert.equal(downloads.length,1)
    assert.equal(checks.length,2)
    assert.deepEqual(fixture.calls.installs.map(call=>call.name),[downloads[0].name,downloads[0].name])
    assert.notEqual(fixture.calls.installs[0].package.root,fixture.calls.installs[1].package.root)
    assert.deepEqual(fixture.calls.checks,checks.map(box=>box.name))
    for(const box of checks){assert.deepEqual(box.policy.networkPolicies,{});assert.deepEqual(box.providers,[])}
    assert.equal(fixture.calls.delete,2)
    // A cache hit inside the job creates neither a downloader nor a checker.
    await session.build(plan)
    assert.equal(fixture.calls.create,3)
  } finally {await session.close();await fs.rm(dir,{recursive:true,force:true})}
  assert.equal(fixture.calls.delete,3)
})

test('verified cache plus reliable runtime metadata needs no sandbox', async () => {
  const dir=await temp()
  try {
    const artifact=await build(dir,builder().connect), fixture=builder()
    const cached=await buildPackage(plan,{dir,connect:fixture.connect,fetcher,settle:0,readRuntime:async()=>({node:artifact.node,arch:artifact.arch,platform:artifact.platform,libc:artifact.libc})})
    assert.equal(cached.digest,artifact.digest)
    assert.equal(fixture.calls.create,0)
    assert.equal(fixture.calls.install,0)
  } finally {await fs.rm(dir,{recursive:true,force:true})}
})

test('cancellation after a download closes the shared sandbox without running another MCP', async () => {
  const dir=await temp(),fixture=builder(),controller=new AbortController()
  const session=createPackagePreparation({dir,connect:fixture.connect,fetcher,settle:0,signal:controller.signal})
  try {
    await session.build(plan)
    controller.abort(new Error('Cancelled by user'))
    await assert.rejects(session.build({...plan,args:['other']}),/Cancelled by user/)
    assert.equal(fixture.calls.create,2)
    assert.equal(fixture.calls.delete,2)
  } finally {await session.close();await fs.rm(dir,{recursive:true,force:true})}
})

test('a verified package skips npm only after proving the current builder runtime', async () => {
  const dir = await temp()
  try {
    const first = builder()
    const artifact = await build(dir, first.connect)
    assert.equal(first.calls.create, 2)
    assert.equal((await indexFiles(dir)).length, 1)
    assert.equal((await fs.stat(path.join(dir, 'index', (await indexFiles(dir))[0]))).mode & 0o777, 0o600)
    const messages = []
    const second = builder()
    const cached = await build(dir, second.connect, async m => { messages.push(m) })
    assert.equal(second.calls.create, 1)
    assert.equal(second.calls.probe, 1)
    assert.equal(second.calls.install, 0)
    assert.equal(second.calls.delete, 1)
    assert.match(first.calls.images[0], /^node:22-bookworm-slim@sha256:[a-f0-9]{64}$/)
    assert.equal(cached.digest, artifact.digest)
    assert.equal(cached.bin, 'node_modules/example-mcp/server.js')
    assert.deepEqual(cached.args, ['serve'])
    assert.ok(messages.includes('Using the package prepared earlier'))
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
})

test('a corrupted tarball or index falls back to a fresh build', async () => {
  const dir = await temp()
  try {
    const artifact = await build(dir, builder().connect)
    await fs.writeFile(path.join(dir, artifact.digest + '.tar.gz'), 'tampered')
    const second = builder()
    await build(dir, second.connect)
    assert.equal(second.calls.create, 2)
    const [index] = await indexFiles(dir)
    await fs.writeFile(path.join(dir, 'index', index), '{"digest":"not-a-digest"')
    const third = builder()
    await build(dir, third.connect)
    assert.equal(third.calls.create, 2)
    assert.ok((await build(dir, builder().connect)).digest)
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
})

test('packages whose MCP check did not connect are not cached', async () => {
  const dir = await temp()
  try {
    const first = builder('unverified')
    assert.equal((await build(dir, first.connect)).verification.status, 'unverified')
    assert.deepEqual(await indexFiles(dir), [])
    const second = builder('unverified')
    await build(dir, second.connect)
    assert.equal(second.calls.create, 2)
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
})


test('switching builder architectures rebuilds instead of reusing an incompatible package', async () => {
  const dir = await temp()
  try {
    const arm = builder()
    const first = await build(dir, arm.connect)
    assert.equal(first.arch, 'arm64')
    const x64 = builder('connected', { node: '22.22.0', arch: 'x64', platform: 'linux', libc: 'glibc' })
    const second = await build(dir, x64.connect)
    assert.equal(second.arch, 'x64')
    assert.equal(x64.calls.install, 1)
    assert.equal(x64.calls.delete, 2)
    assert.equal((await indexFiles(dir)).length, 2)
    const retry = builder('connected', { node: '22.22.0', arch: 'x64', platform: 'linux', libc: 'glibc' })
    assert.equal((await build(dir, retry.connect)).arch, 'x64')
    assert.equal(retry.calls.install, 0)
    assert.equal(retry.calls.delete, 1)
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
})

test('a failed runtime probe cannot return a cached artifact and cleans up its builder', async () => {
  const dir = await temp()
  try {
    await build(dir, builder().connect)
    const broken = builder('connected', {})
    await assert.rejects(build(dir, broken.connect), /builder runtime/i)
    assert.equal(broken.calls.install, 0)
    assert.equal(broken.calls.delete, 1)
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
})

test('cache reuse still rejects gateway global policy and deletes its temporary builder', async () => {
  const dir = await temp()
  try {
    await build(dir, builder().connect)
    const overridden = builder()
    const connect = async () => { const value = await overridden.connect(); value.client.raw.getSandboxConfig = async () => ({ policySource: 2 }); return value }
    await assert.rejects(build(dir, connect), /global policy overrides/)
    assert.equal(overridden.calls.install, 0)
    assert.equal(overridden.calls.delete, 1)
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
})

test('cancelling during the runtime probe cannot return a cached package', async () => {
  const dir = await temp()
  try {
    await build(dir, builder().connect)
    const controller = new AbortController(), current = builder()
    const connect = async () => {
      const value = await current.connect(), exec = value.client.sandbox.exec
      value.client.sandbox.exec = async (...args) => {
        const result = await exec(...args)
        if (args[1][2].includes('process.arch')) controller.abort(new Error('Review cancelled'))
        return result
      }
      return value
    }
    await assert.rejects(buildPackage(plan, { dir, connect, fetcher, settle: 0, signal: controller.signal }), /Review cancelled/)
    assert.equal(current.calls.install, 0)
    assert.equal(current.calls.delete, 1)
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
})

test('explicit agent OAuth skips the check sandbox and new connection failures remain retryable', async () => {
  const item = { id: 'linear', name: 'linear', config: { url: 'https://mcp.example.com/mcp' }, requirements: [], issues: ['Connection check did not pass. Review the account and runtime destinations, then retry.'] }
  let checks = 0, discoveries = 0
  const check = async () => { checks++; return { status: 'needs-sign-in', reason: 'The MCP requires sign-in or additional account permissions.' } }
  const steps = []
  const signedIn = await checkConnection({ ...item, auth: { mode: 'agent-session' } }, undefined, async m => { steps.push(m) }, { check, discover: async i => { discoveries++; return { ...i, auth: { mode: 'agent-session', status: 'sign-in-required', discovery: 'metadata-found' } } } })
  assert.equal(checks, 0)
  assert.equal(discoveries, 1)
  assert.equal(signedIn.verification.status, 'needs-sign-in')
  assert.deepEqual(signedIn.issues, [])
  assert.deepEqual(steps, ['Looking up sign-in details'])
  const checked = await checkConnection(item, undefined, async () => {}, { check, discover: async i => { discoveries++; return { ...i, auth: { mode: 'agent-session', status: 'sign-in-required', discovery: 'destinations-proposed' } } } })
  assert.equal(checks, 1)
  assert.equal(discoveries, 2)
  assert.equal(checked.verification.status, 'needs-sign-in')
  assert.equal(checked.auth.mode, 'agent-session')
  const failed = await checkConnection({ ...item, issues: [] }, undefined, async () => {}, { check: async () => ({ status: 'unverified' }), discover: async i => ({ ...i, auth: { discovery: 'destinations-proposed' } }) })
  assert.deepEqual(failed.issues, [CONNECT_FAILED])
  // A retry that fails the same way is a preparation issue, so it keeps the review open instead of saving.
  assert.deepEqual(failed.preparationIssues, [CONNECT_FAILED])
  const again = await checkConnection(failed, undefined, async () => {}, { check: async () => ({ status: 'unverified' }), discover: async i => ({ ...i, auth: { discovery: 'destinations-proposed' } }) })
  assert.deepEqual([again.issues, again.preparationIssues], [[CONNECT_FAILED], [CONNECT_FAILED]])
})
