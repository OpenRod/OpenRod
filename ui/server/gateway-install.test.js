import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ensureGateway } from './gateway-install.js'

const supported = (process.platform === 'darwin' && process.arch === 'arm64') || (process.platform === 'linux' && ['arm64', 'x64'].includes(process.arch))

test('gateway download integrity failure never installs executable bytes and removes staging files', { skip: !supported }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gateway-install-test-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  t.mock.method(globalThis, 'fetch', async () => new Response('untrusted executable archive', { status: 200 }))
  await assert.rejects(ensureGateway({ directory, find: name => name === 'tar' ? '/usr/bin/tar' : null }), /checksum did not match/)
  await assert.rejects(fs.access(path.join(directory, 'openshell-gateway')), { code: 'ENOENT' })
  assert.deepEqual(await fs.readdir(directory), [])
})
