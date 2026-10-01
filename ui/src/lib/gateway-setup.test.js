import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { registrationPlan, shellQuote } from './gateway-setup.js'

const valid = { name: 'private-cluster', configDir: '/tmp/config/openshell', bundleDir: '/tmp/private-bundle', mode: 'loopback', endpoint: 'https://127.0.0.1:8443' }

test('rejects unsafe registration names, credentialed endpoints and incomplete instructions', () => {
  for (const name of ['', '..', '../escape', '-option', 'a/b', 'a;touch injected', 'a\nname']) {
    assert.equal(registrationPlan({ ...valid, name }).registrationCommand, null, name)
  }
  for (const endpoint of ['https://user:secret@127.0.0.1:8443', 'http://127.0.0.1:8443', 'https://127.0.0.1:8443/?token=secret', 'https://127.0.0.1:8443/#secret', 'https://remote.example:8443', 'https://127.0.0.1:8443/path']) {
    assert.equal(registrationPlan({ ...valid, endpoint }).registrationCommand, null, endpoint)
  }
  for (const bundleDir of ['', '~/.bundle', '/tmp/../config', '/tmp/bundle\ncommand', '/tmp/config/openshell/gateways/private-cluster/mtls']) {
    assert.equal(registrationPlan({ ...valid, bundleDir }).registrationCommand, null, bundleDir)
  }
  assert.equal(registrationPlan({ ...valid, gateways: [{ name: valid.name }] }).registrationCommand, null)
})

test('requires exact Kubernetes route inputs and valid port boundaries', () => {
  const kube = { ...valid, mode: 'kubernetes', kubeContext: 'private-admin', namespace: 'openshell', service: 'gateway', localPort: '8443', servicePort: '8080' }
  for (const field of ['kubeContext', 'namespace', 'service', 'localPort', 'servicePort']) {
    const plan = registrationPlan({ ...kube, [field]: '' })
    assert.equal(plan.registrationCommand, null, field)
    assert.equal(plan.tunnelCommand, null, field)
  }
  for (const localPort of ['0', '65536', '-1', '8443;id', '1.5']) assert.equal(registrationPlan({ ...kube, localPort }).tunnelCommand, null)
  for (const localPort of ['1', '65535']) assert.deepEqual(registrationPlan({ ...kube, localPort }).errors, [])
})

test('shell quoting preserves hostile-looking arguments as data', () => {
  const input = "a'; printf injected; # $(printf surprise) `printf nope`"
  const result = spawnSync('/bin/sh', ['-c', `printf '%s' ${shellQuote(input)}`], { encoding: 'utf8' })
  assert.equal(result.status, 0)
  assert.equal(result.stdout, input)
})

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gateway-setup-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const configDir = path.join(root, "config ' $(not-a-command)", 'openshell')
  const bundleDir = path.join(root, "bundle ' $(not-a-command)")
  const bin = path.join(root, 'bin')
  await fs.mkdir(bundleDir)
  await fs.mkdir(bin)
  for (const file of ['ca.crt', 'tls.crt', 'tls.key']) await fs.writeFile(path.join(bundleDir, file), `original fixture ${file}`)
  // Simulate the observed CLI replacement, including an unsuccessful registration.
  await fs.writeFile(path.join(bin, 'openshell'), `#!/bin/sh
printf 'cli-created metadata' > "$XDG_CONFIG_HOME/openshell/gateways/private-cluster/metadata.json"
for file in ca.crt tls.crt tls.key; do
  printf 'cli replacement' > "$XDG_CONFIG_HOME/openshell/gateways/private-cluster/mtls/$file"
done
exit "\${CLI_EXIT:-0}"
`, { mode: 0o700 })
  const plan = registrationPlan({ ...valid, configDir, bundleDir })
  assert.deepEqual(plan.errors, [])
  return { ...plan, configDir, bundleDir, env: { ...process.env, OPENSHELL_BIN: path.join(bin, 'openshell'), PATH: `${bin}:${process.env.PATH}` } }
}

for (const exitCode of [0, 23]) {
  test(`manual script restores original bundle and private permissions after CLI exit ${exitCode}`, async (t) => {
    const setup = await fixture(t)
    const result = spawnSync('/bin/sh', ['-c', setup.registrationCommand], { encoding: 'utf8', env: { ...setup.env, CLI_EXIT: String(exitCode) } })
    assert.equal(result.status, exitCode, result.stderr)
    for (const file of ['ca.crt', 'tls.crt', 'tls.key']) {
      const destination = path.join(setup.destination, 'mtls', file)
      assert.equal(await fs.readFile(destination, 'utf8'), `original fixture ${file}`)
      assert.equal(await fs.readFile(path.join(setup.bundleDir, file), 'utf8'), `original fixture ${file}`)
      assert.equal((await fs.stat(destination)).mode & 0o777, 0o600)
    }
    assert.equal((await fs.stat(path.join(setup.destination, 'mtls'))).mode & 0o777, 0o700)
  })
}

test('manual script refuses preexisting metadata without replacing credentials', async (t) => {
  const setup = await fixture(t)
  await fs.mkdir(path.join(setup.destination, 'mtls'), { recursive: true })
  await fs.writeFile(path.join(setup.destination, 'metadata.json'), 'existing registration')
  await fs.writeFile(path.join(setup.destination, 'mtls', 'tls.key'), 'existing private key')
  const result = spawnSync('/bin/sh', ['-c', setup.registrationCommand], { encoding: 'utf8', env: setup.env })
  assert.notEqual(result.status, 0)
  assert.equal(await fs.readFile(path.join(setup.destination, 'metadata.json'), 'utf8'), 'existing registration')
  assert.equal(await fs.readFile(path.join(setup.destination, 'mtls', 'tls.key'), 'utf8'), 'existing private key')
})

test('missing administrator bundle files do not create a partial registration', async (t) => {
  const setup = await fixture(t)
  await fs.unlink(path.join(setup.bundleDir, 'tls.key'))
  const result = spawnSync('/bin/sh', ['-c', setup.registrationCommand], { encoding: 'utf8', env: setup.env })
  assert.notEqual(result.status, 0)
  await assert.rejects(fs.stat(setup.destination), { code: 'ENOENT' })
})
