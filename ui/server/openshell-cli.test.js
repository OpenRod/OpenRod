import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { openshellBinary, runCli, runOpenShell, serializeCli } from './openshell-cli.js'

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'openshell-cli-test-'))
const fakeCli = path.join(dir, 'openshell')
await fs.writeFile(fakeCli, '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)))\n', { mode: 0o700 })
after(() => fs.rm(dir, { recursive: true, force: true }))

test('OpenShell arguments are separate and always pinned to the selected gateway', async () => {
  const env = { ...process.env, OPENSHELL_BIN: fakeCli }
  const result = await runOpenShell(['sandbox', 'exec', '--name', 'box; touch /tmp/no'], { gateway: 'remote-gw', env })
  assert.equal(result.code, 0)
  assert.deepEqual(JSON.parse(result.stdout), ['--gateway', 'remote-gw', 'sandbox', 'exec', '--name', 'box; touch /tmp/no'])
})

test('an explicit missing CLI does not fall back to another binary on PATH', () => {
  assert.equal(openshellBinary({ OPENSHELL_BIN: path.join(dir, 'missing'), PATH: process.env.PATH }), null)
})

test('captured process output is bounded', async () => {
  const result = await runCli(process.execPath, ['-e', 'process.stdout.write("x".repeat(100000))'], { outputLimit: 1024 })
  assert.equal(result.outputExceeded, true)
  assert.ok(Buffer.byteLength(result.stdout) <= 1024)
})

test('a timeout stops the CLI and every process it started', async () => {
  const pidFile = path.join(dir, 'child.pid')
  const result = await runCli('/bin/sh', ['-c', `sleep 30 & echo $! > '${pidFile}'; wait`], { timeoutMs: 300 })
  assert.equal(result.timedOut, true)
  const pid = Number(await fs.readFile(pidFile, 'utf8'))
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
})

test('serialized CLI mutations never overlap', async () => {
  let active = 0
  let peak = 0
  const operation = () => serializeCli(async () => {
    active += 1
    peak = Math.max(peak, active)
    await new Promise((resolve) => setTimeout(resolve, 20))
    active -= 1
  })
  await Promise.all([operation(), operation(), operation()])
  assert.equal(peak, 1)
})
