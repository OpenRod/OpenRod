import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { contextKey, contextSelection, listGateways, runWithContext, sandboxView, workspaceName, workspaceScope } from './gateway.js'

test('overlapping asynchronous requests retain independent gateway and workspace identities', async () => {
  let release
  const barrier = new Promise((resolve) => { release = resolve })
  const first = runWithContext({ gateway: 'local', workspace: 'alpha' }, async () => {
    await barrier
    assert.deepEqual(contextSelection(), { gateway: 'local', workspace: 'alpha' })
    assert.deepEqual(workspaceScope(), { selection: { case: 'workspace', value: 'alpha' } })
    assert.equal(workspaceName(), 'alpha')
    return contextKey()
  })
  const second = runWithContext({ gateway: 'remote', workspace: 'beta' }, async () => {
    release()
    await Promise.resolve()
    assert.deepEqual(contextSelection(), { gateway: 'remote', workspace: 'beta' })
    return contextKey()
  })
  assert.deepEqual(await Promise.all([first, second]), ['["local","alpha"]', '["remote","beta"]'])
})

test('gateway enumeration exposes only connection metadata and flags unsupported authentication', async (t) => {
  const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'console-gateways-'))
  t.after(() => fs.rm(configDir, { recursive: true, force: true }))
  for (const [name, auth] of [['prod', 'oidc'], ['local', 'mtls']]) {
    const dir = path.join(configDir, 'gateways', name)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'metadata.json'), JSON.stringify({
      gateway_endpoint: `https://${name}.example`, auth_mode: auth, is_remote: name === 'prod',
      client_key: 'must-not-reach-the-browser', token: 'must-not-reach-the-browser',
    }))
  }
  await fs.mkdir(path.join(configDir, 'gateways', 'broken'))
  const registrations = listGateways({ configDir })
  assert.deepEqual(registrations.map(({ name }) => name), ['broken', 'local', 'prod'])
  assert.equal(registrations[0].supported, false)
  assert.equal(typeof registrations[0].error, 'string')
  assert.deepEqual(registrations.slice(1), [
    { name: 'local', endpoint: 'https://local.example', authMode: 'mtls', remote: false, supported: true },
    { name: 'prod', endpoint: 'https://prod.example', authMode: 'oidc', remote: true, supported: false },
  ])
})

test('a ready Kubernetes sandbox is not erroneous merely because it is not suspended', () => {
  const view = sandboxView({ status: { phase: 2, conditions: [
    { type: 'Suspended', status: 'False', message: 'Sandbox is not suspended' },
    { type: 'Ready', status: 'True', message: 'Supervisor session connected' },
  ] } })
  assert.equal(view.phase, 'ready')
  assert.equal(view.problem, null)
  assert.equal(sandboxView({ status: { conditions: [{ type: 'Ready', status: 'False', message: 'Supervisor disconnected' }] } }).problem, 'Supervisor disconnected')
})
