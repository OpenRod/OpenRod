import test from 'node:test'
import assert from 'node:assert/strict'
import { createCompute } from './compute.js'

const config = { origin: 'https://cloud.example.test', firebase: { projectId: 'openrod-test' } }
const env = { OPENROD_WORKER_SUBNET: 'projects/openrod-test/regions/us-east1/subnetworks/openrod', OPENROD_WORKER_ARTIFACT_ORIGIN: 'http://10.80.0.2:8080', OPENROD_WORKER_ARTIFACT_SHA256: 'a'.repeat(64) }
const credential = { getAccessToken: async () => ({ access_token: 'fixture-token' }) }
const record = { uid: 'alice', name: 'openrod-user-' + 'a'.repeat(24), requestId: 'e5c76255-0e71-46eb-bb02-0a88797b78fe', key: 'b'.repeat(64) }

test('provisioned worker has no public IP or cloud credentials and uses a stable request ID', async () => {
  let called
  const compute = await createCompute(config, credential, { env, requestFetch: async (url, options) => { called = { url, options }; return Response.json({ name: 'operation' }) } })
  await compute.create(record)
  assert.ok(called.url.endsWith(`/instances?requestId=${record.requestId}`))
  const body = JSON.parse(called.options.body)
  assert.equal(body.name, record.name)
  assert.equal(body.labels.openrod_owner, '2bd806c97f0e00af1a1fc332')
  assert.deepEqual(body.serviceAccounts, [])
  assert.equal(body.networkInterfaces[0].accessConfigs, undefined)
  assert.equal(body.networkInterfaces[0].subnetwork, env.OPENROD_WORKER_SUBNET)
  assert.equal(body.disks[1].autoDelete, false)
  assert.equal(body.shieldedInstanceConfig.enableSecureBoot, true)
  assert.equal(body.metadata.items.find(item => item.key === 'block-project-ssh-keys').value, 'TRUE')
})

test('worker ownership labels use the owner UID regardless of resource prefix', async () => {
  for (const prefix of ['openrod-user', 'legacy-user', 'my-company-worker']) {
    let body
    const compute = await createCompute(config, credential, { env: { ...env, OPENROD_WORKER_OWNER_LABEL: 'fleet_owner' }, requestFetch: async (_url, options) => { body = JSON.parse(options.body); return Response.json({ name: 'operation' }) } })
    await compute.create({ ...record, name: `${prefix}-2bd806c97f0e00af1a1fc332` })
    assert.equal(body.labels.fleet_owner, '2bd806c97f0e00af1a1fc332')
  }
})

test('missing instance reads return null but failed create requests are not treated as success', async () => {
  const compute = await createCompute(config, credential, { env, requestFetch: async () => Response.json({ error: { message: 'Subnet missing' } }, { status: 404 }) })
  assert.equal(await compute.get(record.name), null)
  await assert.rejects(compute.create(record), { code: 404, message: 'Subnet missing' })
})
