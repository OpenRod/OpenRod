import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { startRemoteRuntime, REMOTE_TLS_FILES, legacyRuntimeState } from './remote-runtime.js'
import { DatabaseSync } from 'node:sqlite'

test('remote bootstrap carries only its runtime keys over private stdin, retains local transport metadata and cleans staging', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'remote-runtime-test-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const tls = path.join(root, 'tls')
  await fs.mkdir(tls)
  for (const name of [...REMOTE_TLS_FILES, 'ca.key', 'client.key']) await fs.writeFile(path.join(tls, name), name)
  const configFile = path.join(root, 'gateway.toml'), socketPath = path.join(root, 'docker.sock')
  await fs.writeFile(configFile, `socket_path = "${socketPath}"\ncert_path = "${tls}/server.crt"\n`)
  const state = { root, name: 'console-ssh-' + 'a'.repeat(24), port: 18001, tls, socketPath, configFile }
  let staged
  await startRemoteRuntime('host', { version: '0.1.2', arch: 'amd64', engineId: 'engine', dockerSocket: '/var/run/docker.sock' }, state, {
    execute: async (host, script, options) => {
      staged = options.input
      assert.equal((await fs.stat(staged)).mode & 0o777, 0o600)
      const payload = JSON.parse(await fs.readFile(staged, 'utf8'))
      assert.deepEqual(Object.keys(payload.files).sort(), [...REMOTE_TLS_FILES].sort())
      assert.equal(payload.files['ca.key'], undefined)
      assert.equal(payload.files['client.key'], undefined)
      assert.match(payload.config, /__CONSOLE_REMOTE_ROOT__\/tls\/server.crt/)
      assert.match(payload.config, /\/var\/run\/docker.sock/)
      assert.ok(!script.includes(Buffer.from('server.key').toString('base64')))
      return JSON.stringify({ name: state.name, port: state.port, engineId: 'engine' })
    },
  })
  await assert.rejects(fs.stat(staged), { code: 'ENOENT' })
  assert.match(await fs.readFile(configFile, 'utf8'), new RegExp(socketPath))
})

test('invalid remote identity is rejected and private input is cleaned after SSH failure', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'remote-runtime-error-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  for (const name of REMOTE_TLS_FILES) await fs.writeFile(path.join(root, name), name)
  const configFile = path.join(root, 'config'), state = { root, tls: root, configFile, socketPath: '/tmp/docker.sock', name: 'expected', port: 18001 }
  await fs.writeFile(configFile, '')
  let staged
  await assert.rejects(startRemoteRuntime('host', { version: '0.1.2', arch: 'amd64', engineId: 'engine', dockerSocket: '/run/docker.sock' }, state, {
    execute: async (_host, _script, { input }) => { staged = input; return JSON.stringify({ name: 'other', engineId: 'engine', port: 18001 }) },
  }), /identity/)
  await assert.rejects(fs.stat(staged), { code: 'ENOENT' })
})

test('legacy gateway migration includes committed WAL data and driver tokens without changing the local database', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'remote-migration-test-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const directory = path.join(root, 'state/openshell/gateway'), temporary = path.join(root, 'temporary')
  await fs.mkdir(directory, { recursive: true }); await fs.mkdir(temporary)
  const file = path.join(directory, 'openshell.db'), db = new DatabaseSync(file)
  t.after(() => db.close())
  db.exec("PRAGMA journal_mode=WAL; CREATE TABLE records(value TEXT); INSERT INTO records VALUES('persisted sandbox')")
  await fs.mkdir(path.join(root, 'state/openshell/docker-sandbox-tokens'), { recursive: true })
  await fs.writeFile(path.join(root, 'state/openshell/docker-sandbox-tokens/token.json'), '{"token":"fixture"}')
  const copied = await legacyRuntimeState(root, temporary)
  assert.ok(!Object.keys(copied).some(name => /-(wal|shm)$/.test(name)))
  assert.equal(Buffer.from(copied['openshell/docker-sandbox-tokens/token.json'], 'base64').toString(), '{"token":"fixture"}')
  const snapshot = path.join(root, 'snapshot.db')
  await fs.writeFile(snapshot, Buffer.from(copied['openshell/gateway/openshell.db'], 'base64'))
  const migrated = new DatabaseSync(snapshot, { readOnly: true })
  try { assert.equal(migrated.prepare('SELECT value FROM records').get().value, 'persisted sandbox') } finally { migrated.close() }
  assert.equal(db.prepare('SELECT count(*) AS total FROM records').get().total, 1)
})
