import test from 'node:test'
import assert from 'node:assert/strict'
import { connectionView, launchNativeTerminal, sshRoute } from './ssh.js'

const ready = (extra = {}) => ({ name: 'demo', phase: 'ready', tty: false, labels: {}, ...extra })
const local = { name: 'local-gw', endpoint: 'https://127.0.0.1:8080', remote: false }
const remote = { name: 'remote-gw', endpoint: 'https://gateway.example', remote: true }
const tools = { OPENSHELL_BIN: '/bin/sh', PATH: '/usr/bin:/bin' }

test('local and remote gateways produce the same pinned SSH flow', () => {
  const localView = connectionView(ready(), local, { env: tools, platform: 'darwin' })
  const remoteView = connectionView(ready(), remote, { env: tools, platform: 'darwin' })
  assert.equal(localView.gateway.remote, false)
  assert.equal(remoteView.gateway.remote, true)
  assert.equal(localView.canOpenTerminal, true)
  assert.equal(remoteView.canOpenTerminal, true)
  assert.deepEqual(Object.keys(localView.modes), ['exec'])
  assert.match(localView.modes.exec.command, /'local-gw'/)
  assert.match(remoteView.modes.exec.command, /'remote-gw'/)
})

test('canonical attach is exposed only when the sandbox owns a TTY', () => {
  assert.equal(connectionView(ready(), local, { env: tools }).modes.attach, undefined)
  assert.deepEqual(connectionView(ready({ tty: true }), local, { env: tools }).modes.attach.argv,
    ['--gateway', 'local-gw', 'sandbox', 'connect', 'demo'])
})

test('the open route revalidates readiness and launches only a server-built command', async () => {
  let launched
  const dependencies = {
    target: remote,
    env: tools,
    platform: 'darwin',
    loadSandbox: async () => ready(),
    launchTerminal: async (command) => { launched = command },
  }
  const result = await sshRoute('POST', ['sandboxes', 'demo', 'ssh-open'], { mode: 'exec', command: 'malicious' }, dependencies)
  assert.deepEqual(result, { ok: true, mode: 'exec' })
  assert.match(launched, /'remote-gw'/)
  assert.doesNotMatch(launched, /malicious/)

  await assert.rejects(sshRoute('POST', ['sandboxes', 'demo', 'ssh-open'], { mode: 'exec' }, {
    ...dependencies, loadSandbox: async () => ready({ phase: 'stopped' }),
  }), { status: 409 })
})

test('SSH config is returned without writing it or exposing credentials', async () => {
  let call
  const config = 'Host openshell-demo.default\n    User sandbox\n    ProxyCommand /bin/openshell ssh-proxy --gateway-name remote-gw --name demo --workspace default\n'
  const result = await sshRoute('POST', ['sandboxes', 'demo', 'ssh-config'], {}, {
    target: remote,
    loadSandbox: async () => ready(),
    runOpenShell: async (args, options) => {
      call = { args, options }
      return { code: 0, stdout: config, stderr: '', timedOut: false, outputExceeded: false }
    },
  })
  assert.deepEqual(call.args, ['sandbox', 'ssh-config', 'demo'])
  assert.equal(call.options.gateway, 'remote-gw')
  assert.equal(result.config, config)
  assert.equal(result.command, "ssh 'openshell-demo.default'")
  assert.doesNotMatch(JSON.stringify(result), /token|certificate|private.?key/i)
})

test('macOS terminal launch passes one escaped script to osascript', async () => {
  let invocation
  await launchNativeTerminal(`echo "a\\b"`, {
    platform: 'darwin',
    exec: (file, args, options, callback) => { invocation = { file, args, options }; callback(null) },
  })
  assert.equal(invocation.file, 'osascript')
  assert.match(invocation.args[1], /echo \\"a\\\\b\\"/)
})

test('SSH terminal launches serialize tab discovery and continue after a permission failure', async () => {
  const calls = []
  const callbacks = []
  const dependencies = {
    platform: 'darwin',
    exec: (file, args, options, callback) => { calls.push(args[1]); callbacks.push(callback) },
  }
  const first = launchNativeTerminal('first', dependencies)
  const rejected = assert.rejects(first, { status: 502, message: /Accessibility/ })
  const second = launchNativeTerminal('second', dependencies)
  await new Promise(setImmediate)
  assert.equal(calls.length, 1)
  callbacks[0](new Error('denied'), '', 'not allowed to send keystrokes (-1719)')
  await rejected
  await new Promise(setImmediate)
  assert.equal(calls.length, 2)
  assert.match(calls[1], /do script "second" in candidate/)
  callbacks[1](null)
  await second
})
