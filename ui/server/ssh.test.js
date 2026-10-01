import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import os from 'node:os'
import path from 'node:path'
import { connectionView, sshRoute } from './ssh.js'

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
  assert.deepEqual(Object.keys(localView.modes), ['ssh', 'exec'])
  assert.match(localView.modes.exec.command, /'local-gw'/)
  assert.match(remoteView.modes.exec.command, /'remote-gw'/)
})

test('canonical attach is exposed only when the sandbox owns a TTY', () => {
  assert.equal(connectionView(ready(), local, { env: tools }).modes.attach, undefined)
  assert.deepEqual(connectionView(ready({ tty: true }), local, { env: tools }).modes.attach.argv,
    ['--gateway', 'local-gw', '--workspace', 'default', 'sandbox', 'connect', 'demo'])
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

test('SSH config generation rejects failures instead of launching a terminal', async () => {
  for (const result of [
    { code: 1, stdout: '', stderr: 'gateway unavailable' },
    { code: 0, stdout: '' },
    { code: 0, stdout: 'partial', timedOut: true },
    { code: 0, stdout: 'partial', outputExceeded: true },
  ]) {
    await assert.rejects(sshRoute('POST', ['sandboxes', 'demo', 'ssh-open'], {}, {
      target: remote, env: tools, platform: 'darwin',
      loadSandbox: async () => ready(),
      runOpenShell: async () => result,
      launchTerminal: async () => assert.fail('must not launch with an invalid config'),
    }))
  }
})

test('native SSH keeps config private, uses the context workspace, and cleans after SSH exits', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ssh-lifecycle-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const report = path.join(root, 'report.json')
  const executable = path.join(root, 'ssh')
  await writeFile(executable, `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path')
const args = process.argv.slice(2), config = args[1]
fs.writeFileSync(process.env.SSH_REPORT, JSON.stringify({
  args, config: fs.readFileSync(config, 'utf8'),
  directoryMode: fs.statSync(path.dirname(config)).mode & 0o777,
  configMode: fs.statSync(config).mode & 0o777
}))
process.exit(23)
`, { mode: 0o700 })
  const result = await sshRoute('POST', ['sandboxes', 'demo', 'ssh-open'], {}, {
    env: { ...tools, PATH: `${root}:/usr/bin:/bin` },
    platform: 'darwin',
    loadContext: async () => ({ sandbox: ready(), target: remote, workspace: 'team' }),
    runOpenShell: async (args, options) => ({
      code: 0, stdout: `Host openshell-demo.${options.workspace}\n    User sandbox\n`,
    }),
    launchTerminal: async (command) => {
      const child = spawnSync('sh', ['-c', command], { env: { ...process.env, SSH_REPORT: report }, encoding: 'utf8' })
      assert.equal(child.status, 23, child.stderr)
    },
  })
  assert.deepEqual(result, { ok: true, mode: 'ssh' })
  const observed = JSON.parse(await readFile(report, 'utf8'))
  assert.equal(observed.args[0], '-F')
  assert.equal(observed.args[2], 'openshell-demo.team')
  assert.equal(observed.directoryMode, 0o700)
  assert.equal(observed.configMode, 0o600)
  assert.match(observed.config, /Host openshell-demo.team/)
  await assert.rejects(stat(path.dirname(observed.args[1])), { code: 'ENOENT' })
})

test('terminal launch failure removes the private config directory', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ssh-launch-failure-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await assert.rejects(sshRoute('POST', ['sandboxes', 'demo', 'ssh-open'], {}, {
    target: remote, env: tools, platform: 'darwin',
    tempDirectory: root,
    loadSandbox: async () => ready(),
    runOpenShell: async () => ({ code: 0, stdout: 'Host openshell-demo.default\n    User sandbox\n' }),
    launchTerminal: async () => { throw new Error('terminal denied') },
  }), /terminal denied/)
  assert.deepEqual(await readdir(root), [])
})

test('an emulator that exits before running the shell also removes the config', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ssh-emulator-failure-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  let closed
  let emulator
  await sshRoute('POST', ['sandboxes', 'demo', 'ssh-open'], {}, {
    target: remote, env: tools, platform: 'linux', tempDirectory: root,
    loadSandbox: async () => ready(),
    runOpenShell: async () => ({ code: 0, stdout: 'Host openshell-demo.default\n    User sandbox\n' }),
    spawnProcess: () => {
      emulator = spawn(process.execPath, ['-e', 'process.exit(17)'])
      closed = once(emulator, 'close')
      return emulator
    },
  })
  emulator.ref()
  assert.deepEqual(await closed, [17, null])
  assert.deepEqual(await readdir(root), [])
})
