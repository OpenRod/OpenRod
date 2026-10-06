import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

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
