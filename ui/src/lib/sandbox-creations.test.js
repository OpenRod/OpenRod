import test from 'node:test'
import assert from 'node:assert/strict'
import { createSandboxCreations } from './sandbox-creations.js'

const tick = () => new Promise((resolve) => setImmediate(resolve))
const mismatch = () => Object.assign(new Error('OpenShell can’t use your Docker images yet. Connect it to Docker, then try again.'), { code: 'GATEWAY_DOCKER_MISMATCH', fix: 'confirm', sandboxes: [] })

test('a failed creation keeps the error code and fix', async () => {
  const creations = createSandboxCreations()
  const id = creations.start({ name: 'box', location: null, task: async () => { throw mismatch() } })
  await tick()
  const job = creations.getSnapshot().find((item) => item.id === id)
  assert.equal(job.status, 'failed')
  assert.equal(job.code, 'GATEWAY_DOCKER_MISMATCH')
  assert.equal(job.fix, 'confirm')
  assert.match(job.error, /Connect it to Docker/)

  const plain = creations.start({ name: 'other', location: null, task: async () => { throw new Error('Gateway unavailable') } })
  await tick()
  const other = creations.getSnapshot().find((item) => item.id === plain)
  assert.equal(other.code, null)
  assert.equal(other.fix, null)
})

test('retry after connecting reruns the task', async () => {
  const creations = createSandboxCreations()
  let connected = false, runs = 0
  const id = creations.start({ name: 'box', location: null, task: async () => { runs++; if (!connected) throw mismatch(); return { name: 'box' } } })
  await tick()
  assert.equal(creations.getSnapshot()[0].status, 'failed')
  connected = true
  creations.retry(id)
  assert.equal(creations.getSnapshot()[0].status, 'preparing')
  await tick()
  assert.equal(runs, 2)
  assert.equal(creations.getSnapshot()[0].status, 'created')
  assert.equal(creations.getSnapshot()[0].sandbox.name, 'box')
})

test('a second retry while the first is running does nothing', async () => {
  const creations = createSandboxCreations()
  let runs = 0, release
  const gate = new Promise((resolve) => { release = resolve })
  const id = creations.start({ name: 'box', location: null, task: async () => { runs++; if (runs === 1) throw mismatch(); await gate; return { name: 'box' } } })
  await tick()
  creations.retry(id)
  assert.equal(creations.getSnapshot()[0].status, 'preparing')
  creations.retry(id)
  release(); await tick()
  assert.equal(runs, 2)
  assert.equal(creations.getSnapshot()[0].status, 'created')
  creations.retry(id)
  await tick()
  assert.equal(runs, 2)
})
