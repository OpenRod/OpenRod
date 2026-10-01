import test from 'node:test'
import assert from 'node:assert/strict'
import { editorRoute, ensureRemoteSsh } from './editor.js'
import { reasonFrom } from './openshell-cli.js'

test('errors show the gateway message, or the CLI line without its prefix', () => {
  assert.equal(reasonFrom(`Error:   × status: NotFound, code: 'Some requested entity was not found', message: "sandbox not found"\n`), 'sandbox not found')
  assert.equal(reasonFrom('\x1b[31mError:\x1b[0m   × cursor is not installed or not on PATH\n'), 'cursor is not installed or not on PATH')
})

test('a request without a known editor is refused before anything runs', async () => {
  for (const input of [null, {}, { editor: '__proto__' }, { editor: 'emacs' }]) {
    await assert.rejects(editorRoute('POST', ['sandboxes', 'demo', 'editor'], input), { status: 400 })
  }
})

test('the Remote - SSH extension is installed only when the editor lacks it', async () => {
  const editor = { label: 'Cursor', remoteSsh: 'anysphere.remote-ssh' }
  const runner = (listed, installCode = 0) => {
    const calls = []
    const run = async (binary, args) => {
      calls.push(args)
      return args[0] === '--list-extensions' ? { code: 0, stdout: listed } : { code: installCode, stdout: '' }
    }
    return { calls, run }
  }

  const present = runner('ms-python.python\nAnysphere.Remote-SSH\n')
  await ensureRemoteSsh('cursor', editor, {}, present.run)
  assert.deepEqual(present.calls, [['--list-extensions']])

  const missing = runner('ms-python.python\n')
  await ensureRemoteSsh('cursor', editor, {}, missing.run)
  assert.deepEqual(missing.calls, [['--list-extensions'], ['--install-extension', 'anysphere.remote-ssh']])

  await assert.rejects(ensureRemoteSsh('cursor', editor, {}, runner('', 1).run), { status: 502, message: /anysphere\.remote-ssh/ })
})
