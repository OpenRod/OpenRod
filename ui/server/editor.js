import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveGateway } from './gateway.js'

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

function findExecutable(binary, dirs) {
  for (const dir of dirs) {
    const file = path.join(dir, binary)
    try { fs.accessSync(file, fs.constants.X_OK); return file } catch { /* next */ }
  }
  return null
}

const pathDirs = () => (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)

// On macOS the editor's command lives inside the app bundle and is only on
// PATH after "Install 'cursor' command in PATH", so look there too.
function editorBinary(id) {
  const { binary, app } = EDITORS[id]
  const bundles = ['/Applications', path.join(os.homedir(), 'Applications')]
    .map((root) => path.join(root, app, 'Contents/Resources/app/bin'))
  return findExecutable(binary, [...pathDirs(), ...bundles])
}

function openshellBinary() {
  return findExecutable('openshell', [...pathDirs(), '/opt/homebrew/bin', '/usr/local/bin', path.join(os.homedir(), '.local/bin')])
}

function listEditors() {
  return Object.entries(EDITORS).map(([id, editor]) => ({ id, label: editor.label, installed: Boolean(editorBinary(id)) }))
}

async function openEditor(name, input) {
  const id = String(input.editor ?? '')
  if (!EDITORS[id]) throw fail('Unknown editor.')
  const binary = editorBinary(id)
  if (!binary) throw fail(`${EDITORS[id].label} is not installed on this machine.`, 409)
  const cli = openshellBinary()
  if (!cli) throw fail('The openshell CLI is not installed on this machine.', 409)
  const args = ['sandbox', 'connect', name, '--editor', id, '--gateway', resolveGateway().name]
  // The CLI looks the editor up on PATH, so put the one found above first.
  const env = { ...process.env, PATH: [path.dirname(binary), process.env.PATH].filter(Boolean).join(path.delimiter), NO_COLOR: '1' }
  await new Promise((resolve, reject) => {
    execFile(cli, args, { env, timeout: 60000 }, (error, _stdout, stderr) => {
      if (!error) return resolve()
      const lines = String(stderr).replace(/\x1b\[[0-9;]*m/g, '').split('\n').map((line) => line.trim()).filter(Boolean)
      const reason = (lines.find((line) => /^(error|×)/i.test(line)) ?? lines.at(-1))?.replace(/^error:\s*/i, '').replace(/^×\s*/, '')
      reject(fail(error.killed ? `Opening ${EDITORS[id].label} timed out.` : reason || `Could not open ${EDITORS[id].label}.`, 502))
    })
  })
  return { ok: true, editor: id }
}

export async function editorRoute(method, parts, input) {
  if (method === 'GET' && parts.length === 1 && parts[0] === 'editors') return listEditors()
  if (method === 'POST' && parts[0] === 'sandboxes' && parts.length === 3 && NAME.test(parts[1]) && parts[2] === 'editor') {
    return openEditor(parts[1], input)
  }
  return undefined
}
