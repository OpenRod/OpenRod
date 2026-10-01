import os from 'node:os'
import path from 'node:path'
import { findExecutable, reasonFrom, runCli, runOpenShell, serializeCli } from './openshell-cli.js'
import { gateway } from './gateway.js'

// "Open in Cursor / VS Code" runs the command the CLI documents for it,
// `openshell sandbox connect <name> --editor <editor>`. OpenShell installs its
// managed SSH config (one Include line in ~/.ssh/config plus a Host block in
// ~/.config/openshell/ssh_config) and starts the editor's Remote-SSH session.
// The console runs on the operator's machine, so the editor opens there.

const EDITORS = {
  cursor: { label: 'Cursor', binary: 'cursor', app: 'Cursor.app', remoteSsh: 'anysphere.remote-ssh' },
  vscode: { label: 'VS Code', binary: 'code', app: 'Visual Studio Code.app', remoteSsh: 'ms-vscode-remote.remote-ssh' },
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

// Neither editor ships its Remote - SSH extension. Without it the editor opens
// and then fails with "No remote extension installed to resolve ssh-remote".
export async function ensureRemoteSsh(binary, { label, remoteSsh }, env, run = runCli) {
  const listed = await run(binary, ['--list-extensions'], { env, timeoutMs: 30_000 })
  if (listed.code === 0 && listed.stdout.split('\n').some((line) => line.trim().toLowerCase() === remoteSsh)) return
  const installed = await run(binary, ['--install-extension', remoteSsh], { env, timeoutMs: 120_000 })
  if (installed.code !== 0 || installed.timedOut) throw fail(`${label} needs its Remote - SSH extension (${remoteSsh}). Install it from ${label}’s Extensions view, then try again.`, 502)
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
  const { target, workspace } = await gateway()
  // The editor only reports an unreachable sandbox as a generic SSH failure,
  // so check the sandbox answers first and show the gateway's reason here.
  const probe = await runOpenShell(['sandbox', 'exec', '-n', name, '--timeout', '15', '--no-tty', '--', 'true'], { gateway: target.name, workspace, timeoutMs: 20_000 })
  if (probe.timedOut) throw fail(`${name} did not respond.`, 504)
  if (probe.code !== 0) throw fail(reasonFrom(probe.stderr) || `${name} is not reachable.`, 409)
  const result = await serializeCli(async () => {
    await ensureRemoteSsh(binary, EDITORS[id], env)
    return runOpenShell(args, { env, gateway: target.name, workspace })
  })
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
