import test from 'node:test'
import assert from 'node:assert/strict'
import { editorDirs, editorRoute, ensureRemoteSsh, ensureVscodeAccess } from './editor.js'
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

test('opening VS Code adds the download rule to a sandbox that lacks it, after checking it can download', async () => {
  const calls = [], scripts = []
  const policy = async (method, parts, input) => {
    calls.push([method, parts.join('/'), input])
    return method === 'GET' ? { effective: { rules: [{ name: 'agent-claude' }] } } : { version: 2 }
  }
  await ensureVscodeAccess('demo', { policy, exec: async (script) => { scripts.push(script); return 'downloaders: curl\n' } })
  assert.deepEqual(calls.map(([method, path]) => `${method} ${path}`), ['GET policy/demo', 'POST policy/demo/ops'])
  const [rule] = calls[1][2].ops.map((op) => (assert.equal(op.kind, 'addRule'), op.rule))
  assert.equal(rule.name, 'tool-vscode-server')
  assert.deepEqual(rule.endpoints.map((endpoint) => endpoint.host), ['update.code.visualstudio.com', 'vscode.download.prss.microsoft.com'])
  assert(rule.endpoints.every((endpoint) => endpoint.ports.join() === '443' && endpoint.allow.every((allow) => allow.method === 'GET')))
  assert.deepEqual(rule.binaries, ['/usr/bin/curl', '/usr/bin/wget', '/sandbox/.vscode-server/**'])
  assert.equal(scripts.length, 1)
  assert.match(scripts[0], /command -v curl/)
  assert.match(scripts[0], /command -v wget/)
  assert.match(scripts[0], /\$HOME\/\.wgetrc/)
  assert.match(scripts[0], /ca_certificate/)
})

test('a sandbox that already has the rule is not changed, and an unreadable sandbox does not stop VS Code', async () => {
  const calls = []
  const policy = async (method) => { calls.push(method); return { effective: { rules: [{ name: 'tool-vscode-server' }] } } }
  await ensureVscodeAccess('demo', { policy, exec: async () => { throw new Error('exec failed') } })
  await ensureVscodeAccess('demo', { policy, exec: async () => 'garbled' })
  assert.deepEqual(calls, ['GET', 'GET'])
})

test('a sandbox with neither curl nor wget is refused with a clear reason and left unchanged', async () => {
  const calls = []
  const policy = async (method) => { calls.push(method); return { effective: { rules: [] } } }
  await assert.rejects(ensureVscodeAccess('demo', { policy, exec: async () => 'downloaders:\n' }), { status: 409, message: /neither curl nor wget/ })
  assert.deepEqual(calls, [])
})

test('a refused rule, such as one the organization blocks, is reported and not hidden', async () => {
  const policy = async (method) => {
    if (method === 'GET') return { effective: { rules: [] } }
    throw Object.assign(new Error('update.code.visualstudio.com is blocked by organization policy (*.visualstudio.com).'), { status: 403 })
  }
  await assert.rejects(ensureVscodeAccess('demo', { policy, exec: async () => 'downloaders: curl' }), { status: 403, message: /blocked by organization policy/ })
})
test('an editor app bundle is searched before PATH, so Cursor\'s `code` command is never mistaken for VS Code', () => {
  const dirs = editorDirs('vscode', { home: '/Users/me', pathValue: '/usr/bin:/Applications/Cursor.app/Contents/Resources/app/bin' })
  assert.deepEqual(dirs, [
    '/Applications/Visual Studio Code.app/Contents/Resources/app/bin',
    '/Users/me/Applications/Visual Studio Code.app/Contents/Resources/app/bin',
    '/usr/bin',
    '/Applications/Cursor.app/Contents/Resources/app/bin',
  ])
})
