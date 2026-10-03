import test from 'node:test'
import assert from 'node:assert/strict'
import { createGatewayDocker, dockerImageProblem } from './gateway-docker.js'

const tick = () => new Promise((resolve) => setImmediate(resolve))
const clock = () => {
  const timers = []
  return {
    timers,
    schedule: (fn, ms) => { const t = { fn, ms, live: true }; timers.push(t); return t },
    cancel: (t) => { if (t) t.live = false },
    live: () => timers.filter((t) => t.live),
    fire: () => { const t = timers.findLast((x) => x.live); t.live = false; t.fn() },
  }
}
const mismatch = (patch = {}) => ({ state: 'mismatch', fix: 'confirm', sandboxes: [], stranded: [], conflict: null, job: null, ...patch })
const conflictError = (sandboxes) => Object.assign(new Error('Connecting restarts OpenShell and running sandboxes.'), { code: 'GATEWAY_DOCKER_MISMATCH', fix: 'confirm', sandboxes })

test('polls every 2 seconds while connecting and every 15 seconds otherwise', async () => {
  const c = clock()
  const answers = [{ state: 'working', job: { id: 'j', status: 'working' } }, { state: 'ok', job: { id: 'j', status: 'done' } }]
  const store = createGatewayDocker({ gatewayDocker: async () => answers.shift() }, c)
  store.subscribe(() => {})
  await tick()
  assert.equal(store.getSnapshot().status.state, 'working')
  assert.deepEqual(c.live().map((t) => t.ms), [2000])
  c.fire()
  await tick()
  assert.equal(store.getSnapshot().status.state, 'ok')
  assert.deepEqual(c.live().map((t) => t.ms), [15_000])
})

test('connect sends the sandbox names the user saw and opens the dialog on a confirmation conflict', async () => {
  const c = clock()
  const sent = []
  let status = mismatch({ sandboxes: [{ name: 'a', workspace: 'default' }] })
  const store = createGatewayDocker({
    gatewayDocker: async () => status,
    connectGatewayDocker: async (seen) => {
      sent.push(seen)
      if (sent.length === 1) { status = mismatch({ sandboxes: [{ name: 'a', workspace: 'default' }, { name: 'b', workspace: 'team' }] }); throw conflictError(status.sandboxes) }
      return { state: 'working', job: { id: 'j', status: 'working' } }
    },
  }, c)
  store.subscribe(() => {})
  await tick()
  store.ask({ kind: 'connect' })
  assert.deepEqual(store.getSnapshot().asking.sandboxes, [{ name: 'a', workspace: 'default' }])
  await store.connect()
  assert.deepEqual(sent[0], ['default/a'])
  const { asking, error } = store.getSnapshot()
  assert.equal(asking.kind, 'connect')
  assert.equal(asking.busy, false)
  assert.deepEqual(asking.sandboxes.map((s) => s.name), ['a', 'b'])
  assert.equal(error, null)
  await store.connect()
  assert.deepEqual(sent[1], ['default/a', 'team/b'])
  assert.equal(store.getSnapshot().asking, null)
  assert.equal(store.getSnapshot().status.state, 'working')
})

test('ask connects directly when nothing would restart', async () => {
  const c = clock()
  const sent = []
  let retried = 0
  const answers = [mismatch(), { state: 'working', job: { id: 'j', status: 'working' } }, { state: 'ok', job: { id: 'j', status: 'done' } }]
  const store = createGatewayDocker({
    gatewayDocker: async () => answers.shift(),
    connectGatewayDocker: async (seen, confirm) => { sent.push([seen, confirm]); return answers.shift() },
  }, c)
  store.subscribe(() => {})
  await tick()
  await store.ask({ then: () => retried++ })
  assert.deepEqual(sent, [[[], true]])
  assert.equal(store.getSnapshot().asking, null)
  assert.equal(retried, 0)
  c.fire()
  await tick()
  assert.equal(retried, 1)

  const manual = createGatewayDocker({ gatewayDocker: async () => mismatch({ fix: 'manual', steps: { file: '~/x' } }) }, clock())
  manual.subscribe(() => {})
  await tick()
  manual.ask()
  assert.equal(manual.getSnapshot().asking.kind, 'steps')

  const running = createGatewayDocker({ gatewayDocker: async () => mismatch({ sandboxes: [{ name: 'a', workspace: 'default' }] }) }, clock())
  running.subscribe(() => {})
  await tick()
  running.ask()
  assert.equal(running.getSnapshot().asking.kind, 'connect')
})

test('ask lets the server decide when the status is stale, and the dialog then confirms', async () => {
  const c = clock()
  const sent = []
  let status = { state: 'ok', job: null }
  const store = createGatewayDocker({
    gatewayDocker: async () => status,
    connectGatewayDocker: async (seen, confirm) => {
      sent.push([seen, confirm])
      if (!confirm) throw conflictError([])
      return { state: 'working', job: { id: 'j', status: 'working' } }
    },
  }, c)
  store.subscribe(() => {})
  await tick()
  status = mismatch({ conflict: { dockerHost: 'unix:///x', source: 'file' } })
  await store.ask({})
  assert.deepEqual(sent, [[[], false]])
  assert.equal(store.getSnapshot().asking.kind, 'connect')
  assert.deepEqual(store.getSnapshot().status.conflict, { dockerHost: 'unix:///x', source: 'file' })
  await store.connect()
  assert.deepEqual(sent[1], [[], true])
  assert.equal(store.getSnapshot().status.state, 'working')
})

test('stops polling when the last subscriber leaves', async () => {
  const c = clock()
  let calls = 0
  const store = createGatewayDocker({ gatewayDocker: async () => { calls++; return { state: 'ok' } } }, c)
  const first = store.subscribe(() => {})
  const second = store.subscribe(() => {})
  await tick()
  assert.equal(calls, 1)
  first()
  assert.equal(c.live().length, 1)
  second()
  assert.equal(c.live().length, 0)
  await store.refresh()
  assert.equal(c.live().length, 0)
})

test('dockerImageProblem matches the VM message and not other failures', () => {
  assert.equal(dockerImageProblem('failed to resolve vm sandbox image "openshell-template/x:1": failed to pull from index.docker.io: Not authorized'), true)
  assert.equal(dockerImageProblem('Failed to resolve image openshell-template/x from registry-1.docker.io'), true)
  assert.equal(dockerImageProblem('failed to resolve vm sandbox image "ghcr.io/x/y:1": not found'), false)
  assert.equal(dockerImageProblem('container exited with code 1'), false)
  assert.equal(dockerImageProblem(undefined), false)
})
