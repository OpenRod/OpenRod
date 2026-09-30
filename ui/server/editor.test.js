import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { editorRoute, reasonFrom, runCli } from './editor.js'

test('a timeout stops the CLI and every process it started', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'editor-test-'))
  const pidFile = path.join(dir, 'child.pid')
  const result = await runCli('/bin/sh', ['-c', `sleep 30 & echo $! > '${pidFile}'; wait`], process.env, 300)
  assert.equal(result.timedOut, true)
  const pid = Number(fs.readFileSync(pidFile, 'utf8'))
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
  fs.rmSync(dir, { recursive: true, force: true })
})

test('errors show the gateway message, or the CLI line without its prefix', () => {
  assert.equal(reasonFrom(`Error:   × status: NotFound, code: 'Some requested entity was not found', message: "sandbox not found"\n`), 'sandbox not found')
  assert.equal(reasonFrom('\x1b[31mError:\x1b[0m   × cursor is not installed or not on PATH\n'), 'cursor is not installed or not on PATH')
})

test('a request without a known editor is refused before anything runs', async () => {
  for (const input of [null, {}, { editor: '__proto__' }, { editor: 'emacs' }]) {
    await assert.rejects(editorRoute('POST', ['sandboxes', 'demo', 'editor'], input), { status: 400 })
  }
})
