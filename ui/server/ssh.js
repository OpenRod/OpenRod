import { execFile, spawn } from 'node:child_process'
import { rmSync } from 'node:fs'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { connectionPlan, nativeSshCommand } from '../src/lib/sandbox-session.js'
import { CONFIG_DIR, gateway, sandboxView } from './gateway.js'
import { fail, openshellBinary, reasonFrom, runOpenShell, shellQuote, sshBinary } from './openshell-cli.js'

const NAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/
const MODES = new Set(['ssh', 'exec', 'attach'])

async function loadContext(name) {
  const { client, target, workspace, workspaceScope } = await gateway()
  const sandbox = sandboxView((await client.raw.getSandbox({ name, workspaceScope })).sandbox)
  return { sandbox, target, workspace }
}

export function connectionView(sandbox, target, {
  env = process.env,
  platform = process.platform,
  workspace = sandbox.workspace || 'default',
} = {}) {
  const cli = openshellBinary(env)
  const ssh = sshBinary(env)
  const terminalSupported = platform === 'darwin' || platform === 'linux'
  const executable = cli ?? env.OPENSHELL_BIN ?? 'openshell'
  const ready = sandbox.phase === 'ready'
  const configHome = env.XDG_CONFIG_HOME ?? path.dirname(CONFIG_DIR)
  const modes = ready ? {
    ssh: connectionPlan(sandbox, { gateway: target.name, workspace, executable, configHome, ssh: ssh ?? 'ssh', mode: 'ssh' }),
    exec: connectionPlan(sandbox, { gateway: target.name, workspace, executable, configHome }),
    ...(sandbox.tty ? { attach: connectionPlan(sandbox, { gateway: target.name, workspace, executable, configHome, mode: 'attach' }) } : {}),
  } : {}
  return {
    ready,
    gateway: { name: target.name, endpoint: target.endpoint, remote: target.remote, workspace },
    cliInstalled: Boolean(cli),
    sshInstalled: Boolean(ssh),
    terminalSupported,
    canOpenTerminal: ready && Boolean(cli) && Boolean(ssh) && terminalSupported,
    alias: `openshell-${sandbox.name}.${workspace}`,
    defaultMode: 'ssh',
    modes,
  }
}

export function launchNativeTerminal(command, {
  platform = process.platform,
  exec = execFile,
  spawnProcess = spawn,
  onFailure,
} = {}) {
  if (platform === 'darwin') {
    const escaped = command.replace(/[\\"]/g, '\\$&')
    const script = `tell application "Terminal" to do script "${escaped}"`
    return new Promise((resolve, reject) => exec('osascript', ['-e', script, '-e', 'tell application "Terminal" to activate'], { timeout: 10_000 },
      (error) => error
        ? reject(fail('Could not open Terminal. Allow the console to control Terminal in System Settings → Privacy & Security → Automation.', 502))
        : resolve()))
  }
  if (platform === 'linux') {
    return new Promise((resolve, reject) => {
      const child = spawnProcess('x-terminal-emulator', ['-e', 'sh', '-c', command], { detached: true, shell: false, stdio: 'ignore' })
      child.once('error', () => reject(fail('No terminal emulator found. Copy the command instead.', 501)))
      child.once('exit', (code) => { if (code !== 0) onFailure?.() })
      child.once('spawn', () => { child.unref(); resolve() })
    })
  }
  throw fail('Opening a terminal is supported on macOS and Linux only.', 501)
}

function requireReady(sandbox) {
  if (sandbox.phase !== 'ready') throw fail('This sandbox is not running.', 409)
}

async function generateConfig(name, target, workspace, dependencies) {
  const result = await (dependencies.runOpenShell ?? runOpenShell)(['sandbox', 'ssh-config', name], {
    gateway: target.name,
    workspace,
    timeoutMs: 15_000,
    outputLimit: 128 * 1024,
    env: dependencies.env,
  })
  if (result.timedOut) throw fail('Generating SSH config timed out.', 504)
  if (result.outputExceeded) throw fail('The generated SSH config is too large.', 502)
  if (result.code !== 0) throw fail(reasonFrom(`${result.stderr}${result.stdout}`), 502)
  const config = result.stdout.trim()
  if (!config) throw fail('The openshell CLI returned an empty SSH config.', 502)
  return `${config}\n`
}

async function openDirectSsh(sandbox, target, workspace, dependencies) {
  const config = await generateConfig(sandbox.name, target, workspace, dependencies)
  const directory = await mkdtemp(path.join(dependencies.tempDirectory ?? os.tmpdir(), 'openshell-ssh-'))
  try {
    await chmod(directory, 0o700)
    await writeFile(path.join(directory, 'config'), config, { mode: 0o600, flag: 'wx' })
    const command = nativeSshCommand({
      alias: `openshell-${sandbox.name}.${workspace}`,
      ssh: sshBinary(dependencies.env),
      directory,
      configHome: dependencies.env?.XDG_CONFIG_HOME ?? path.dirname(CONFIG_DIR),
    })
    await (dependencies.launchTerminal ?? launchNativeTerminal)(command, {
      ...dependencies,
      // Some Linux emulators spawn successfully, then fail before running sh.
      onFailure: () => rmSync(directory, { recursive: true, force: true }),
    })
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}

export async function sshRoute(method, parts, input, dependencies = {}) {
  if (parts[0] !== 'sandboxes' || parts.length !== 3 || !NAME.test(parts[1] ?? '')) return undefined
  const [, name, action] = parts
  if (!['ssh', 'ssh-open', 'ssh-config'].includes(action)) return undefined

  const context = dependencies.loadSandbox
    ? { sandbox: await dependencies.loadSandbox(name), target: dependencies.target }
    : await (dependencies.loadContext ?? loadContext)(name)
  const { sandbox, target, workspace = sandbox.workspace || 'default' } = context

  if (method === 'GET' && action === 'ssh') return connectionView(sandbox, target, { ...dependencies, workspace })
  if (method !== 'POST') return undefined
  requireReady(sandbox)

  if (action === 'ssh-open') {
    const mode = String(input?.mode ?? 'ssh')
    if (!MODES.has(mode)) throw fail('Unknown connection mode.')
    const view = connectionView(sandbox, target, { ...dependencies, workspace })
    const plan = view.modes[mode]
    if (!plan) throw fail('This sandbox has no canonical TTY session to attach.', 409)
    if (!view.cliInstalled) throw fail('The openshell CLI is not installed on this machine.', 409)
    if (!view.sshInstalled) throw fail('OpenSSH is not installed on this machine.', 409)
    if (!view.terminalSupported) throw fail('Opening a terminal is supported on macOS and Linux only.', 501)
    if (mode === 'ssh') await openDirectSsh(sandbox, target, workspace, dependencies)
    else await (dependencies.launchTerminal ?? launchNativeTerminal)(plan.command, dependencies)
    return { ok: true, mode }
  }

  if (action === 'ssh-config') {
    const config = await generateConfig(name, target, workspace, dependencies)
    const alias = `openshell-${sandbox.name}.${workspace}`
    const configHome = dependencies.env?.XDG_CONFIG_HOME ?? path.dirname(CONFIG_DIR)
    return { config, alias, command: `env ${shellQuote(`XDG_CONFIG_HOME=${configHome}`)} ssh ${shellQuote(alias)}` }
  }

  return undefined
}
