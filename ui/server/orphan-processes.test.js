import test from 'node:test'
import assert from 'node:assert/strict'
import { findOrphans } from './orphan-processes.js'

const stateRoot = '/home/me/.local/state/openshell-console'
const ssh = '/usr/bin/ssh -T -o BatchMode=yes -N -o ExitOnForwardFailure=yes -o ControlMaster=no -o StreamLocalBindMask=0177 -L /tmp/os-ssh-AbC123/docker.sock:/var/run/docker.sock -R 127.0.0.1:49890:127.0.0.1:49890 aws-ec2'
const gateway = `/opt/homebrew/bin/openshell-gateway --config ${stateRoot}/remote-gateways/console-ssh-a4038031444f69f4c0ffbe10/gateway.toml`

test('finds the tunnel and gateway left behind by a dead console', () => {
  const found = findOrphans(`  101     1 ${ssh}\n  102     1 ${gateway}\n`, { stateRoot })
  assert.deepEqual(found.map(({ pid, kind }) => [pid, kind]), [[101, 'tunnel'], [102, 'gateway']])
})

test('leaves a live console\'s children alone', () => {
  assert.deepEqual(findOrphans(`  101   500 ${ssh}\n  102   500 ${gateway}\n`, { stateRoot }), [])
})

test('ignores the user\'s own ssh sessions and unrelated gateways', () => {
  const other = '/opt/homebrew/bin/openshell-gateway --config /home/me/.config/openshell/gateway.toml'
  assert.deepEqual(findOrphans(`  7     1 ssh aws-ec2\n  8     1 /usr/bin/ssh -R 127.0.0.1:1:127.0.0.1:1 host\n  9     1 ${other}\n`, { stateRoot }), [])
})
