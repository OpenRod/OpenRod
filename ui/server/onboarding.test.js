import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { checkGateway } from './onboarding.js'

async function registration(t, metadata = { gateway_endpoint: 'https://127.0.0.1:1', auth_mode: 'mtls' }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'console-onboarding-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const config = path.join(root, 'config', 'openshell')
  const directory = path.join(config, 'gateways', 'suggested')
  await fs.mkdir(path.join(directory, 'mtls'), { recursive: true })
  await fs.writeFile(path.join(directory, 'metadata.json'), JSON.stringify(metadata))
  return { root, config, directory }
}

test('CLI-active suggestion and failed checks never activate a fresh console or create activity state', { timeout: 15000 }, async (t) => {
  const { root, config } = await registration(t)
  await fs.writeFile(path.join(config, 'active_gateway'), 'suggested')
  const state = path.join(root, 'state')
  const moduleUrl = new URL('./api.js', import.meta.url).href
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { createServer } from 'node:http'
    import { createOpenShellApi } from ${JSON.stringify(moduleUrl)}
    const server = createServer((request, response) => api.middleware(request, response))
    const api = createOpenShellApi({ httpServer: server })
    server.listen(0, '127.0.0.1', () => console.log('READY http://127.0.0.1:' + server.address().port))
    process.on('SIGTERM', async () => {
      await api.close()
      server.close(() => process.exit(0))
      server.closeAllConnections()
    })
  `], {
    env: { ...process.env, XDG_CONFIG_HOME: path.dirname(config), OPENSHELL_CONSOLE_DATA_DIR: state, OPENSHELL_GATEWAY: '', OPENSHELL_WORKSPACE: '', OPENSHELL_CONSOLE_SWEEP: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const stopped = new Promise((resolve) => child.once('close', resolve))
  t.after(async () => {
    child.kill('SIGTERM')
    const deadline = setTimeout(() => child.kill('SIGKILL'), 3000)
    await stopped
    clearTimeout(deadline)
  })
  let stderr = ''
  child.stderr.on('data', (chunk) => { stderr += chunk })
  const origin = await new Promise((resolve, reject) => {
    let output = ''
    child.once('error', reject)
    child.once('exit', (code) => reject(new Error(`Console exited ${code}: ${stderr}`)))
    child.stdout.on('data', (chunk) => {
      output += chunk
      const match = /READY (http:\/\/127\.0\.0\.1:\d+)/.exec(output)
      if (match) resolve(match[1])
    })
  })
  const get = async (route) => fetch(`${origin}/api/os/${route}`)
  const before = await (await get('context')).json()
  assert.equal(before.gateway, 'suggested')
  assert.equal(before.selectionSource, 'cli')
  assert.equal(before.configured, false)
  assert.deepEqual(before.workspaces, [])
  assert.equal(before.workspaceError, null)
  assert.equal((await (await get('onboarding')).json()).configDir, config)
  for (const route of ['overview', 'activity', 'stream']) {
    const response = await get(route)
    assert.equal(response.status, 428)
    assert.equal((await response.json()).setupRequired, true)
  }
  const check = await fetch(`${origin}/api/os/onboarding/check`, {
    method: 'POST', headers: { origin, 'content-type': 'application/json', 'x-openshell-console': '1' }, body: JSON.stringify({ gateway: 'suggested' }),
  })
  assert.equal(check.status, 200)
  const report = await check.json()
  assert.equal(report.canConnect, false)
  assert.deepEqual(report.checks.filter((item) => item.status === 'fail').map((item) => item.id), ['ca.crt', 'tls.crt', 'tls.key'])
  assert.equal((await (await get('context')).json()).configured, false)
  await assert.rejects(fs.access(path.join(config, 'console-context.json')), { code: 'ENOENT' })
  await assert.rejects(fs.access(state), { code: 'ENOENT' })
})

test('unsupported authentication is rejected before any gateway request', async (t) => {
  const { config } = await registration(t, { gateway_endpoint: 'https://example.invalid', auth_mode: 'oidc' })
  const report = await checkGateway('suggested', { configDir: config, probe: () => assert.fail('Unsupported authentication must not make a request') })
  assert.equal(report.canConnect, false)
  assert.equal(report.checks.find((item) => item.id === 'authentication').status, 'fail')
  assert.deepEqual(report.workspaces, [])
})

test('invalid credentials and broad private-key permissions never reach gateway discovery', async (t) => {
  const { config, directory } = await registration(t)
  for (const file of ['ca.crt', 'tls.crt', 'tls.key']) await fs.writeFile(path.join(directory, 'mtls', file), 'not-a-certificate', { mode: 0o600 })
  const options = { configDir: config, probe: () => assert.fail('Invalid credentials must not make a request') }
  const invalid = await checkGateway('suggested', options)
  assert.equal(invalid.canConnect, false)
  assert.equal(invalid.checks.find((item) => item.id === 'certificate').status, 'fail')
  if (process.platform !== 'win32') {
    await fs.chmod(path.join(directory, 'mtls/tls.key'), 0o644)
    const readable = await checkGateway('suggested', options)
    assert.equal(readable.canConnect, false)
    assert.equal(readable.checks.find((item) => item.id === 'tls.key').status, 'fail')
  }
})

test('credentialed metadata is reported as invalid without returning embedded secrets', async (t) => {
  const { config } = await registration(t, { gateway_endpoint: 'https://operator:private-value@example.invalid', auth_mode: 'mtls' })
  const report = await checkGateway('suggested', { configDir: config, probe: () => assert.fail('Malformed registration must not make a request') })
  assert.equal(report.canConnect, false)
  assert.equal(report.gateway.endpoint, null)
  assert.equal(JSON.stringify(report).includes('private-value'), false)
})
