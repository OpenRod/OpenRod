import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {createHash} from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { createSessionRevocations } from './session-revocations.js'

test('logout revocations survive restart without retaining plaintext cookies', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'openrod-sessions-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const file = path.join(directory, 'sessions.sqlite')
  let store = createSessionRevocations(file)
  store.add('private-session-cookie', Date.now() + 3600000)
  store.add('expired-session-cookie', Date.now() - 1)
  store.close()
  store = createSessionRevocations(file)
  assert.equal(store.has('private-session-cookie'), true)
  assert.equal(store.hasDigest(createHash('sha256').update('private-session-cookie').digest('hex')), true)
  assert.equal(store.has('expired-session-cookie'), false)
  assert.equal(store.has('another-session-cookie'), false)
  store.close()
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  assert.equal(fs.readFileSync(file).includes(Buffer.from('private-session-cookie')), false)
})
