import test from 'node:test'
import assert from 'node:assert/strict'
import { connectionPlan } from './sandbox-session.js'

const sandbox = (extra = {}) => ({ name: 'demo', phase: 'ready', tty: false, labels: {}, ...extra })

test('a new native session is gateway-pinned and starts in its validated project folder', () => {
  const plan = connectionPlan(sandbox({ labels: {
    'openshell.console/session': 'shell',
    'openshell.console/project': 'my-repo',
  } }), { gateway: 'remote-gw' })
  assert.deepEqual(plan.argv, [
    '--gateway', 'remote-gw', 'sandbox', 'exec', '--name', 'demo',
    '--workdir', '/sandbox/my-repo', '--tty', '--', '/bin/bash', '-l',
  ])
  assert.equal(plan.workdir, '/sandbox/my-repo')
  assert.match(plan.command, /'--gateway' 'remote-gw'/)
})

test('gateway labels cannot inject a command or working directory', () => {
  const plan = connectionPlan(sandbox({
    name: "demo'; touch /tmp/no; echo '",
    labels: {
      'openshell.console/session': 'bash; id',
      'openshell.console/project': '../etc',
    },
  }), { gateway: "gw'; id; echo '" })
  assert.deepEqual(plan.argv.slice(-3), ['--', '/bin/bash', '-l'])
  assert.equal(plan.workdir, null)
  assert.ok(plan.command.includes("'demo'\\''; touch /tmp/no; echo '\\'''"))
  assert.ok(plan.command.includes("'gw'\\''; id; echo '\\'''"))
})

test('attach is available only for a canonical TTY process', () => {
  const plan = connectionPlan(sandbox({ tty: true }), { gateway: 'local', mode: 'attach' })
  assert.deepEqual(plan.argv, ['--gateway', 'local', 'sandbox', 'connect', 'demo'])
  assert.throws(() => connectionPlan(sandbox(), { gateway: 'local', mode: 'attach' }), /canonical TTY/)
  assert.throws(() => connectionPlan(sandbox(), { gateway: 'local', mode: 'other' }), /Unknown connection mode/)
})
