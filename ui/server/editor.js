import os from 'node:os'
import path from 'node:path'
import { findExecutable, reasonFrom, runCli, runOpenShell, serializeCli } from './openshell-cli.js'
import { gateway } from './gateway.js'
import { agentAccessRules } from '../shared/agent-access.js'
import { policyRoute } from './policy.js'
import { OPENSHELL_CA_BUNDLE } from '../src/lib/image-templates.js'

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
// PATH after "Install 'cursor' command in PATH", so look there too. The
// bundle comes first: Cursor installs a `code` command of its own, so a bare
// `code` on PATH can be Cursor, not VS Code.
export function editorDirs(id, { home = os.homedir(), pathValue = process.env.PATH ?? '' } = {}) {
  const { app } = EDITORS[id]
  const bundles = ['/Applications', path.join(home, 'Applications')].map((root) => path.join(root, app, 'Contents/Resources/app/bin'))
  return [...bundles, ...pathValue.split(path.delimiter).filter(Boolean)]
}
function editorBinary(id) {
  return findExecutable(EDITORS[id].binary, editorDirs(id))
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

// VS Code's Remote - SSH downloads its server from inside the sandbox, which
// sandboxes block by default. Make sure this sandbox has the reviewed
// GET-only rule for VS Code's two download hosts before opening it, whichever
// way the sandbox was created. Idempotent, so it costs one read once present.
const VSCODE_RULE = 'tool-vscode-server'
// The download needs curl or wget inside the sandbox; the editor's fallback of
// sending the archive over scp does not work through OpenShell's SSH proxy, so
// without either tool it waits forever. wget is tried first and ignores the CA
// variables curl uses. The sandbox user cannot write /etc, so trust the CA in
// ~/.wgetrc, and only where wget exists. Prints which downloaders exist.
const prepareScript = `d=''
command -v curl >/dev/null 2>&1 && d="$d curl"
if command -v wget >/dev/null 2>&1; then
  d="$d wget"
  grep -qs '^[[:space:]]*ca_certificate' /etc/wgetrc "$HOME/.wgetrc" 2>/dev/null || printf 'ca_certificate = %s\\n' '${OPENSHELL_CA_BUNDLE}' >> "$HOME/.wgetrc"
fi
echo "downloaders:$d"`
export async function ensureVscodeAccess(name, { policy = policyRoute, exec } = {}) {
  // Best effort: if the sandbox can't be asked, let the editor try anyway.
  const found = await Promise.resolve(exec?.(prepareScript)).then((out) => /downloaders:(.*)/.exec(String(out ?? ''))?.[1], () => undefined)
  if (found !== undefined && !found.trim()) throw fail(`${name} has neither curl nor wget, which VS Code needs to install its server in the sandbox. Use an image that includes curl, for example by building the template with the VS Code Server choice.`, 409)
  const view = await policy('GET', ['policy', name])
  if (!(view?.effective?.rules ?? []).some((rule) => rule.name === VSCODE_RULE)) {
    const [rule] = agentAccessRules({ source: 'build', agents: [], runtimes: ['vscode'] })
    await policy('POST', ['policy', name, 'ops'], { ops: [{ kind: 'addRule', rule }] })
  }
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
  if (id === 'vscode') {
    await ensureVscodeAccess(name, {
      exec: async (script) => (await runOpenShell(['sandbox', 'exec', '-n', name, '--timeout', '15', '--no-tty', '--', 'sh', '-c', script], { gateway: target.name, workspace, timeoutMs: 20_000 })).stdout,
    })
  }
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
