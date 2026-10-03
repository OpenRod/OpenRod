import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline/promises'
import { findExecutable, openshellBinary, pathDirs } from './openshell-cli.js'
import { localGateways } from './gateway.js'
import { INSTALL_SHA256, INSTALL_URL, OPENSHELL_TAG, OPENSHELL_VERSION, installCommand } from '../shared/openshell-release.js'

const SUPPORTED = ['darwin-arm64', 'linux-arm64', 'linux-x64']
const BREW_DIRS = ['/opt/homebrew/bin', '/usr/local/bin']
const MAX_SCRIPT_BYTES = 1024 * 1024

const addCommand = (platform) => `openshell gateway add https://${platform === 'darwin' ? 'localhost' : '127.0.0.1'}:17670 --local --name openshell`
const restartCommand = (platform) => platform === 'darwin' ? 'brew services restart nvidia/openshell/openshell' : 'systemctl --user enable openshell-gateway && systemctl --user restart openshell-gateway'

function cliVersion(bin) {
  return new Promise((resolve) => execFile(bin, ['--version'], { timeout: 5000 }, (error, stdout) => resolve(error ? null : String(stdout))))
}

// Resolves to true, false (installed but not answering) or 'missing'.
function dockerRunning(find, env) {
  const docker = find('docker', [...BREW_DIRS, '/Applications/Docker.app/Contents/Resources/bin'])
  if (!docker) return 'missing'
  return new Promise((resolve) => execFile(docker, ['info'], { timeout: 10_000, env }, (error) => resolve(!error)))
}

// Resolves to the answer, or null on Ctrl-C. Ctrl-D counts as "no".
async function askTerminal(question) {
  // Drop keys typed before the question, like an extra Enter during npx's download.
  const drop = () => {}
  process.stdin.setRawMode?.(true); process.stdin.on('data', drop)
  await new Promise((resolve) => setTimeout(resolve, 50))
  process.stdin.off('data', drop); process.stdin.pause(); process.stdin.setRawMode?.(false)
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    return await new Promise((resolve) => {
      rl.on('SIGINT', () => { process.stdout.write('\n'); resolve(null) })
      rl.on('close', () => resolve('n'))
      rl.question(question).then(resolve, () => resolve('n'))
    })
  } finally { rl.close() }
}

// stdio is inherited so brew and sudo can talk to the user. Ctrl-C reaches the
// installer; this process ignores it until the installer exits.
function runInstaller(command, args, { env }) {
  const ignore = () => {}
  process.on('SIGINT', ignore)
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', env })
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({ code, signal }))
  }).finally(() => process.off('SIGINT', ignore))
}

async function download(fetch, expected) {
  const response = await fetch(INSTALL_URL, { signal: AbortSignal.timeout(30_000), redirect: 'follow' })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const chunks = []
  let bytes = 0
  for await (const chunk of response.body ?? []) {
    bytes += chunk.length
    // The pinned file is far smaller, so anything this big cannot match it.
    if (bytes > MAX_SCRIPT_BYTES) throw Object.assign(new Error('checksum mismatch'), { code: 'CHECKSUM' })
    chunks.push(chunk)
  }
  const body = Buffer.concat(chunks)
  if (createHash('sha256').update(body).digest('hex') !== expected) throw Object.assign(new Error('checksum mismatch'), { code: 'CHECKSUM' })
  return body
}

const exists = (file) => fs.access(file).then(() => true, () => false)

// On macOS OpenRod runs local sandboxes in OpenShell's MicroVM driver. A fresh
// install would auto-select the Docker driver, which needs Docker Desktop's
// host networking (off by default). The VM driver needs e2fsprogs, and the
// gateway service reads its driver from gateway.env.
async function prepareMac({ brew, home, env, run, has, read, log }) {
  const prefix = path.dirname(path.dirname(brew))
  if (!await has(path.join(prefix, 'opt/e2fsprogs/sbin/mke2fs'))) {
    log.info('Installing e2fsprogs, which OpenShell’s VM driver needs…')
    const result = await run(brew, ['install', 'e2fsprogs'], { env: installerEnv(env, 'darwin') }).catch((error) => ({ error }))
    if (result.signal === 'SIGINT' || result.code === 130) return 'cancelled'
    if (result.error || result.code) log.warn('Could not install e2fsprogs. VM sandboxes need it, so run: brew install e2fsprogs')
  }
  // The service reads $HOME/.config (launchd sets no XDG_CONFIG_HOME), else the
  // Homebrew prefix copy. An existing file is someone's setup and stays as is.
  const file = path.join(home, '.config/openshell/gateway.env')
  const hint = () => log.info(`To run sandboxes in VMs, add OPENSHELL_COMPUTE_DRIVER=vm to ${file}.`)
  const envs = [file, path.join(prefix, 'var/openshell/gateway.env')]
  const tomls = [path.join(home, '.config/openshell/gateway.toml'), path.join(prefix, 'var/openshell/gateway.toml')]
  const kept = (await Promise.all(envs.map(has))).findIndex(Boolean)
  if (kept >= 0) { if (!/^\s*(?:export\s+)?OPENSHELL_COMPUTE_DRIVER=/m.test(await read(envs[kept]))) hint(); return 'kept' }
  for (const toml of tomls) if (/^\s*compute_driver\s*=/m.test(await read(toml))) return 'kept'
  try {
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
    await fs.writeFile(file, "# Added by OpenRod: run sandboxes in OpenShell's MicroVM driver.\nOPENSHELL_COMPUTE_DRIVER=vm\n", { mode: 0o600, flag: 'wx' })
  } catch (error) { log.warn(`Could not write ${file} (${error.code ?? error.message}).`); hint(); return 'kept' }
  return 'written'
}

export function installerEnv(env, platform) {
  const next = { ...env, OPENSHELL_VERSION: OPENSHELL_TAG }
  if (platform === 'darwin') {
    next.PATH = [...BREW_DIRS, env.PATH].filter(Boolean).join(path.delimiter)
    next.HOMEBREW_NO_AUTO_UPDATE ??= '1'
  }
  return next
}

// Offers to install the pinned OpenShell release when its CLI is missing.
// Never installs over an existing CLI: the installer always reinstalls and
// restarts the gateway service, which stops running sandboxes.
export async function offerOpenShellInstall({
  env = process.env, platform = process.platform, arch = process.arch,
  interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY && !env.CI),
  // Homebrew's own directories go first for brew, as in installerEnv.
  find = (bin, extra = []) => findExecutable(bin, bin === 'brew' ? [...extra, ...pathDirs(env)] : [...pathDirs(env), ...extra]),
  cli = () => openshellBinary(env), version = cliVersion, gateways = localGateways,
  dockerReady = () => dockerRunning(find, env), ask = askTerminal, fetch = globalThis.fetch,
  run = runInstaller, expected = INSTALL_SHA256, log = console, home = os.homedir(), has = exists,
  read = (file) => fs.readFile(file, 'utf8').catch(() => ''), uid = process.getuid?.(),
} = {}) {
  const command = installCommand(platform)
  const manual = (line) => { log.info(line); log.info(`  ${command}`) }
  const bin = cli()
  if (env.OPENSHELL_BIN && !bin) { log.warn(`OPENSHELL_BIN points to a missing file: ${env.OPENSHELL_BIN}`); return 'skipped' }
  if (bin) {
    const found = /\b(\d+\.\d+\.\d+)\b/.exec(await version(bin) ?? '')?.[1]
    if (found && found !== OPENSHELL_VERSION) log.warn(`OpenRod is tested with OpenShell ${OPENSHELL_VERSION}; this computer has ${found}.`)
    if (!gateways().length) { log.info('OpenShell is installed, but no local gateway is registered. Run:'); log.info(`  ${addCommand(platform)}`) }
    return 'present'
  }
  if (!SUPPORTED.includes(`${platform}-${arch}`)) { log.info('OpenShell needs Apple Silicon macOS or Linux. SSH hosts still work.'); return 'skipped' }
  if (platform === 'darwin' && uid === 0) { log.info('Run npx openrod without sudo to install OpenShell: Homebrew doesn’t run as root.'); return 'skipped' }
  if (platform === 'darwin' && !find('brew', BREW_DIRS)) { log.info('OpenShell installs with Homebrew. Install it from https://brew.sh, then run npx openrod again.'); return 'skipped' }
  if (!find('curl')) { manual("OpenShell isn't installed, and its installer needs curl. Install curl, then run:"); return 'skipped' }
  if (platform === 'linux' && !find('dpkg') && !find('rpm')) { log.info('OpenShell installs from .deb or .rpm packages, and this Linux has neither. SSH hosts still work.'); return 'skipped' }
  if (!interactive) { manual("OpenShell isn't installed. To install it, run:"); return 'skipped' }

  log.info("OpenShell isn't installed. OpenRod uses it to run sandboxes on this computer.")
  const docker = await dockerReady()
  // The Linux packages run sandboxes in Docker; on macOS the VM driver only needs it for images OpenRod builds.
  const needs = platform === 'darwin' ? 'OpenRod needs it to build sandbox images.' : "OpenShell's gateway won't start without it."
  if (docker === 'missing') log.info(`Docker isn't installed. ${needs}`)
  else if (!docker) log.info(`Docker isn't running. ${needs}`)
  const answer = await ask(`Install OpenShell ${OPENSHELL_VERSION} now? ${platform === 'darwin' ? 'It uses Homebrew and runs sandboxes in VMs.' : 'It uses sudo and may ask for your password.'} [Y/n] `)
  if (answer === null) return 'cancelled'
  if (!['', 'y', 'yes'].includes(answer.trim().toLowerCase())) { manual('Skipped. To install it later, run:'); return 'skipped' }

  log.info(`Installing OpenShell ${OPENSHELL_VERSION}…`)
  let script
  try { script = await download(fetch, expected) } catch (error) {
    if (error.code === 'CHECKSUM') { log.error('The OpenShell installer did not match the pinned release. Nothing was installed.'); return 'failed' }
    log.error(`Could not download the OpenShell installer: ${error.cause?.message ?? error.message}. To install it yourself, run:`)
    log.error(`  ${command}`)
    return 'failed'
  }
  if (platform === 'darwin' && await prepareMac({ brew: find('brew', BREW_DIRS), home, env, run, has, read, log }) === 'cancelled') return 'cancelled'
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'openrod-openshell-'))
  let result = {}
  try {
    const file = path.join(dir, 'install.sh')
    await fs.writeFile(file, script, { mode: 0o600 })
    result = await run('/bin/sh', [file], { env: installerEnv(env, platform) })
  } catch (error) { log.error(`Could not run the OpenShell installer: ${error.message}`) }
  finally { await fs.rm(dir, { recursive: true, force: true }) }
  if (result.signal === 'SIGINT' || result.code === 130) return 'cancelled'

  // The installer's exit code is not reliable: it can exit 0 without a gateway
  // and 1 after a slow gateway start. Check what is actually there instead.
  if (cli()) {
    if (gateways().length) {
      log.info(result.code === 0 ? `OpenShell ${OPENSHELL_VERSION} is ready.` : `OpenShell ${OPENSHELL_VERSION} is installed, but its gateway isn't answering yet. ${platform === 'darwin' ? 'Give it a minute' : 'Make sure Docker is running'}, then click Use this computer.`)
      return 'ready'
    }
    log.warn("OpenShell is installed, but its gateway isn't registered. Run:")
    log.warn(`  ${restartCommand(platform)}`)
    log.warn(`  ${addCommand(platform)}`)
    return 'partial'
  }
  log.error('OpenShell install failed. The reason is above. To try again, run:')
  log.error(`  ${command}`)
  return 'failed'
}
