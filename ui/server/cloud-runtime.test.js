import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import { createHash } from 'node:crypto'
import { cloudConfig, releaseConfig } from './security.js'
import { createCloudRuntime, cloudRuntimeConfig, verifyWorkerArtifact } from './cloud-runtime.js'
import { createConsoleServer } from './start.js'
import { signWorkerRequest } from './worker-auth.js'

const authEnv = { OPENROD_MODE: 'cloud', OPENROD_ORG_ID: 'pilot', OPENROD_PUBLIC_ORIGIN: 'https://console.example.com', GOOGLE_CLOUD_PROJECT: 'openrod-test', OPENROD_FIREBASE_API_KEY: 'public', OPENROD_FIREBASE_AUTH_DOMAIN: 'openrod-test.firebaseapp.com' }
const config = cloudConfig(authEnv)
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'openrod-cloud-runtime-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const artifact = path.join(root, 'worker.tar.gz'), contents = 'reviewed fixture artifact'
  await fs.writeFile(artifact, contents)
  await fs.writeFile(path.join(root, 'index.html'), 'fixture')
  return { root, env: { ...authEnv, OPENROD_WORKER_ARTIFACT: artifact, OPENROD_WORKER_ARTIFACT_SHA256: createHash('sha256').update(contents).digest('hex'), OPENROD_WORKER_ARTIFACT_ORIGIN: 'http://10.80.0.2:8080', OPENROD_WORKER_SUBNET: 'projects/openrod-test/regions/us-east1/subnetworks/openrod' } }
}

test('configured worker mode starts without control-plane dependencies', () => {
  assert.equal(releaseConfig({ OPENROD_MODE: 'worker', OPENROD_WORKER_UID: 'alice', OPENROD_WORKER_KEY: 'a'.repeat(64), OPENROD_PUBLIC_ORIGIN: config.origin }).mode, 'worker')
  assert.throws(() => cloudConfig({ ...authEnv, FIRESTORE_EMULATOR_HOST: 'localhost:8080' }), /emulators/)
})

test('actual worker server verifies signed owner requests without Firebase initialization', async t => {
  const { root } = await fixture(t)
  const key = 'a'.repeat(64), worker = cloudConfig({ OPENROD_MODE: 'worker', OPENROD_WORKER_UID: 'alice', OPENROD_WORKER_KEY: key, OPENROD_PUBLIC_ORIGIN: config.origin })
  const server = await createConsoleServer({ config: worker, dist: root, runtimeFactory: async () => { throw Error('Worker must not initialize Firebase') } })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }))
  const target = { method: 'GET', url: '/api/auth/me' }
  const request = uid => new Promise(resolve => {
    const signature = uid && signWorkerRequest(key, { uid, expires: Date.now() + 60000 }, target)
    http.get({ hostname: '127.0.0.1', port: server.address().port, path: target.url, headers: { host: worker.host, ...(signature ? { 'x-openrod-worker-auth': signature } : {}) } }, res => { let body = ''; res.on('data', chunk => { body += chunk }); res.on('end', () => resolve({ status: res.statusCode, value: JSON.parse(body) })) })
  })
  const owner = await request('alice')
  assert.equal(owner.status, 200)
  assert.equal(owner.value.user.uid, 'alice')
  assert.equal((await request('bob')).status, 403)
  assert.equal((await request()).status, 403)
})

test('cloud preflight validates fleet capacity, subnet region and reviewed artifact', async t => {
  const { env } = await fixture(t)
  assert.equal(cloudRuntimeConfig(config, env).databaseId, 'openrod-cloud')
  for (const count of ['0', '101', '1.5', 'NaN']) assert.throws(() => cloudRuntimeConfig(config, { ...env, OPENROD_MAX_MACHINES: count }), /OPENROD_MAX_MACHINES/)
  assert.throws(() => cloudRuntimeConfig(config, { ...env, OPENROD_WORKER_SUBNET: 'projects/openrod-test/regions/us-west1/subnetworks/openrod' }), /region/)
  await verifyWorkerArtifact(env.OPENROD_WORKER_ARTIFACT, env.OPENROD_WORKER_ARTIFACT_SHA256)
  await assert.rejects(verifyWorkerArtifact(env.OPENROD_WORKER_ARTIFACT, 'f'.repeat(64)), /checksum/)
})

test('cloud initialization wires auth, named registry and services without provisioning', async t => {
  const { env } = await fixture(t), events = [], auth = { getUser: async () => ({}) }
  const db = { collection: name => ({ doc: id => ({ get: async () => { events.push(`${name}/${id}`); return { exists: false } } }) }), terminate: async () => events.push('terminate') }
  const admin = { applicationDefault: () => ({ getAccessToken: async () => { events.push('adc'); return { access_token: 'fixture' } } }), initializeApp: options => { assert.equal(options.projectId, 'openrod-test'); return {} }, deleteApp: async () => events.push('deleteApp'), getAuth: () => auth, getFirestore: (_app, databaseId) => { assert.equal(databaseId, 'openrod-cloud'); return db } }
  const runtime = await createCloudRuntime(config, { env, loadAdmin: async () => admin, computeFactory: async () => ({ get: async () => { throw Error('No allocation during startup') }, create: async () => { throw Error('No allocation during startup') } }) })
  assert.equal(runtime.auth, auth)
  assert.deepEqual(await runtime.machines.status({ uid: 'alice' }), { name: null, status: 'none', error: null })
  assert.ok(runtime.connections.authenticate && runtime.handoffs.issue)
  assert.equal(await runtime.ready(), true)
  await runtime.close(); await runtime.close()
  assert.equal(events.filter(value => value === 'terminate').length, 1)
  assert.equal(events.filter(value => value === 'deleteApp').length, 1)
})

test('failed registry initialization releases its Firebase application', async t => {
  const { env } = await fixture(t)
  let terminated = false, deleted = false
  const admin = { applicationDefault: () => ({ getAccessToken: async () => ({ access_token: 'fixture' }) }), initializeApp: () => ({}), deleteApp: async () => { deleted = true }, getAuth: () => ({}), getFirestore: () => ({ collection: () => ({ doc: () => ({ get: async () => { throw Error('registry denied') } }) }), terminate: async () => { terminated = true } }) }
  await assert.rejects(createCloudRuntime(config, { env, loadAdmin: async () => admin }), /registry denied/)
  assert.ok(terminated && deleted)
})

test('cloud server initializes runtime before listening and exposes dependency readiness', async t => {
  const { root } = await fixture(t)
  let healthy = true, closed = false
  const runtime = { auth: {}, machines: {}, handoffs: {}, connections: {}, ready: async () => { if (!healthy) throw Error('registry unavailable') }, close: async () => { closed = true } }
  const server = await createConsoleServer({ config, dist: root, sessionFile: path.join(root, 'sessions.sqlite'), runtimeFactory: async (_config, { revocations }) => { assert.ok(revocations.hasDigest); return runtime } })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const request = () => new Promise(resolve => { http.get({ hostname: '127.0.0.1', port: server.address().port, path: '/readyz' }, res => { res.resume(); resolve(res.statusCode) }) })
  assert.equal(await request(), 200)
  healthy = false
  assert.equal(await request(), 503)
  await new Promise(resolve => { server.closeAllConnections(); server.close(resolve) })
  assert.equal(closed, true)
})
