import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { claimCloudAnnouncement } from './announcements.js'

test('announcement is claimed once across concurrent launches and separately per user', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'openrod-announcement-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const results = await Promise.all(Array.from({ length: 5 }, () => claimCloudAnnouncement({ directory })))
  assert.equal(results.filter(result => result.show).length, 1)
  assert.deepEqual(await claimCloudAnnouncement({ directory }), { show: false })
  assert.deepEqual(await claimCloudAnnouncement({ directory, user: 'another-user' }), { show: true })
})

test('announcement stays unclaimed while cloud is unavailable', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'openrod-announcement-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  assert.deepEqual(await claimCloudAnnouncement({ directory, available: false }), { show: false })
  assert.deepEqual(await fs.readdir(directory), [])
  assert.deepEqual(await claimCloudAnnouncement({ directory }), { show: true })
})
