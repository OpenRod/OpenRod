import { execFile, spawn } from 'node:child_process'
import { createTerminalQueue, macTerminalScript, terminalLaunchError } from './local-terminal.js'
import { connectionPlan } from '../src/lib/sandbox-session.js'
import { WORKSPACE, gateway, sandboxView } from './gateway.js'
import { fail, openshellBinary, reasonFrom, runOpenShell, shellQuote, sshBinary } from './openshell-cli.js'

const NAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/
const MODES = new Set(['exec', 'attach'])
const queueTerminal = createTerminalQueue()

async function loadContext(name) {
  const { client, target } = await gateway()
  const sandbox = sandboxView((await client.raw.getSandbox({ name, workspaceScope: WORKSPACE })).sandbox)
  return { sandbox, target }
}

export function connectionView(sandbox, target, {
  env = process.env,
  platform = process.platform,
} = {}) {
  const cli = openshellBinary(env)
  const ssh = sshBinary(env)
  const terminalSupported = platform === 'darwin' || platform === 'linux'
  const executable = cli ?? env.OPENSHELL_BIN ?? 'openshell'
  const ready = sandbox.phase === 'ready'
  const modes = ready ? {
    exec: connectionPlan(sandbox, { gateway: target.name, executable }),
    ...(sandbox.tty ? { attach: connectionPlan(sandbox, { gateway: target.name, executable, mode: 'attach' }) } : {}),
  } : {}
  return {
    ready,
    gateway: { name: target.name, endpoint: target.endpoint, remote: target.remote },
    cliInstalled: Boolean(cli),
    sshInstalled: Boolean(ssh),
    terminalSupported,
    canOpenTerminal: ready && Boolean(cli) && Boolean(ssh) && terminalSupported,
    alias: `openshell-${sandbox.name}.default`,
    defaultMode: 'exec',
    modes,
  }
}

export function launchNativeTerminal(command, {
  platform = process.platform,
  exec = execFile,
  spawnProcess = spawn,
} = {}) {
  if (platform === 'darwin') {
    return queueTerminal(() => new Promise((resolve, reject) => exec('osascript', ['-e', macTerminalScript(command)], { timeout: 15_000 },
      (error, stdout, stderr) => error
        ? reject(fail(terminalLaunchError(error, stderr), 502))
        : resolve())))
  }
  if (platform === 'linux') {
    return new Promise((resolve, reject) => {
      const child = spawnProcess('x-terminal-emulator', ['-e', 'sh', '-c', command], { detached: true, shell: false, stdio: 'ignore' })
      child.once('error', () => reject(fail('No terminal emulator found. Copy the command instead.', 501)))
      child.once('spawn', () => { child.unref(); resolve() })
    })
  }
  throw fail('Opening a terminal is supported on macOS and Linux only.', 501)
}

function requireReady(sandbox) {
  if (sandbox.phase !== 'ready') throw fail('This sandbox is not running.', 409)
}

export async function sshRoute(method, parts, input, dependencies = {}) {
  if (parts[0] !== 'sandboxes' || parts.length !== 3 || !NAME.test(parts[1] ?? '')) return undefined
  const [, name, action] = parts
  if (!['ssh', 'ssh-open', 'ssh-config'].includes(action)) return undefined

  const context = dependencies.loadSandbox
    ? { sandbox: await dependencies.loadSandbox(name), target: dependencies.target }
    : await (dependencies.loadContext ?? loadContext)(name)
  const { sandbox, target } = context

  if (method === 'GET' && action === 'ssh') return connectionView(sandbox, target, dependencies)
  if (method !== 'POST') return undefined
  requireReady(sandbox)

  if (action === 'ssh-open') {
    const mode = String(input?.mode ?? 'exec')
    if (!MODES.has(mode)) throw fail('Unknown connection mode.')
    const view = connectionView(sandbox, target, dependencies)
    const plan = view.modes[mode]
    if (!plan) throw fail('This sandbox has no canonical TTY session to attach.', 409)
    if (!view.cliInstalled) throw fail('The openshell CLI is not installed on this machine.', 409)
    if (!view.sshInstalled) throw fail('OpenSSH is not installed on this machine.', 409)
    if (!view.terminalSupported) throw fail('Opening a terminal is supported on macOS and Linux only.', 501)
    await (dependencies.launchTerminal ?? launchNativeTerminal)(plan.command, dependencies)
    return { ok: true, mode }
  }

  if (action === 'ssh-config') {
    const run = dependencies.runOpenShell ?? runOpenShell
    const result = await run(['sandbox', 'ssh-config', name], {
      gateway: target.name,
      timeoutMs: 15_000,
      outputLimit: 128 * 1024,
      env: dependencies.env,
    })
    if (result.timedOut) throw fail('Generating SSH config timed out.', 504)
    if (result.outputExceeded) throw fail('The generated SSH config is too large.', 502)
    if (result.code !== 0) throw fail(reasonFrom(`${result.stderr}${result.stdout}`), 502)
    const config = result.stdout.trim()
    if (!config) throw fail('The openshell CLI returned an empty SSH config.', 502)
    const alias = `openshell-${sandbox.name}.default`
    return { config: `${config}\n`, alias, command: `ssh ${shellQuote(alias)}` }
  }

  return undefined
}
