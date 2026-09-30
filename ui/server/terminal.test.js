import test from 'node:test'
import assert from 'node:assert/strict'
import { controlOf, createTickets, dimension, planSession } from './terminal.js'

const ready = (labels = {}, extra = {}) => ({ name: 'box', phase: 'ready', tty: false, labels, ...extra })

test('the default session is what the sandbox was created for, else a shell', () => {
  assert.equal(planSession(ready({ 'openshell.console/session': 'claude' })).session, 'claude')
  assert.deepEqual(planSession(ready({ 'openshell.console/session': 'claude' })).argv, ['claude'])
  assert.deepEqual(planSession(ready({ 'openshell.console/session': 'shell' })).argv, ['/bin/bash', '-l'])
  assert.equal(planSession(ready({}, { tty: true })).session, 'shell')
  assert.equal(planSession(ready({ 'openshell.console/session': 'rm -rf /' })).session, 'shell')
})

test('the page may pick a shell or a known agent, nothing else', () => {
  assert.equal(planSession(ready(), { session: 'codex' }).session, 'codex')
  assert.equal(planSession(ready(), { session: '' }).session, 'shell')
  for (const session of ['/bin/sh', 'claude; id', '__proto__', 'toString', 42]) {
    assert.throws(() => planSession(ready(), { session }), { message: 'Unknown session.', status: 400 })
  }
  assert.throws(() => planSession({ ...ready(), phase: 'stopped' }), { status: 409 })
})

test('the working directory follows the validated project label', () => {
  assert.equal(planSession(ready({ 'openshell.console/project': 'my-repo' })).workdir, '/sandbox/my-repo')
  assert.equal(planSession(ready({ 'openshell.console/project': '../etc' })).workdir, '')
  assert.equal(planSession(ready()).workdir, '')
})

test('terminal sizes are bounded integers', () => {
  assert.equal(dimension(120, 80), 120)
  assert.equal(planSession(ready(), { cols: 0, rows: 5000 }).cols, 80)
  assert.equal(planSession(ready(), { cols: '100', rows: 24.5 }).rows, 24)
  assert.equal(planSession(ready(), { cols: -1 }).cols, 80)
})

test('a ticket opens one socket, within its lifetime', () => {
  let clock = 1000
  const tickets = createTickets({ ttl: 500, now: () => clock })
  const ticket = tickets.issue({ name: 'box' })
  assert.equal(tickets.claim('not-a-ticket'), null)
  assert.equal(tickets.claim(undefined), null)
  assert.equal(tickets.claim(ticket)?.name, 'box')
  assert.equal(tickets.claim(ticket), null, 'second use is refused')
  const late = tickets.issue({ name: 'box' })
  clock += 600
  assert.equal(tickets.claim(late), null, 'expired')
  assert.equal(tickets.size, 0)
})

test('frames from the page: bytes are input, resize is checked, the rest is dropped', () => {
  assert.equal(controlOf(Buffer.from('ls\n'), true).type, 'stdin')
  assert.deepEqual(controlOf(Buffer.from('{"type":"resize","cols":120,"rows":40}'), false), { type: 'resize', cols: 120, rows: 40 })
  assert.deepEqual(controlOf(Buffer.from('{"type":"resize","cols":"x","rows":-1}'), false), { type: 'resize', cols: 0, rows: 0 })
  assert.equal(controlOf(Buffer.from('{"type":"stdin","data":"ls"}'), false), null, 'text frames never reach stdin')
  assert.equal(controlOf(Buffer.from('not json'), false), null)
})
