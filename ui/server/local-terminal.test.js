import test from 'node:test'
import assert from 'node:assert/strict'
import { createTerminalQueue, terminalLaunchError } from './local-terminal.js'

test('only Automation denial is reported as an Automation permission issue', () => {
  assert.match(terminalLaunchError(new Error('failed'), 'Not authorized (-1743)'), /Automation/)
  assert.equal(terminalLaunchError(new Error('failed'), 'Invalid window (-1728)'), 'Could not open Terminal: Invalid window (-1728)')
  assert.equal(terminalLaunchError(new Error('spawn failed')), 'Could not open Terminal: spawn failed')
})

test('a timeout is reported separately from permissions', () => {
  assert.equal(terminalLaunchError({ killed: true }), 'Terminal took too long to respond. Check the new tab before trying again.')
})

test('overlapping launches wait for discovery and recover after a failed launch', async () => {
  const queue = createTerminalQueue()
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const events = []
  const first = queue(async () => { events.push('first'); await gate; throw new Error('denied') })
  const rejected = assert.rejects(first, /denied/)
  const second = queue(() => { events.push('second'); return 'opened' })
  await Promise.resolve()
  assert.deepEqual(events, ['first'])
  release()
  await rejected
  assert.equal(await second, 'opened')
  assert.deepEqual(events, ['first', 'second'])
})
