import assert from 'node:assert/strict'
import test from 'node:test'
import { autoOpen, nodeSupported, parseOptions, startConsole } from './cli.js'

test('requires Node.js 22.13 or newer', () => {
  for (const version of ['20.20.2', '22.12.0', '21.7.3', '18.20.4']) assert.equal(nodeSupported(version), false, version)
  for (const version of ['22.13.0', '22.23.3', '24.0.0', '25.2.1']) assert.equal(nodeSupported(version), true, version)
})

test('--open and --no-open override the automatic choice', () => {
  assert.equal(parseOptions([]).open, undefined)
  assert.equal(parseOptions(['--open']).open, true)
  assert.equal(parseOptions(['--no-open']).open, false)
  assert.throws(() => parseOptions(['--open', '--no-open']), /either --open or --no-open/)
})

test('opens the browser by default only where there is a screen to open on', () => {
  const desk = { env: {}, platform: 'darwin', tty: true }
  assert.equal(autoOpen(desk), true)
  assert.equal(autoOpen({ ...desk, platform: 'win32' }), true)
  assert.equal(autoOpen({ ...desk, env: { CI: 'false' } }), true)
  assert.equal(autoOpen({ ...desk, tty: false }), false)
  assert.equal(autoOpen({ ...desk, tty: undefined }), false)
  assert.equal(autoOpen({ ...desk, env: { CI: 'true' } }), false)
  assert.equal(autoOpen({ ...desk, env: { CI: '1' } }), false)
  assert.equal(autoOpen({ ...desk, env: { SSH_CONNECTION: '10.0.0.2 52000 10.0.0.1 22' } }), false)
  assert.equal(autoOpen({ ...desk, env: { SSH_TTY: '/dev/ttys004' } }), false)
  assert.equal(autoOpen({ ...desk, env: { SSH_CLIENT: '10.0.0.2 52000 22' } }), false)
  assert.equal(autoOpen({ ...desk, platform: 'freebsd' }), false)
  assert.equal(autoOpen({ ...desk, platform: 'freebsd', env: { DISPLAY: ':0' } }), true)
  assert.equal(autoOpen({ ...desk, platform: 'linux' }), false)
  assert.equal(autoOpen({ ...desk, platform: 'linux', env: { DISPLAY: ':0' } }), true)
  assert.equal(autoOpen({ ...desk, platform: 'linux', env: { WAYLAND_DISPLAY: 'wayland-0' } }), true)
})


test('CLI guard leaves authenticated terminal and SSH relays to the API and rejects unknown upgrades', async () => {
  const { rejectUnsupportedUpgrade } = await import('./cli.js')
  for (const url of ['/api/os/terminal?ticket=one', '/api/os/ssh?ticket=two', '/api/remote/os/terminal?ticket=three&owner=alice', '/api/remote/os/ssh?ticket=four&owner=alice']) {
    let destroyed = false
    rejectUnsupportedUpgrade({url}, {destroy(){destroyed=true}})
    assert.equal(destroyed, false, url)
  }
  for (const url of ['/api/remote/os/overview', '/api/remote/os/terminal/extra', '/unknown', undefined]) {
    let destroyed = false
    rejectUnsupportedUpgrade({url}, {destroy(){destroyed=true}})
    assert.equal(destroyed, true, url)
  }
})

test('the openrod command refuses cloud and worker modes instead of serving them without its launch token', async () => {
  const before = process.env.OPENROD_MODE
  try {
    for (const mode of ['cloud', 'worker']) {
      process.env.OPENROD_MODE = mode
      await assert.rejects(startConsole({ port: 0 }), /local console/)
    }
  } finally {
    if (before === undefined) delete process.env.OPENROD_MODE
    else process.env.OPENROD_MODE = before
  }
})
