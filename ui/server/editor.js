import os from 'node:os'
import path from 'node:path'
import { findExecutable, reasonFrom, runOpenShell, serializeCli } from './openshell-cli.js'
import { gateway } from './gateway.js'

// "Open in Cursor / VS Code" runs the command the CLI documents for it,
// `openshell sandbox connect <name> --editor <editor>`. OpenShell installs its
// managed SSH config (one Include line in ~/.ssh/config plus a Host block in
// ~/.config/openshell/ssh_config) and starts the editor's Remote-SSH session.
// The console runs on the operator's machine, so the editor opens there.

const EDITORS = {
  cursor: { label: 'Cursor', binary: 'cursor', app: 'Cursor.app' },
  vscode: { label: 'VS Code', binary: 'code', app: 'Visual Studio Code.app' },
}

const NAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/
const fail = (message, status = 400) => Object.assign(new Error(message), { status })
// On macOS the editor's command lives inside the app bundle and is only on
// PATH after "Install 'cursor' command in PATH", so look there too.
function editorBinary(id) {
  const { binary, app } = EDITORS[id]
  const bundles = ['/Applications', path.join(os.homedir(), 'Applications')]
    .map((root) => path.join(root, app, 'Contents/Resources/app/bin'))
  const dirs = [...(process.env.PATH ?? '').split(path.delimiter).filter(Boolean), ...bundles]
  return findExecutable(binary, dirs)
}
function listEditors() {
  return Object.entries(EDITORS).map(([id, editor]) => ({ id, label: editor.label, installed: Boolean(editorBinary(id)) }))
}

async function openEditor(name, input) {
  const id = String(input?.editor ?? '')
  if (!Object.hasOwn(EDITORS, id)) throw fail('Unknown editor.')
  const { label } = EDITORS[id]
  const binary = editorBinary(id)
  if (!binary) throw fail(`${label} is not installed on this machine.`, 409)
  const args = ['sandbox', 'connect', name, '--editor', id]
  // The editor app can start from this process tree and inherit its
  // environment, so change nothing unless the CLI can't find the editor.
  const dir = path.dirname(binary)
  const pathDirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)
  const env = pathDirs.includes(dir) ? process.env : { ...process.env, PATH: [dir, process.env.PATH].filter(Boolean).join(path.delimiter) }
  const { target } = await gateway()
  const result = await serializeCli(() => runOpenShell(args, { env, gateway: target.name }))
  if (result.timedOut) throw fail(`Opening ${label} timed out.`, 504)
  if (result.outputExceeded) throw fail(`Opening ${label} produced too much output.`, 502)
  if (result.code !== 0) throw fail(reasonFrom(result.stderr) || `Could not open ${label}.`, 502)
  return { ok: true, editor: id }
}

export async function editorRoute(method, parts, input) {
  if (method === 'GET' && parts.length === 1 && parts[0] === 'editors') return listEditors()
  if (method === 'POST' && parts[0] === 'sandboxes' && parts.length === 3 && NAME.test(parts[1]) && parts[2] === 'editor') {
    return openEditor(parts[1], input)
  }
  return undefined
}
