import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

test('forgetting a disconnected SSH location removes it from the snapshot and from disk', { timeout: 15000 }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'console-forget-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const state = path.join(root, 'state')
  const file = path.join(state, 'remote-gateways', 'last-location.json')
  await fs.mkdir(path.dirname(file), { recursive: true })
  const remote = { host: 'aws-ec2', gateway: 'console-ssh-0123456789abcdef01234567', workspace: 'default', status: 'disconnected', error: null }
  await fs.writeFile(file, JSON.stringify({ returnContext: null, remote }))
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs/promises'
    import { createRemoteConnections } from ${JSON.stringify(new URL('./remote-gateway.js', import.meta.url).href)}
    const connections = createRemoteConnections({ logger: { warn() {} } })
    const before = (await connections.locationSnapshot()).remote
    await connections.forget()
    const after = (await connections.locationSnapshot()).remote
    console.log(JSON.stringify({ before, after, saved: JSON.parse(await fs.readFile(${JSON.stringify(file)}, 'utf8')) }))
    await connections.close()
  `], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: { ...process.env, XDG_CONFIG_HOME: path.join(root, 'config'), OPENSHELL_GATEWAY: '', OPENSHELL_WORKSPACE: '', OPENSHELL_CONSOLE_DATA_DIR: state },
    timeout: 10000,
  })
  const result = JSON.parse(stdout)
  assert.equal(result.before.host, 'aws-ec2')
  assert.equal(result.after, null)
  assert.equal(result.saved.remote, null)
})
