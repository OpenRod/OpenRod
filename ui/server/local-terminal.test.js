import test from 'node:test'
import assert from 'node:assert/strict'
import { terminalLaunchError } from './local-terminal.js'

test('only Automation denial is reported as an Automation permission issue', () => {
  assert.match(terminalLaunchError(new Error('failed'), 'Not authorized (-1743)'), /Automation/)
  assert.equal(terminalLaunchError(new Error('failed'), 'Invalid window (-1728)'), 'Could not open Terminal: Invalid window (-1728)')
  assert.equal(terminalLaunchError(new Error('spawn failed')), 'Could not open Terminal: spawn failed')
})

test('a timeout is reported separately from permissions', () => {
  assert.equal(terminalLaunchError({ killed: true }), 'Terminal took too long to respond. Check the new window before trying again.')
})
