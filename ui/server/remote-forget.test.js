import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { tokenCookie } from './launch-token.js'

const TOKEN = 'test-launch-token-' + 'x'.repeat(32)

test('forgetting a disconnected SSH location removes it from the snapshot and from disk', { timeout: 15000 }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'console-forget-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const state = path.join(root, 'state')
  const file = path.join(state, 'remote-gateways', 'last-location.json')
  await fs.mkdir(path.dirname(file), { recursive: true })
  const remote = { host: 'aws-ec2', gateway: 'console-ssh-0123456789abcdef01234567', workspace: 'default', status: 'disconnected', error: null }
  await fs.writeFile(file, JSON.stringify({ returnContext: null, remote }))
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs/promises'
    import { createRemoteConnections } from ${JSON.stringify(new URL('./remote-gateway.js', import.meta.url).href)}
    const connections = createRemoteConnections({ logger: { warn() {} } })
    const before = (await connections.locationSnapshot()).remote
    await connections.forget()
    const after = (await connections.locationSnapshot()).remote
    console.log(JSON.stringify({ before, after, saved: JSON.parse(await fs.readFile(${JSON.stringify(file)}, 'utf8')) }))
    await connections.close()
  `], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: { ...process.env, XDG_CONFIG_HOME: path.join(root, 'config'), OPENSHELL_GATEWAY: '', OPENSHELL_WORKSPACE: '', OPENSHELL_CONSOLE_DATA_DIR: state },
    timeout: 10000,
  })
  const result = JSON.parse(stdout)
  assert.equal(result.before.host, 'aws-ec2')
  assert.equal(result.after, null)
  assert.equal(result.saved.remote, null)
})

test('forget hides SSH config hosts and selected gateway registrations across reloads; restore is reversible', { timeout: 15000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'console-forget-registration-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const config = path.join(root, 'config')
  const gateway = 'console-ssh-0123456789abcdef01234567'
  const registration = path.join(config, 'openshell', 'gateways', gateway)
  await fs.mkdir(registration, { recursive: true })
  await fs.writeFile(path.join(registration, 'console-managed.json'), JSON.stringify({ host: 'gcp-test' }))
  await fs.writeFile(path.join(config, 'openshell', 'active_gateway'), gateway)
  await fs.writeFile(path.join(config, 'openshell', 'console-context.json'), JSON.stringify({ gateway, workspace: 'default' }))
  await fs.mkdir(path.join(root, '.ssh'))
  const sshConfig = path.join(root, '.ssh', 'config')
  await fs.writeFile(sshConfig, 'Host gcp-test\n  HostName example.invalid\nHost aws-ec2\n  HostName other.invalid\n')
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', `
    import { createRemoteConnections } from ${JSON.stringify(new URL('./remote-gateway.js', import.meta.url).href)}
    const options = { logger: { warn() {} } }
    const first = createRemoteConnections(options)
    const before = await first.overview()
    await first.forget()
    const forgotten = await first.overview()
    await first.close()
    const reloaded = createRemoteConnections(options)
    const afterReload = await reloaded.overview()
    await reloaded.restoreHost('gcp-test')
    const restored = await reloaded.overview()
    await reloaded.close()
    console.log(JSON.stringify({ before, forgotten, afterReload, restored }))
  `], { env: { ...process.env, HOME: root, XDG_CONFIG_HOME: config, OPENSHELL_GATEWAY: '', OPENSHELL_WORKSPACE: '', OPENSHELL_CONSOLE_DATA_DIR: path.join(root, 'state') }, timeout: 10000 })
  const result = JSON.parse(stdout)
  assert.equal(result.before.active.host, 'gcp-test')
  for (const snapshot of [result.forgotten, result.afterReload]) {
    assert.equal(snapshot.active, null)
    assert.ok(!snapshot.hosts.some(host => host.name === 'gcp-test'))
    assert.ok(snapshot.hosts.some(host => host.name === 'aws-ec2'))
    assert.deepEqual(snapshot.forgottenHosts, ['gcp-test'])
  }
  assert.ok(result.restored.hosts.some(host => host.name === 'gcp-test'))
  assert.deepEqual(result.restored.forgottenHosts, [])
  assert.match(await fs.readFile(sshConfig, 'utf8'), /Host gcp-test/)
})

const GATEWAY = 'console-ssh-0123456789abcdef01234567'
const BLOB = Buffer.from('test-host-key').toString('base64')

// The CLI's selected gateway is OpenRod's registration for gcp-test, which a
// console retains as the remembered remote. PATH holds only a fake ssh-keyscan,
// so a connection attempt stops before reaching any machine.
async function forgetFixture(t, sshConfig = 'Host gcp-test\n  HostName example.invalid\nHost aws-ec2\n  HostName other.invalid\n') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'console-unforget-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const config = path.join(root, 'config')
  const registration = path.join(config, 'openshell', 'gateways', GATEWAY)
  await fs.mkdir(registration, { recursive: true })
  await fs.writeFile(path.join(registration, 'console-managed.json'), JSON.stringify({ host: 'gcp-test' }))
  await fs.writeFile(path.join(config, 'openshell', 'active_gateway'), GATEWAY)
  await fs.mkdir(path.join(root, '.ssh'))
  await fs.writeFile(path.join(root, '.ssh', 'config'), sshConfig)
  const bin = path.join(root, 'bin')
  await fs.mkdir(bin)
  await fs.writeFile(path.join(bin, 'ssh-keyscan'), `#!${process.execPath}\nconsole.log('example.invalid ssh-ed25519 ${BLOB}')\n`, { mode: 0o700 })
  const state = path.join(root, 'state')
  const env = { ...process.env, HOME: root, PATH: bin, XDG_CONFIG_HOME: config, OPENSHELL_GATEWAY: '', OPENSHELL_WORKSPACE: '', OPENSHELL_CONSOLE_DATA_DIR: state, OPENSHELL_CONSOLE_SWEEP: '', OPENSHELL_BIN: path.join(root, 'missing-openshell') }
  const run = async code => JSON.parse((await promisify(execFile)(process.execPath, ['--input-type=module', '-e', `
    import { createRemoteConnections } from ${JSON.stringify(new URL('./remote-gateway.js', import.meta.url).href)}
    const open = () => createRemoteConnections({ logger: { warn() {} } })
    ${code}
  `], { env, timeout: 10000 })).stdout)
  return { root, env, run, saved: async () => JSON.parse(await fs.readFile(path.join(state, 'remote-gateways', 'last-location.json'), 'utf8')) }
}

test('forget alone keeps the dropped remote and its host hidden after a restart', { timeout: 15000 }, async t => {
  const { run, saved } = await forgetFixture(t)
  const result = await run(`
    const first = open()
    const before = await first.overview()
    await first.forget()
    await first.unforgetHost('aws-ec2')
    await first.close()
    const second = open()
    const after = { snapshot: await second.locationSnapshot(), overview: await second.overview() }
    await second.close()
    console.log(JSON.stringify({ before, after }))
  `)
  assert.equal(result.before.active.host, 'gcp-test')
  assert.equal(result.after.snapshot.remote, null)
  assert.equal(result.after.overview.active, null)
  assert.deepEqual(result.after.overview.hosts.map(host => host.name), ['aws-ec2'])
  assert.deepEqual(result.after.overview.forgottenHosts, ['gcp-test'])
  assert.deepEqual((await saved()).forgottenHosts, ['gcp-test'])
})

test('connecting to a forgotten host undoes Forget, so it is listed and retained after a restart', { timeout: 15000 }, async t => {
  const { run, saved } = await forgetFixture(t)
  const result = await run(`
    const first = open()
    await first.forget()
    const { id } = first.begin({ host: 'gcp-test' })
    let job = first.job(id)
    for (let attempt = 0; attempt < 500 && job.status === 'working'; attempt++) { await new Promise(resolve => setTimeout(resolve, 10)); job = first.job(id) }
    const during = await first.overview()
    await first.close()
    const second = open()
    const after = await second.overview()
    await second.close()
    console.log(JSON.stringify({ job, during, after }))
  `)
  // Without ssh on PATH the attempt fails right after it starts.
  assert.equal(result.job.status, 'failed')
  assert.match(result.job.error, /OpenSSH/)
  for (const overview of [result.during, result.after]) {
    assert.ok(overview.hosts.some(host => host.name === 'gcp-test'))
    assert.deepEqual(overview.forgottenHosts, [])
  }
  assert.equal(result.after.active.host, 'gcp-test')
  assert.equal(result.after.active.status, 'disconnected')
  assert.deepEqual((await saved()).forgottenHosts, [])
})

test('adding a forgotten host again or deleting it undoes Forget, and a deleted host does not come back', { timeout: 20000 }, async t => {
  const { root, env, saved } = await forgetFixture(t, 'Host gcp-test\n  HostName example.invalid\n')
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { createServer } from 'node:http'
    import { createOpenShellApi } from ${JSON.stringify(new URL('./api.js', import.meta.url).href)}
    const server = createServer((request, response) => api.middleware(request, response))
    const api = createOpenShellApi({ httpServer: server, token: ${JSON.stringify(TOKEN)} })
    server.listen(0, '127.0.0.1', () => console.log('READY http://127.0.0.1:' + server.address().port))
    process.on('SIGTERM', async () => {
      await api.close()
      server.close(() => process.exit(0))
      server.closeAllConnections()
    })
  `], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  const stopped = new Promise(resolve => child.once('close', resolve))
  t.after(async () => {
    child.kill('SIGTERM')
    const deadline = setTimeout(() => child.kill('SIGKILL'), 3000)
    await stopped
    clearTimeout(deadline)
  })
  let stderr = ''
  child.stderr.on('data', chunk => { stderr += chunk })
  const origin = await new Promise((resolve, reject) => {
    let output = ''
    child.once('error', reject)
    child.once('exit', code => reject(new Error(`Console exited ${code}: ${stderr}`)))
    child.stdout.on('data', chunk => {
      output += chunk
      const match = /READY (http:\/\/127\.0\.0\.1:\d+)/.exec(output)
      if (match) resolve(match[1])
    })
  })
  const cookie = tokenCookie(new URL(origin).port, TOKEN)
  const overview = async () => (await fetch(`${origin}/api/os/connections`, { headers: { cookie } })).json()
  const post = async (route, body = {}) => {
    const response = await fetch(`${origin}/api/os/connections/${route}`, { method: 'POST', headers: { origin, cookie, 'content-type': 'application/json', 'x-openshell-console': '1' }, body: JSON.stringify(body) })
    const value = await response.json()
    assert.ok(response.ok, `${route}: ${value.error}`)
    return value
  }
  const add = async () => post('hosts', { token: (await post('hosts/scan', { name: 'GCP Test', hostname: 'example.invalid' })).token })

  assert.equal((await overview()).active.host, 'gcp-test')
  await post('forget')
  assert.deepEqual((await overview()).forgottenHosts, ['gcp-test'])
  // The user drops the host from ~/.ssh/config by hand, then adds it in OpenRod.
  await fs.writeFile(path.join(root, '.ssh', 'config'), '')
  assert.equal((await add()).alias, 'gcp-test')
  let current = await overview()
  assert.ok(current.hosts.some(host => host.name === 'gcp-test' && host.managed))
  assert.deepEqual(current.forgottenHosts, [])
  assert.equal(current.active.host, 'gcp-test')

  // Delete in Connections forgets the remembered remote, then removes the host.
  await post('forget')
  await post('hosts/remove', { alias: 'gcp-test' })
  current = await overview()
  assert.deepEqual(current.forgottenHosts, [])
  assert.equal(current.active, null)
  assert.ok(!current.hosts.some(host => host.name === 'gcp-test'))
  assert.deepEqual((await saved()).forgottenHosts, [])

  await add()
  current = await overview()
  assert.ok(current.hosts.some(host => host.name === 'gcp-test' && host.managed))
  assert.deepEqual(current.forgottenHosts, [])
})
