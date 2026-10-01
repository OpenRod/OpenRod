import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { stringify } from 'smol-toml'

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'remote-image-engine-'))
const previous = { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, OPENSHELL_CONSOLE_DATA_DIR: process.env.OPENSHELL_CONSOLE_DATA_DIR }
process.env.XDG_CONFIG_HOME = path.join(temporary, 'config')
process.env.OPENSHELL_CONSOLE_DATA_DIR = path.join(temporary, 'state')
after(async () => {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  await fs.rm(temporary, { recursive: true, force: true })
})
const { remoteImageEngine } = await import('./remote-image-engine.js')
const { remoteGatewayName } = await import('./remote-gateway-state.js')
const { CONFIG_DIR, runWithContext } = await import('./gateway.js')

async function fixture() {
  const host = `host-${randomUUID()}`
  const engineId = 'saved-engine'
  const name = remoteGatewayName(host, engineId)
  const root = path.join(temporary, 'state', 'remote-gateways', name)
  const registration = path.join(CONFIG_DIR, 'gateways', name)
  await fs.mkdir(root, { recursive: true })
  await fs.mkdir(registration, { recursive: true })
  const marker = path.join(registration, 'console-managed.json')
  const connection = path.join(root, 'connection.json')
  const config = path.join(root, 'gateway.toml')
  const socketPath = path.join(temporary, `${name}.sock`)
  await fs.writeFile(marker, JSON.stringify({ root, host }))
  await fs.writeFile(connection, JSON.stringify({ host, engineId, port: 23456 }))
  await fs.writeFile(config, stringify({ openshell: { drivers: { docker: { socket_path: socketPath } } } }))
  return { target: { name, remote: true }, host, root, engineId, marker, connection, config, endpoint: `unix://${socketPath}` }
}
const info = (f, overrides = {}) => JSON.stringify({ ID: f.engineId, OSType: 'linux', Architecture: 'x86_64', ...overrides })
const forbidden = async () => { assert.fail('Untrusted state must not reach a Docker engine') }

test('captured managed host resolves its own tunnel and supported Linux platform despite another active context', async t => {
  const f = await fixture()
  for (const [Architecture, architecture] of [['x86_64', 'amd64'], ['amd64', 'amd64'], ['aarch64', 'arm64'], ['arm64', 'arm64']]) {
    await t.test(Architecture, async () => {
      const descriptor = await runWithContext({ gateway: 'unrelated', workspace: 'other' }, () => remoteImageEngine(f.target, {
        execute: async (_args, { engine }) => {
          if (engine.endpoint !== f.endpoint) throw new Error('Wrong Docker engine')
          return info(f, { Architecture })
        },
      }))
      assert.deepEqual(descriptor, { endpoint: f.endpoint, architecture, engineId: f.engineId })
    })
  }
})

test('unmanaged and non-SSH remotes require an explicit supported connection', async () => {
  const f = await fixture()
  await fs.rm(f.marker)
  for (const target of [f.target, { name: 'cloud-remote', remote: true }, { name: '../elsewhere', remote: true }, { name: 'local', remote: false }]) {
    await assert.rejects(remoteImageEngine(target, { execute: forbidden }), { status: 409, message: /managed SSH Docker transport.*Connections/ })
  }
})

test('registry and saved connection cannot redirect a captured host to unrelated state', async t => {
  const changes = [
    ['foreign root', async f => fs.writeFile(f.marker, JSON.stringify({ root: temporary, host: f.host }))],
    ['marker host mismatch', async f => fs.writeFile(f.marker, JSON.stringify({ root: f.root, host: 'another-host' }))],
    ['connection engine mismatch', async f => fs.writeFile(f.connection, JSON.stringify({ host: f.host, engineId: 'another-engine', port: 23456 }))],
    ['connection host and marker changed together', async f => {
      await fs.writeFile(f.marker, JSON.stringify({ root: f.root, host: 'another-host' }))
      await fs.writeFile(f.connection, JSON.stringify({ host: 'another-host', engineId: f.engineId, port: 23456 }))
    }],
    ['invalid connection port', async f => fs.writeFile(f.connection, JSON.stringify({ host: f.host, engineId: f.engineId, port: 0 }))],
    ['missing connection', async f => fs.rm(f.connection)],
    ['malformed marker', async f => fs.writeFile(f.marker, '{')],
    ['missing Docker config', async f => fs.writeFile(f.config, '[openshell]\nversion = 2\n')],
    ['invalid TOML', async f => fs.writeFile(f.config, 'socket_path = [')],
    ['network endpoint instead of tunnel', async f => fs.writeFile(f.config, stringify({ openshell: { drivers: { docker: { socket_path: 'tcp://remote:2375' } } } }))],
  ]
  for (const [name, change] of changes) {
    await t.test(name, async () => {
      const f = await fixture()
      await change(f)
      await assert.rejects(remoteImageEngine(f.target, { execute: forbidden }), { status: 409, message: /state is missing or invalid.*Reconnect/ })
    })
  }
})

test('inactive SSH tunnel offers reconnection without falling back to a local daemon', async () => {
  const f = await fixture()
  let attempts = 0
  await assert.rejects(remoteImageEngine(f.target, { execute: async () => { attempts++; throw new Error('ECONNREFUSED') } }), { status: 409, message: /SSH Docker tunnel is not available.*Reconnect/ })
  assert.equal(attempts, 1)
})

test('a live tunnel must still reach the exact saved Docker engine and a supported Linux platform', async t => {
  for (const [name, overrides, message] of [
    ['replaced engine', { ID: 'replacement' }, /saved Docker engine/],
    ['missing identity', { ID: undefined }, /saved Docker engine/],
    ['Windows engine', { OSType: 'windows' }, /Linux containers/],
    ['unsupported CPU', { Architecture: 's390x' }, /amd64 or arm64/],
    ['missing CPU', { Architecture: undefined }, /amd64 or arm64/],
    ['nonarchitecture object key', { Architecture: '__proto__' }, /amd64 or arm64/],
  ]) {
    await t.test(name, async () => {
      const f = await fixture()
      await assert.rejects(remoteImageEngine(f.target, { execute: async () => info(f, overrides) }), { status: 409, message })
    })
  }
})
