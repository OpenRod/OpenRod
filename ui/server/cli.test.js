import assert from 'node:assert/strict'
import test from 'node:test'
import { autoOpen, nodeSupported, parseOptions } from './cli.js'

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
  assert.equal(autoOpen({ ...desk, platform: 'linux' }), false)
  assert.equal(autoOpen({ ...desk, platform: 'linux', env: { DISPLAY: ':0' } }), true)
  assert.equal(autoOpen({ ...desk, platform: 'linux', env: { WAYLAND_DISPLAY: 'wayland-0' } }), true)
})
