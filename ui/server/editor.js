import { spawn } from 'node:child_process'
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

// Every run of the CLI rewrites ~/.ssh/config and its own ssh_config with a
// plain truncating write, even when nothing changes, so two runs at once can
// lose the operator's hosts. Run them one at a time.
let queue = Promise.resolve()
function oneAtATime(task) {
  const run = queue.then(task, task)
  queue = run.catch(() => {})
  return run
}

const TIMEOUT_MS = 60000

// Before it launches the editor, the CLI probes the sandbox over ssh, and that
// probe has no timeout of its own. The CLI gets its own process group so a
// timeout also stops its ssh and ssh-proxy children.
export function runCli(cli, args, env, timeoutMs = TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const child = spawn(cli, args, { env, detached: true, stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    let timedOut = false
    child.stderr.on('data', (chunk) => { if (stderr.length < 65536) stderr += chunk })
    const timer = setTimeout(() => {
      timedOut = true
      try { process.kill(-child.pid, 'SIGTERM') } catch { /* already gone */ }
    }, timeoutMs)
    child.on('error', (error) => { clearTimeout(timer); reject(error) })
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stderr, timedOut }) })
  })
}

// Gateway errors come through miette as `code: '…', message: "…"`; the
// message part is the readable one.
export function reasonFrom(stderr) {
  const text = stderr.replace(/\x1b\[[0-9;]*m/g, '')
  const gateway = text.match(/message: "([^"]+)"/)?.[1]
  if (gateway) return gateway
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean)
  return (lines.find((line) => /^(error|×)/i.test(line)) ?? lines.at(-1))?.replace(/^error:\s*/i, '').replace(/^×\s*/, '')
}

async function openEditor(name, input) {
  const id = String(input?.editor ?? '')
  if (!Object.hasOwn(EDITORS, id)) throw fail('Unknown editor.')
  const { label } = EDITORS[id]
  const binary = editorBinary(id)
  if (!binary) throw fail(`${label} is not installed on this machine.`, 409)
  const cli = openshellBinary()
  if (!cli) throw fail('The openshell CLI is not installed on this machine.', 409)
  const args = ['sandbox', 'connect', name, '--editor', id, '--gateway', resolveGateway().name]
  // The editor app can start from this process tree and inherit its
  // environment, so change nothing unless the CLI can't find the editor.
  const dir = path.dirname(binary)
  const env = pathDirs().includes(dir) ? process.env : { ...process.env, PATH: [dir, process.env.PATH].filter(Boolean).join(path.delimiter) }
  const result = await oneAtATime(() => runCli(cli, args, env))
  if (result.timedOut) throw fail(`Opening ${label} timed out.`, 504)
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
