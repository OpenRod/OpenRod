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

// After a connection drops, the console still selects its gateway and the
// registration names the host, which once brought a forgotten location back.
test('forgetting a dropped SSH connection that is still selected does not leave a ghost', { timeout: 30000 }, async (t) => {
  const managed = 'console-ssh-0123456789abcdef01234567'
  const cases = [
    { name: 'with its saved history', history: true, local: false },
    { name: 'left behind by an earlier forget', history: false, local: false },
    { name: 'returns to the local gateway', history: true, local: true },
    // This test process stands in for a live console on the same data directory.
    { name: 'keeps a registration another console holds', history: true, local: false, locked: true },
  ]
  for (const scenario of cases) await t.test(scenario.name, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'console-forget-'))
    t.after(() => fs.rm(root, { recursive: true, force: true }))
    const config = path.join(root, 'config', 'openshell')
    const state = path.join(root, 'state')
    const gatewayState = path.join(state, 'remote-gateways', managed)
    const registration = path.join(config, 'gateways', managed)
    await fs.mkdir(gatewayState, { recursive: true })
    await fs.writeFile(path.join(gatewayState, 'connection.json'), JSON.stringify({ host: 'aws-ec2', engineId: 'engine', port: 20000 }))
    const register = async (name, metadata) => {
      const directory = path.join(config, 'gateways', name)
      await fs.mkdir(path.join(directory, 'mtls'), { recursive: true })
      await fs.writeFile(path.join(directory, 'metadata.json'), JSON.stringify({ auth_mode: 'mtls', ...metadata }))
      for (const file of ['ca.crt', 'tls.crt', 'tls.key']) await fs.writeFile(path.join(directory, 'mtls', file), 'test certificate')
    }
    await register(managed, { gateway_endpoint: 'https://127.0.0.1:20000', is_remote: true })
    await fs.writeFile(path.join(registration, 'console-managed.json'), JSON.stringify({ root: gatewayState, host: 'aws-ec2' }))
    if (scenario.local) await register('openshell', { gateway_endpoint: 'https://127.0.0.1:17670' })
    await fs.writeFile(path.join(config, 'console-context.json'), JSON.stringify({ gateway: managed, workspace: 'default' }))
    if (scenario.locked) await fs.writeFile(path.join(state, 'remote-gateways', 'process.lock'), JSON.stringify({ pid: process.pid }))
    if (scenario.history) {
      await fs.writeFile(path.join(state, 'remote-gateways', 'last-location.json'), JSON.stringify({
        returnContext: scenario.local ? { gateway: 'openshell', workspace: 'default' } : null,
        remote: { host: 'aws-ec2', gateway: managed, workspace: 'default', status: 'disconnected', error: null },
      }))
    }
    const run = script => promisify(execFile)(process.execPath, ['--input-type=module', '-e', `
      import fs from 'node:fs/promises'
      import { OpenShellClient } from '@nvidia/openshell-sdk'
      import { contextSelection } from ${JSON.stringify(new URL('./gateway.js', import.meta.url).href)}
      import { createRemoteConnections } from ${JSON.stringify(new URL('./remote-gateway.js', import.meta.url).href)}
      // Only the local gateway answers; the SSH tunnel is down.
      OpenShellClient.connect = async ({ gateway }) => {
        if (new URL(gateway).port !== '17670') throw Error('SSH tunnel is down')
        return { transport: { unary() {}, stream() {} }, raw: { listWorkspaces: async () => ({ workspaces: [{ metadata: { name: 'default' } }] }) } }
      }
      let deselected = false
      const connections = createRemoteConnections({ onDeselected: () => { deselected = true }, logger: { warn() {} } })
      ${script}
      await connections.close()
    `], {
      cwd: path.resolve(import.meta.dirname, '..'),
      env: { ...process.env, XDG_CONFIG_HOME: path.dirname(config), OPENSHELL_GATEWAY: '', OPENSHELL_WORKSPACE: '', OPENSHELL_CONSOLE_DATA_DIR: state },
      timeout: 10000,
    }).then(({ stdout }) => JSON.parse(stdout))

    const result = await run(`
      const before = (await connections.locationSnapshot()).remote
      await connections.forget()
      const after = await connections.locationSnapshot()
      console.log(JSON.stringify({ before, after, selected: contextSelection(), deselected,
        persisted: JSON.parse(await fs.readFile(${JSON.stringify(path.join(config, 'console-context.json'))}, 'utf8')) }))
    `)
    assert.equal(result.before.host, 'aws-ec2')
    assert.equal(result.before.status, 'disconnected')
    assert.equal(result.after.remote, null)
    assert.notEqual(result.selected.gateway, managed)
    if (scenario.local) {
      assert.deepEqual(result.persisted, { gateway: 'openshell', workspace: 'default' })
      assert.deepEqual(result.after.returnContext, { gateway: 'openshell', workspace: 'default' })
      assert.equal(result.deselected, false)
    } else {
      assert.deepEqual(result.persisted, {})
      assert.equal(result.deselected, true)
    }
    if (scenario.locked) await fs.access(path.join(registration, 'console-managed.json'))
    else await assert.rejects(fs.access(registration), { code: 'ENOENT' })
    // Reconnecting reuses this state for the sandboxes still on the host.
    await fs.access(path.join(gatewayState, 'connection.json'))

    // A restarted console does not bring it back either.
    const restarted = await run(`console.log(JSON.stringify((await connections.locationSnapshot()).remote))`)
    assert.equal(restarted, null)
  })
})
