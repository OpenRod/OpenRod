import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, constants } from 'node:http2'
import { once } from 'node:events'
import { fromBinary } from '@bufbuild/protobuf'
import { ExecSandboxRequestSchema } from '@nvidia/openshell-sdk/raw'
import { connectGateway } from './gateway.js'

// Local h2c transport only: no active gateway, configuration or credentials.
async function fixture(t) {
  const sessions = new Set(), requests = [], waiters = []
  const server = createServer()
  let respond = false
  server.on('session', session => { sessions.add(session); session.on('close', () => sessions.delete(session)) })
  server.on('stream', (stream, headers) => {
    stream.on('error', () => {})
    const chunks = []
    stream.on('data', chunk => chunks.push(chunk))
    const body = once(stream, 'end').then(() => Buffer.concat(chunks), () => Buffer.concat(chunks))
    const request = { stream, headers, body, closed: once(stream, 'close').catch(() => {}) }
    if (waiters.length) waiters.shift()(request)
    else requests.push(request)
    stream.resume()
    if (respond) {
      stream.respond({ ':status': 200, 'content-type': 'application/grpc' }, { waitForTrailers: true })
      stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': '0' }))
      stream.end(Buffer.from([0, 0, 0, 0, 0]))
    }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => {
    for (const session of sessions) session.destroy()
    await new Promise(resolve => server.close(resolve))
  })
  const target = { endpoint: `http://127.0.0.1:${server.address().port}`, tls: {} }
  const client = await connectGateway(target, { unaryTimeoutMs: 300, execGraceMs: 100 })
  const next = () => requests.length ? Promise.resolve(requests.shift()) : new Promise((resolve, reject) => {
    const receive = request => { clearTimeout(timer); resolve(request) }
    const timer = setTimeout(() => {
      const index = waiters.indexOf(receive)
      if (index >= 0) waiters.splice(index, 1)
      reject(new Error('The localhost gateway request did not arrive within two seconds.'))
    }, 2000)
    waiters.push(receive)
  })
  return { client, next, recover: () => { respond = true } }
}
function cancellation(t) {
  const controller = new AbortController()
  const guard = setTimeout(() => controller.abort(), 2000)
  t.after(() => clearTimeout(guard))
  return controller
}
const outcome = promise => promise.then(value => ({ value }), error => ({ error }))
const drain = async events => { for await (const event of events) void event }

test('default unary deadline cancels a stalled gateway and permits recovery on the same client', async t => {
  const h = await fixture(t), controller = cancellation(t)
  const result = outcome(h.client.raw.getGatewayConfig({}, { signal: controller.signal }))
  const request = await h.next()
  const { error } = await result
  assert.equal(error?.code, 4, 'missing transport deadline falls through to the cancellation guard')
  assert.ok(request.headers['grpc-timeout'])
  await request.closed
  assert.notEqual(request.stream.rstCode, constants.NGHTTP2_NO_ERROR)
  h.recover()
  const recovered = await h.client.raw.getGatewayConfig({})
  assert.deepEqual(recovered.settings, {})
})

test('an explicit unary timeout overrides the default', async t => {
  const h = await fixture(t), controller = cancellation(t)
  const result = outcome(h.client.raw.getGatewayConfig({}, { signal: controller.signal, timeoutMs: 150 }))
  const request = await h.next(), { error } = await result
  assert.equal(error?.code, 4)
  assert.equal(request.headers['grpc-timeout'], '150m')
})

test('an explicit zero timeout preserves caller cancellation', async t => {
  const h = await fixture(t), controller = cancellation(t)
  const result = outcome(h.client.raw.getGatewayConfig({}, { signal: controller.signal, timeoutMs: 0 }))
  const request = await h.next()
  assert.equal(request.headers['grpc-timeout'], undefined)
  controller.abort()
  const { error } = await result
  assert.equal(error?.code, 1)
})

test('finite ExecSandbox streams have a transport deadline beyond their execution timeout', async t => {
  const h = await fixture(t), controller = cancellation(t)
  const result = outcome(drain(h.client.raw.execSandbox({ name: 'box', command: ['true'], executionTimeout: { seconds: 0n, nanos: 200_000_000 } }, { signal: controller.signal })))
  const request = await h.next(), { error } = await result
  assert.equal(error?.code, 4, 'server-side execution timeout alone cannot end a stalled transport')
  assert.equal(request.headers['grpc-timeout'], '300m')
  const frame = await request.body
  const message = fromBinary(ExecSandboxRequestSchema, frame.subarray(5))
  assert.deepEqual(message.command, ['true'])
  assert.equal(message.executionTimeout.nanos, 200_000_000)
  await request.closed
  assert.notEqual(request.stream.rstCode, constants.NGHTTP2_NO_ERROR)
})

test('zero-timeout exec and interactive terminal streams retain caller-controlled lifetimes', async t => {
  const h = await fixture(t)
  for (const interactive of [false, true]) {
    const controller = cancellation(t)
    const events = interactive
      ? h.client.raw.execSandboxInteractive((async function* () { yield { payload: { case: 'start', value: { name: 'box', command: ['bash'], executionTimeout: { seconds: 1n } } } } })(), { signal: controller.signal })
      : h.client.raw.execSandbox({ name: 'box', command: ['bash'], executionTimeout: { seconds: 0n } }, { signal: controller.signal })
    const result = outcome(drain(events)), request = await h.next()
    assert.equal(request.headers['grpc-timeout'], undefined)
    controller.abort()
    const { error } = await result
    assert.equal(error?.code, 1)
  }
})

test('finite exec streams preserve explicit transport timeout and opt-out', async t => {
  const h = await fixture(t)
  for (const timeoutMs of [150, 0]) {
    const controller = cancellation(t)
    const events = h.client.raw.execSandbox({ name: 'box', command: ['true'], executionTimeout: { seconds: 1n } }, { signal: controller.signal, timeoutMs })
    const result = outcome(drain(events)), request = await h.next()
    assert.equal(request.headers['grpc-timeout'], timeoutMs ? '150m' : undefined)
    if (!timeoutMs) controller.abort()
    const { error } = await result
    assert.equal(error?.code, timeoutMs ? 4 : 1)
  }
})

test('sandbox watch streams retain caller-controlled lifetimes', async t => {
  const h = await fixture(t), controller = cancellation(t)
  const result = outcome(drain(h.client.raw.watchSandbox({ name: 'box' }, { signal: controller.signal })))
  const request = await h.next()
  assert.equal(request.headers['grpc-timeout'], undefined)
  controller.abort()
  const { error } = await result
  assert.equal(error?.code, 1)
})
