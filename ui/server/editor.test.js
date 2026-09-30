import test from 'node:test'
import assert from 'node:assert/strict'
import { editorRoute } from './editor.js'
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
