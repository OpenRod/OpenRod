import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { connectionView, launchNativeTerminal } from './ssh.js'
import { findExecutable, sshBinary, shellQuote, fail } from './openshell-cli.js'
import { projectOf } from '../src/lib/sandbox-session.js'
import { readJson, responseJson } from './remote-http.js'
import { validateHostKeys } from './cloud-ssh.js'
import { cloudOrigin } from './cloud-origin.js'

const NAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/
const EDITORS = { cursor: { label: 'Cursor', binary: 'cursor', app: 'Cursor.app' }, vscode: { label: 'VS Code', binary: 'code', app: 'Visual Studio Code.app' } }
const ownerId = uid => createHash('sha256').update(uid).digest('hex').slice(0, 16)
// SSH config quoted values and ProxyCommand percent expansion need distinct
// escaping; neither ever contains a grant, gateway credential, or SSH secret.
const configQuote = value => `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
const proxyQuote = value => shellQuote(String(value).replaceAll('%', '%%'))
const scopedTarget = (target, context) => context ? `${target}?${new URLSearchParams({ context, location: '1' })}` : target

async function readManaged(file) {
  try {
    const stat = await fs.lstat(file)
    if (!stat.isFile() || stat.isSymbolicLink()) throw fail('OpenRod SSH config must be a regular file.', 409)
    return await fs.readFile(file, 'utf8')
  } catch (error) { if (error.code === 'ENOENT') return ''; throw error }
}
async function writeManaged(file, text) {
  await readManaged(file)
  const temp = `${file}.${randomUUID()}.tmp`
  try { await fs.writeFile(temp, text, { mode: 0o600, flag: 'wx' }); await fs.rename(temp, file) }
  finally { await fs.rm(temp, { force: true }) }
}
function launchEditor(file, args, { spawnProcess = spawn } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(file, args, { shell: false, detached: true, stdio: 'ignore' })
    child.once('error', () => reject(fail('Could not launch the editor.', 502)))
    child.once('spawn', () => { child.unref(); resolve() })
  })
}

export function createLocalCloudNative(dependencies = {}) {
  const home = dependencies.home ?? os.homedir(), env = dependencies.env ?? process.env
  const platform = dependencies.platform ?? process.platform
  const directory = path.join(home, '.config/openrod'), configFile = path.join(directory, 'cloud_ssh_config'), hostsFile = path.join(directory, 'cloud_known_hosts')
  const helper = dependencies.helper ?? fileURLToPath(new URL('./cloud-ssh-proxy.cjs', import.meta.url)), node = dependencies.node ?? process.execPath
  let queue = Promise.resolve()
  const serial = task => { const result = queue.then(task, task); queue = result.catch(() => {}); return result }
  const findEditor = dependencies.findEditor ?? (id => {
    const editor = EDITORS[id]
    return findExecutable(editor.binary, [...(env.PATH ?? '').split(path.delimiter).filter(Boolean), ...['/Applications', path.join(home, 'Applications')].map(root => path.join(root, editor.app, 'Contents/Resources/app/bin'))])
  })
  const aliasFor = (uid, name, context) => `openrod-cloud-${ownerId(uid)}-${name}${context ? '-' + ownerId(context) : ''}`
  const commandFor = alias => `${shellQuote(sshBinary(env) ?? 'ssh')} -F ${shellQuote(configFile)} ${shellQuote(alias)}`

  const assertActive = (services, grant) => { if (services.connection() !== grant) throw fail('Cloud connection changed. Open the sandbox from OpenRod again.', 403) }
  async function install(name, origin, services, grant, requestedContext) {
    assertActive(services, grant)
    const owner = grant.user.uid
    const ticket = await services.call(scopedTarget(`/os/sandboxes/${name}/ssh-ticket`, requestedContext), { method: 'POST', body: {} })
    const keys = validateHostKeys(ticket.hostKeys)
    const context = requestedContext ?? ticket.context
    if (requestedContext && ticket.context !== requestedContext) throw fail('Cloud workspace changed. Open the sandbox from OpenRod again.', 409)
    const alias = aliasFor(owner, name, context)
    assertActive(services, grant)
    const config = [
      `Host ${alias}`, `  HostName ${alias}`, '  User sandbox', '  StrictHostKeyChecking yes',
      `  UserKnownHostsFile ${configQuote(hostsFile)}`, '  GlobalKnownHostsFile /dev/null',
      '  CheckHostIP no', '  UpdateHostKeys no', '  IdentityAgent none', '  IdentitiesOnly yes',
      '  PubkeyAuthentication no', '  PasswordAuthentication no', '  KbdInteractiveAuthentication no',
      '  ControlMaster no', '  ServerAliveInterval 15', '  ServerAliveCountMax 3',
      `  ProxyCommand ${[node, helper, '--origin', origin, '--sandbox', name, '--owner', ownerId(owner), ...(context ? ['--context', context] : [])].map(proxyQuote).join(' ')}`,
    ].join('\n') + '\n'
    await serial(async () => {
      assertActive(services, grant)
      await fs.mkdir(directory, { recursive: true, mode: 0o700 })
      const stat = await fs.lstat(directory)
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw fail('OpenRod SSH directory must be a regular directory.', 409)
      await fs.chmod(directory, 0o700)
      const oldHosts = await readManaged(hostsFile)
      assertActive(services, grant)
      await writeManaged(hostsFile, oldHosts.split('\n').filter(line => line && !line.startsWith(`${alias} `)).concat(keys.map(key => `${alias} ${key}`)).join('\n') + '\n')
      const begin = `# OpenRod Cloud ${alias}\n`, end = `# End OpenRod Cloud ${alias}\n`
      let oldConfig = await readManaged(configFile)
      const start = oldConfig.indexOf(begin), finish = start < 0 ? -1 : oldConfig.indexOf(end, start)
      if (start >= 0 && finish < 0) throw fail('OpenRod SSH config has an incomplete managed entry.', 409)
      if (start >= 0) oldConfig = oldConfig.slice(0, start) + oldConfig.slice(finish + end.length)
      assertActive(services, grant)
      await writeManaged(configFile, oldConfig + begin + config + end)
      await fs.mkdir(path.join(home, '.ssh'), { recursive: true, mode: 0o700 })
      const userConfig = path.join(home, '.ssh/config'), oldUser = await readManaged(userConfig)
      const include = `Include ${configQuote(configFile)}`
      assertActive(services, grant)
      if (!oldUser.split('\n').includes(include)) await writeManaged(userConfig, `${include}\n${oldUser}`)
    })
    assertActive(services, grant)
    return { ticket, alias, config, command: commandFor(alias) }
  }

  return async function localCloudNative(req, res, target, services) {
    const url = new URL(target, 'http://local'), parts = url.pathname.slice('/api/os/'.length).split('/')
    if (req.method === 'GET' && parts.length === 1 && parts[0] === 'editors') {
      responseJson(res, 200, Object.entries(EDITORS).map(([id, editor]) => ({ id, label: editor.label, installed: Boolean(findEditor(id)) }))); return true
    }
    if (parts[0] !== 'sandboxes' || parts.length !== 3 || !NAME.test(parts[1] ?? '') || !['ssh', 'ssh-open', 'ssh-config', 'ssh-ticket', 'editor'].includes(parts[2])) return false
    const [, name, action] = parts
    if (action === 'ssh' ? req.method !== 'GET' : req.method !== 'POST') return false
    const input = req.method === 'POST' ? await readJson(req) : {}
    const context = req.headers['x-openshell-context'] ?? url.searchParams.get('context') ?? input.context
    if (context !== undefined && context !== null) {
      let selection
      try { selection = JSON.parse(context) } catch { throw fail('Invalid cloud workspace.') }
      if (!Array.isArray(selection) || selection.length !== 2 || !selection.every(value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(value))) throw fail('Invalid cloud workspace.')
    }
    const connection = services.connection(), owner = ownerId(connection.user.uid)
    if (input.owner !== undefined && input.owner !== owner) throw fail('This SSH alias belongs to a different Google account. Open the sandbox from OpenRod again.', 403)
    const sandbox = await services.call(scopedTarget(`/os/sandboxes/${name}`, context))
    assertActive(services, connection)
    const origin = `http://${req.headers.host}`
    if (!/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::[0-9]+)?$/.test(origin)) throw fail('Invalid local origin.', 403)
    let alias = aliasFor(connection.user.uid, name, context)
    if (action === 'ssh') {
      const view = connectionView(sandbox, { name: 'openrod-cloud', endpoint: dependencies.origin ?? cloudOrigin(), remote: true }, { env, platform })
      const ready = sandbox.phase === 'ready'
      if (ready) alias = (await install(name, origin, services, connection, context)).alias
      assertActive(services, connection)
      responseJson(res, 200, { ...view, alias, defaultMode: 'exec', cliInstalled: true, canOpenTerminal: ready && Boolean(sshBinary(env)) && view.terminalSupported, modes: ready ? { exec: { mode: 'exec', command: commandFor(alias), argv: ['-F', configFile, alias], workdir: projectOf(sandbox) ? `/sandbox/${projectOf(sandbox)}` : '/sandbox' } } : {} }); return true
    }
    if (sandbox.phase !== 'ready') throw fail('This sandbox is not running.', 409)
    if (action === 'ssh-open' && input.mode !== undefined && input.mode !== 'exec') throw fail('Cloud SSH opens a fresh shell. Use the browser terminal for attach.')
    let editor
    if (action === 'editor') {
      if (!Object.hasOwn(EDITORS, input.editor ?? '')) throw fail('Unknown editor.')
      editor = findEditor(input.editor)
      if (!editor) throw fail(`${EDITORS[input.editor].label} is not installed on this machine.`, 409)
    }
    if (action === 'ssh-open' && !sshBinary(env)) throw fail('OpenSSH is not installed on this machine.', 409)
    const installed = await install(name, origin, services, connection, context)
    assertActive(services, connection)
    if (action === 'ssh-ticket') responseJson(res, 200, installed.ticket)
    else if (action === 'ssh-config') responseJson(res, 200, { config: installed.config, alias, command: installed.command })
    else if (action === 'ssh-open') {
      await (dependencies.launchTerminal ?? launchNativeTerminal)(installed.command, { ...dependencies, platform }); responseJson(res, 200, { ok: true, mode: 'exec' })
    } else {
      await (dependencies.launchEditor ?? launchEditor)(editor, ['--remote', `ssh-remote+${alias}`, projectOf(sandbox) ? `/sandbox/${projectOf(sandbox)}` : '/sandbox'], dependencies)
      responseJson(res, 200, { ok: true, editor: input.editor })
    }
    return true
  }
}
