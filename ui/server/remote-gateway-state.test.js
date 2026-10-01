import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import https from 'node:https'
import { X509Certificate } from 'node:crypto'
import { parse } from 'smol-toml'
import { prepareGatewayState, registerManagedGateway, gatewayEnvironment, remoteGatewayName } from './remote-gateway-state.js'
import { findExecutable, runCli } from './openshell-cli.js'

const probe = { engineId: 'engine-one', version: '0.1.2' }

test('remote gateway state survives reconnect without adopting another host or engine', { skip: !findExecutable('openssl') }, async t => {
  const rootDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'remote-state-'))
  t.after(() => fs.rm(rootDirectory, { recursive: true, force: true }))
  const state = await prepareGatewayState('work', probe, '/tmp/first.sock', { rootDirectory })
  const originalCa = await fs.readFile(path.join(state.tls, 'ca.crt'))
  const reconnected = await prepareGatewayState('work', probe, '/tmp/second.sock', { rootDirectory })
  assert.equal(reconnected.port, state.port)
  assert.deepEqual(await fs.readFile(path.join(reconnected.tls, 'ca.crt')), originalCa)
  assert.notEqual(remoteGatewayName('work', 'new-engine'), state.name)
  assert.notEqual(remoteGatewayName('other', probe.engineId), state.name)
  const config = parse(await fs.readFile(reconnected.configFile, 'utf8')).openshell
  assert.equal(config.drivers.docker.socket_path, '/tmp/second.sock')
  assert.equal(config.drivers.docker.grpc_endpoint, `https://127.0.0.1:${state.port}`)
  assert.equal(config.gateway.mtls_auth.enabled, true)
  assert.equal(config.gateway.tls.client_ca_path, path.join(state.tls, 'ca.crt'))
  assert.equal((await fs.stat(path.join(state.tls, 'client.key'))).mode & 0o777, 0o600)
  assert.notDeepEqual(await fs.readFile(config.gateway.guest_tls_key), await fs.readFile(path.join(state.tls, 'client.key')))
  assert.equal(new X509Certificate(await fs.readFile(config.gateway.guest_tls_cert)).subject, 'CN=openshell-supervisor')
  const executable = findExecutable('openshell-gateway')
  if (executable) {
    const result = await runCli(executable, ['config', 'preflight', '--path', reconnected.configFile], { env: reconnected.env })
    assert.equal(result.code, 0, result.stderr)
  }

  const configDir = path.join(rootDirectory, 'operator-config')
  const existing = path.join(configDir, 'gateways', 'local')
  await fs.mkdir(existing, { recursive: true })
  await fs.writeFile(path.join(existing, 'metadata.json'), 'original local gateway')
  await registerManagedGateway(state, 'work', { configDir })
  assert.equal(await fs.readFile(path.join(existing, 'metadata.json'), 'utf8'), 'original local gateway')
  const registration = path.join(configDir, 'gateways', state.name)
  assert.equal(JSON.parse(await fs.readFile(path.join(registration, 'metadata.json'), 'utf8')).is_remote, true)
  await assert.rejects(registerManagedGateway(state, 'other', { configDir }), /different console/)
  await fs.rm(path.join(registration, 'console-managed.json'))
  await assert.rejects(registerManagedGateway(state, 'work', { configDir }), /conflicts/)
})

test('managed gateway certificates authenticate localhost and require the generated client key', { skip: !findExecutable('openssl') }, async t => {
  const rootDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'remote-tls-'))
  t.after(() => fs.rm(rootDirectory, { recursive: true, force: true }))
  const state = await prepareGatewayState('work', probe, '/tmp/test.sock', { rootDirectory })
  const pem = async name => fs.readFile(path.join(state.tls, name))
  const ca = await pem('ca.crt'), cert = await pem('client.crt'), key = await pem('client.key')
  const serverCert = new X509Certificate(await pem('server.crt'))
  assert.equal(serverCert.checkIP('127.0.0.1'), '127.0.0.1')
  assert.equal(serverCert.checkHost('localhost'), 'localhost')
  const server = https.createServer({ ca, cert: await pem('server.crt'), key: await pem('server.key'), requestCert: true, rejectUnauthorized: true }, (req, res) => res.end('authenticated'))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const request = credentials => new Promise((resolve, reject) => {
    https.get(`https://127.0.0.1:${server.address().port}`, { ca, agent: false, ...credentials }, res => {
      let body = ''
      res.on('data', chunk => { body += chunk })
      res.on('end', () => resolve(body))
      res.on('error', reject)
    }).on('error', reject)
  })
  assert.equal(await request({ cert, key }), 'authenticated')
  await assert.rejects(request({}))
})

test('inherited gateway overrides cannot redirect the second gateway into operator state', () => {
  const before = process.env.OPENSHELL_DB_URL
  process.env.OPENSHELL_DB_URL = 'sqlite:/operator/private.db'
  try {
    const env = gatewayEnvironment('/isolated')
    assert.equal(env.OPENSHELL_DB_URL, undefined)
    assert.equal(env.XDG_STATE_HOME, '/isolated/state')
    assert.equal(env.XDG_CONFIG_HOME, '/isolated/config')
  } finally {
    if (before === undefined) delete process.env.OPENSHELL_DB_URL
    else process.env.OPENSHELL_DB_URL = before
  }
})
