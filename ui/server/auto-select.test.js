import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)
const moduleUrl = new URL('./gateway.js', import.meta.url).href

// gateway.js reads its selection when it loads, so each case is a fresh process.
async function candidate(t, { active = 'local', context, env = {} } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'console-auto-select-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const config = path.join(root, 'openshell')
  await fs.mkdir(config, { recursive: true })
  if (active) await fs.writeFile(path.join(config, 'active_gateway'), active)
  if (context) await fs.writeFile(path.join(config, 'console-context.json'), JSON.stringify(context))
  const { stdout } = await run(process.execPath, ['--input-type=module', '-e', `import { unchosenCliGateway } from ${JSON.stringify(moduleUrl)}; console.log(JSON.stringify(unchosenCliGateway()))`], {
    env: { ...process.env, XDG_CONFIG_HOME: root, OPENSHELL_GATEWAY: '', OPENSHELL_WORKSPACE: '', ...env },
  })
  return JSON.parse(stdout)
}

test('a console nobody has pointed anywhere offers the CLI gateway', async t => {
  assert.equal(await candidate(t), 'local')
})

test('a saved, a cleared or an environment choice is never replaced', async t => {
  assert.equal(await candidate(t, { context: { gateway: 'other', workspace: 'default' } }), null)
  assert.equal(await candidate(t, { context: {} }), null)
  assert.equal(await candidate(t, { env: { OPENSHELL_GATEWAY: 'local' } }), null)
})

test('without a CLI gateway there is nothing to offer', async t => {
  assert.equal(await candidate(t, { active: null }), null)
})
