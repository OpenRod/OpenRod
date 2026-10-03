import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { INSTALL_COMMAND, INSTALL_SHA256, INSTALL_URL, MAC_INSTALL_COMMAND, installCommand } from '../shared/openshell-release.js'
const CMD = installCommand('darwin')

// Keep gateway.js's import-time config reads away from the real ~/.config.
const config = await fs.mkdtemp(path.join(os.tmpdir(), 'openshell-install-config-'))
process.env.XDG_CONFIG_HOME = config
const { offerOpenShellInstall, installerEnv } = await import('./openshell-install.js')
test.after(() => fs.rm(config, { recursive: true, force: true }))

const BODY = Buffer.from('#!/bin/sh\necho stub installer\n')
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const GATEWAY = [{ name: 'openshell', endpoint: 'https://localhost:17670' }]

function setup(overrides = {}) {
  const lines = []
  const calls = { ask: [], fetch: [], run: [] }
  const state = { installed: false, gateway: false }
  const log = { info: (line) => lines.push(line), warn: (line) => lines.push(line), error: (line) => lines.push(line) }
  const options = {
    env: { PATH: '/stub/bin' }, platform: 'darwin', arch: 'arm64', interactive: true,
    find: (bin) => `/stub/bin/${bin}`,
    cli: () => state.installed ? '/stub/bin/openshell' : null,
    version: async () => 'openshell 0.1.2',
    gateways: () => state.gateway ? GATEWAY : [],
    dockerReady: async () => true,
    ask: async (question) => { calls.ask.push(question); return '' },
    fetch: async (url, init) => { calls.fetch.push({ url, init }); return new Response(BODY) },
    expected: sha(BODY),
    run: async (command, args, options) => {
      calls.run.push({ command, args, env: options.env, content: await fs.readFile(args[0]), dir: path.dirname(args[0]) })
      state.installed = true; state.gateway = true
      return { code: 0, signal: null }
    },
    // e2fsprogs and gateway.env already there, so macOS preparation does nothing.
    home: '/stub/home', has: async () => true, read: async () => 'OPENSHELL_COMPUTE_DRIVER=vm\n', uid: 501,
    log, ...overrides,
  }
  return { options, lines, calls, state }
}

test('the pinned installer constants agree with each other', () => {
  assert.equal(INSTALL_URL, 'https://raw.githubusercontent.com/NVIDIA/OpenShell/v0.1.2/install.sh')
  assert.match(INSTALL_SHA256, /^[0-9a-f]{64}$/)
  assert.equal(INSTALL_COMMAND, `curl -LsSf ${INSTALL_URL} | OPENSHELL_VERSION=v0.1.2 sh`)
  assert.equal(installCommand('linux'), INSTALL_COMMAND)
  assert.equal(installCommand('darwin'), MAC_INSTALL_COMMAND)
  assert.ok(MAC_INSTALL_COMMAND.startsWith('brew install e2fsprogs && ') && MAC_INSTALL_COMMAND.endsWith(` && ${INSTALL_COMMAND}`))
})

test('an installed CLI with the pinned version and a local gateway stays quiet', async () => {
  const { options, calls, lines, state } = setup()
  state.installed = true; state.gateway = true
  assert.equal(await offerOpenShellInstall(options), 'present')
  assert.deepEqual([calls.ask, calls.fetch, calls.run, lines], [[], [], [], []])
})

test('an installed CLI with another version warns once and never installs', async () => {
  const { options, calls, lines, state } = setup({ version: async () => 'openshell 0.1.1\n' })
  state.installed = true; state.gateway = true
  assert.equal(await offerOpenShellInstall(options), 'present')
  assert.deepEqual(lines, ['OpenRod is tested with OpenShell 0.1.2; this computer has 0.1.1.'])
  assert.deepEqual([calls.ask, calls.fetch, calls.run], [[], [], []])
})

test('unreadable version output prints nothing', async () => {
  for (const version of [async () => null, async () => 'garbage']) {
    const { options, lines, state } = setup({ version })
    state.installed = true; state.gateway = true
    assert.equal(await offerOpenShellInstall(options), 'present')
    assert.deepEqual(lines, [])
  }
})

test('an installed CLI without a local gateway prints the platform gateway add command', async () => {
  for (const [platform, arch, host] of [['darwin', 'arm64', 'localhost'], ['linux', 'x64', '127.0.0.1']]) {
    const { options, lines, calls, state } = setup({ platform, arch })
    state.installed = true
    assert.equal(await offerOpenShellInstall(options), 'present')
    assert.deepEqual(lines, ['OpenShell is installed, but no local gateway is registered. Run:', `  openshell gateway add https://${host}:17670 --local --name openshell`])
    assert.deepEqual(calls.run, [])
  }
})

test('OPENSHELL_BIN pointing at a missing file warns and never offers an install', async () => {
  const { options, lines, calls } = setup({ env: { PATH: '/stub/bin', OPENSHELL_BIN: '/missing/openshell' } })
  assert.equal(await offerOpenShellInstall(options), 'skipped')
  assert.deepEqual(lines, ['OPENSHELL_BIN points to a missing file: /missing/openshell'])
  assert.deepEqual(calls.ask, [])
})

test('unsupported platforms are told SSH hosts still work', async () => {
  for (const [platform, arch] of [['darwin', 'x64'], ['win32', 'x64']]) {
    const { options, lines, calls } = setup({ platform, arch })
    assert.equal(await offerOpenShellInstall(options), 'skipped')
    assert.deepEqual(lines, ['OpenShell needs Apple Silicon macOS or Linux. SSH hosts still work.'])
    assert.deepEqual(calls.ask, [])
  }
})

test('macOS without Homebrew points to brew.sh', async () => {
  const searched = []
  const { options, lines, calls } = setup({ find: (bin, extra = []) => { searched.push([bin, extra]); return bin === 'brew' ? null : `/stub/bin/${bin}` } })
  assert.equal(await offerOpenShellInstall(options), 'skipped')
  assert.deepEqual(lines, ['OpenShell installs with Homebrew. Install it from https://brew.sh, then run npx openrod again.'])
  assert.deepEqual(searched[0], ['brew', ['/opt/homebrew/bin', '/usr/local/bin']])
  assert.deepEqual(calls.ask, [])
})

test('Linux never looks for Homebrew', async () => {
  const { options, calls } = setup({ platform: 'linux', arch: 'arm64', find: (bin) => bin === 'brew' ? null : `/stub/bin/${bin}` })
  assert.equal(await offerOpenShellInstall(options), 'ready')
  assert.match(calls.ask[0], /It uses sudo and may ask for your password\. \[Y\/n\] $/)
  assert.equal(calls.run[0].env.PATH, '/stub/bin')
  assert.equal(calls.run[0].env.HOMEBREW_NO_AUTO_UPDATE, undefined)
})

test('Linux without dpkg or rpm is never asked to install', async () => {
  const { options, lines, calls } = setup({ platform: 'linux', arch: 'x64', find: (bin) => ['dpkg', 'rpm'].includes(bin) ? null : `/stub/bin/${bin}` })
  assert.equal(await offerOpenShellInstall(options), 'skipped')
  assert.deepEqual(lines, ['OpenShell installs from .deb or .rpm packages, and this Linux has neither. SSH hosts still work.'])
  assert.deepEqual([calls.ask, calls.fetch, calls.run], [[], [], []])
})

test('Linux with only rpm still offers the install', async () => {
  const { options, calls } = setup({ platform: 'linux', arch: 'x64', find: (bin) => bin === 'dpkg' ? null : `/stub/bin/${bin}` })
  assert.equal(await offerOpenShellInstall(options), 'ready')
  assert.equal(calls.ask.length, 1)
})

test('a missing curl prints the manual command', async () => {
  const { options, lines, calls } = setup({ find: (bin) => bin === 'curl' ? null : `/stub/bin/${bin}` })
  assert.equal(await offerOpenShellInstall(options), 'skipped')
  assert.equal(lines.at(-1), `  ${CMD}`)
  assert.deepEqual(calls.ask, [])
})

test('without a terminal the install command is printed and nothing runs', async () => {
  for (const options of [{ interactive: false }, { env: { PATH: '/stub/bin', CI: '1' }, interactive: undefined }]) {
    // interactive: undefined falls back to the default, which CI=1 turns off.
    const fixture = setup(options)
    assert.equal(await offerOpenShellInstall(fixture.options), 'skipped')
    assert.deepEqual(fixture.lines, ["OpenShell isn't installed. To install it, run:", `  ${CMD}`])
    assert.deepEqual([fixture.calls.ask, fixture.calls.fetch, fixture.calls.run], [[], [], []])
  }
})

test('the prompt explains the install and warns first when Docker is not running', async () => {
  const { options, lines, calls } = setup({ dockerReady: async () => false, ask: async (question) => { calls.ask.push([question, [...lines]]); return 'n' } })
  assert.equal(await offerOpenShellInstall(options), 'skipped')
  const [question, before] = calls.ask[0]
  assert.equal(question, 'Install OpenShell 0.1.2 now? It uses Homebrew and runs sandboxes in VMs. [Y/n] ')
  assert.deepEqual(before, [
    "OpenShell isn't installed. OpenRod uses it to run sandboxes on this computer.",
    "Docker isn't running. OpenRod needs it to build sandbox images.",
  ])
})

test('a missing Docker says to install it, not start it', async () => {
  const { options, lines } = setup({ dockerReady: async () => 'missing', ask: async () => 'n' })
  await offerOpenShellInstall(options)
  assert.equal(lines[1], "Docker isn't installed. OpenRod needs it to build sandbox images.")
  assert.ok(!lines.some((line) => line.includes("isn't running")))
})

test('the Docker line is omitted when Docker is running', async () => {
  const { options, lines } = setup({ ask: async () => 'no' })
  await offerOpenShellInstall(options)
  assert.ok(!lines.some((line) => line.includes('Docker')))
})

test('declining prints the command and downloads nothing', async () => {
  for (const answer of ['n', 'no', 'N', 'later']) {
    const { options, lines, calls } = setup({ ask: async () => answer })
    assert.equal(await offerOpenShellInstall(options), 'skipped')
    assert.deepEqual(lines.slice(-2), ['Skipped. To install it later, run:', `  ${CMD}`])
    assert.deepEqual([calls.fetch, calls.run], [[], []])
  }
})

test('empty, y and yes all mean yes', async () => {
  for (const answer of ['', 'y', 'Y', ' yes ', 'YES']) {
    const { options, calls } = setup({ ask: async () => answer })
    assert.equal(await offerOpenShellInstall(options), 'ready')
    assert.equal(calls.run.length, 1)
  }
})

test('Ctrl-C at the prompt cancels without downloading', async () => {
  const { options, calls } = setup({ ask: async () => null })
  assert.equal(await offerOpenShellInstall(options), 'cancelled')
  assert.deepEqual([calls.fetch, calls.run], [[], []])
})

async function tempDirs() {
  return (await fs.readdir(os.tmpdir())).filter((name) => name.startsWith('openrod-openshell-')).sort()
}

test('a checksum mismatch is a hard stop: nothing is written or run', async () => {
  const cases = { 'wrong digest': { expected: INSTALL_SHA256 }, 'over 1 MiB': { fetch: async () => new Response(Buffer.alloc(1024 * 1024 + 1, 'x')) } }
  for (const [name, overrides] of Object.entries(cases)) {
    const before = await tempDirs()
    const { options, lines, calls } = setup(overrides)
    assert.equal(await offerOpenShellInstall(options), 'failed', name)
    assert.equal(lines.at(-1), 'The OpenShell installer did not match the pinned release. Nothing was installed.', name)
    assert.ok(!lines.some((line) => line.includes(CMD)), name)
    assert.deepEqual(calls.run, [], name)
    assert.deepEqual(await tempDirs(), before, name)
  }
})

test('download failures print the manual command and never run anything', async () => {
  const failures = {
    rejects: async () => { throw Object.assign(new TypeError('fetch failed'), { cause: new Error('getaddrinfo ENOTFOUND raw.githubusercontent.com') }) },
    'non-ok': async () => new Response('missing', { status: 404 }),
  }
  for (const [name, fetch] of Object.entries(failures)) {
    const { options, lines, calls } = setup({ fetch })
    assert.equal(await offerOpenShellInstall(options), 'failed', name)
    assert.match(lines.at(-2), /^Could not download the OpenShell installer: .+\. To install it yourself, run:$/, name)
    assert.equal(lines.at(-1), `  ${CMD}`)
    assert.deepEqual(calls.run, [], name)
  }
})

test('a verified installer runs from a private temp file with the pinned version', async () => {
  const { options, calls } = setup({ env: { PATH: '/usr/bin:/bin', HOME: '/stub/home' } })
  assert.equal(await offerOpenShellInstall(options), 'ready')
  assert.equal(calls.fetch[0].url, INSTALL_URL)
  assert.equal(calls.fetch[0].init.redirect, 'follow')
  assert.ok(calls.fetch[0].init.signal instanceof AbortSignal)
  const [{ command, args, env, content, dir }] = calls.run
  assert.equal(command, '/bin/sh')
  assert.equal(args.length, 1)
  assert.match(path.basename(dir), /^openrod-openshell-/)
  assert.deepEqual(content, BODY)
  assert.equal(env.OPENSHELL_VERSION, 'v0.1.2')
  assert.equal(env.HOME, '/stub/home')
  assert.ok(env.PATH.startsWith('/opt/homebrew/bin:/usr/local/bin:'))
  assert.equal(env.HOMEBREW_NO_AUTO_UPDATE, '1')
  await assert.rejects(fs.access(dir), { code: 'ENOENT' })
})

test('the installer file is private while it exists', async () => {
  let mode
  const { options } = setup({ run: async (command, args) => { mode = (await fs.stat(args[0])).mode & 0o777; return { code: 0 } } })
  await offerOpenShellInstall(options)
  assert.equal(mode, 0o600)
})

test('an explicit HOMEBREW_NO_AUTO_UPDATE is kept', () => {
  assert.equal(installerEnv({ PATH: '/bin', HOMEBREW_NO_AUTO_UPDATE: '' }, 'darwin').HOMEBREW_NO_AUTO_UPDATE, '')
})

test('the result comes from a fresh check, not from the installer exit code', async () => {
  const messages = {
    0: 'OpenShell 0.1.2 is ready.',
    1: "OpenShell 0.1.2 is installed, but its gateway isn't answering yet. Give it a minute, then click Use this computer.",
  }
  for (const [code, message] of Object.entries(messages)) {
    const fixture = setup()
    fixture.options.run = async () => { fixture.state.installed = true; fixture.state.gateway = true; return { code: Number(code), signal: null } }
    assert.equal(await offerOpenShellInstall(fixture.options), 'ready')
    assert.equal(fixture.lines.at(-1), message)
  }
})

test('a CLI without a registered gateway prints the platform follow-up commands', async () => {
  const expected = {
    darwin: ['brew services restart nvidia/openshell/openshell', 'openshell gateway add https://localhost:17670 --local --name openshell'],
    linux: ['systemctl --user enable openshell-gateway && systemctl --user restart openshell-gateway', 'openshell gateway add https://127.0.0.1:17670 --local --name openshell'],
  }
  for (const [platform, commands] of Object.entries(expected)) {
    const fixture = setup({ platform })
    fixture.options.run = async () => { fixture.state.installed = true; return { code: 0, signal: null } }
    assert.equal(await offerOpenShellInstall(fixture.options), 'partial')
    assert.deepEqual(fixture.lines.slice(-3), ["OpenShell is installed, but its gateway isn't registered. Run:", ...commands.map((line) => `  ${line}`)])
  }
})

test('a failed install with no CLI prints the retry command', async () => {
  const { options, lines } = setup({ run: async () => ({ code: 1, signal: null }) })
  assert.equal(await offerOpenShellInstall(options), 'failed')
  assert.deepEqual(lines.slice(-2), ['OpenShell install failed. The reason is above. To try again, run:', `  ${CMD}`])
})

test('a runner that cannot start still cleans up and reports failure', async () => {
  let dir
  const { options, lines } = setup({ run: async (command, args) => { dir = path.dirname(args[0]); throw new Error('spawn /bin/sh ENOENT') } })
  assert.equal(await offerOpenShellInstall(options), 'failed')
  assert.ok(lines.includes('Could not run the OpenShell installer: spawn /bin/sh ENOENT'))
  await assert.rejects(fs.access(dir), { code: 'ENOENT' })
})

test('Ctrl-C during the installer cancels', async () => {
  for (const result of [{ code: null, signal: 'SIGINT' }, { code: 130, signal: null }]) {
    const { options, lines } = setup({ run: async () => result })
    assert.equal(await offerOpenShellInstall(options), 'cancelled')
    assert.ok(!lines.some((line) => /ready|failed/.test(line)))
  }
})

async function macHome(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'openshell-install-home-'))
  t.after(() => fs.rm(home, { recursive: true, force: true }))
  return home
}
const brewThenInstaller = (calls, state, brewCode = 0) => async (command, args, options) => {
  calls.run.push({ command, args })
  if (command.endsWith('/brew')) return { code: brewCode, signal: null }
  state.installed = true; state.gateway = true
  return { code: 0, signal: null }
}

test('a fresh macOS install adds e2fsprogs and selects the VM driver before the installer runs', async t => {
  const home = await macHome(t)
  const { options, calls, state } = setup({ home, has: async (file) => file.startsWith(home) && (await fs.access(file).then(() => true, () => false)) })
  options.run = brewThenInstaller(calls, state)
  assert.equal(await offerOpenShellInstall(options), 'ready')
  assert.deepEqual(calls.run.map(({ command, args }) => [command, args[0]]), [['/stub/bin/brew', 'install'], ['/bin/sh', calls.run[1].args[0]]])
  assert.deepEqual(calls.run[0].args, ['install', 'e2fsprogs'])
  const file = path.join(home, '.config/openshell/gateway.env')
  assert.equal(await fs.readFile(file, 'utf8'), "# Added by OpenRod: run sandboxes in OpenShell's MicroVM driver.\nOPENSHELL_COMPUTE_DRIVER=vm\n")
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600)
})

test('an existing gateway.env, in the home or the Homebrew prefix, is never touched', async t => {
  for (const existing of ['home', 'prefix']) {
    const home = await macHome(t)
    const has = async (file) => existing === 'home' ? file === path.join(home, '.config/openshell/gateway.env') : file === '/stub/var/openshell/gateway.env'
    const { options, calls, state } = setup({ home, has })
    options.run = brewThenInstaller(calls, state)
    assert.equal(await offerOpenShellInstall(options), 'ready', existing)
    assert.deepEqual(calls.run[0].args, ['install', 'e2fsprogs'], existing)
    await assert.rejects(fs.access(path.join(home, '.config/openshell/gateway.env')), existing)
  }
})

test('a failed e2fsprogs install warns and OpenShell still installs', async t => {
  const home = await macHome(t)
  const { options, calls, state, lines } = setup({ home, has: async () => false })
  options.run = brewThenInstaller(calls, state, 1)
  assert.equal(await offerOpenShellInstall(options), 'ready')
  assert.ok(lines.includes('Could not install e2fsprogs. VM sandboxes need it, so run: brew install e2fsprogs'))
  assert.equal(calls.run[1].command, '/bin/sh')
})

test('Ctrl-C during the e2fsprogs install cancels before the installer', async t => {
  const home = await macHome(t)
  const { options, calls } = setup({ home, has: async () => false })
  options.run = async (command, args) => { calls.run.push({ command, args }); return { code: null, signal: 'SIGINT' } }
  assert.equal(await offerOpenShellInstall(options), 'cancelled')
  assert.equal(calls.run.length, 1)
})

test('Linux installs leave e2fsprogs and gateway.env alone', async t => {
  const home = await macHome(t)
  const { options, calls, state } = setup({ platform: 'linux', arch: 'x64', home, has: async () => false })
  options.run = brewThenInstaller(calls, state)
  assert.equal(await offerOpenShellInstall(options), 'ready')
  assert.deepEqual(calls.run.map(({ command }) => command), ['/bin/sh'])
  await assert.rejects(fs.access(path.join(home, '.config')))
})

test('macOS under sudo is told to run without it, and nothing runs', async () => {
  const { options, lines, calls } = setup({ uid: 0 })
  assert.equal(await offerOpenShellInstall(options), 'skipped')
  assert.deepEqual(lines, ['Run npx openrod without sudo to install OpenShell: Homebrew doesn’t run as root.'])
  assert.deepEqual([calls.ask, calls.fetch, calls.run], [[], [], []])
})

test('a kept gateway.env without a driver gets a hint; a gateway.toml driver is respected', async t => {
  const home = await macHome(t)
  const envFile = path.join(home, '.config/openshell/gateway.env')
  let fixture = setup({ home, has: async (file) => file === envFile || file.endsWith('mke2fs'), read: async () => 'DOCKER_HOST=unix:///x\n' })
  fixture.options.run = brewThenInstaller(fixture.calls, fixture.state)
  assert.equal(await offerOpenShellInstall(fixture.options), 'ready')
  assert.ok(fixture.lines.includes(`To run sandboxes in VMs, add OPENSHELL_COMPUTE_DRIVER=vm to ${envFile}.`))
  fixture = setup({ home, has: async (file) => file.endsWith('mke2fs'), read: async (file) => file === '/stub/var/openshell/gateway.toml' ? 'compute_driver = "docker"\n' : '' })
  fixture.options.run = brewThenInstaller(fixture.calls, fixture.state)
  assert.equal(await offerOpenShellInstall(fixture.options), 'ready')
  await assert.rejects(fs.access(envFile))
  assert.ok(!fixture.lines.some((line) => line.startsWith('To run sandboxes in VMs')))
})

test('a gateway.env that cannot be written warns and the install continues', async t => {
  const home = await macHome(t)
  await fs.writeFile(path.join(home, '.config'), 'not a directory')
  const { options, calls, state, lines } = setup({ home, has: async (file) => file.endsWith('mke2fs'), read: async () => '' })
  options.run = brewThenInstaller(calls, state)
  assert.equal(await offerOpenShellInstall(options), 'ready')
  assert.ok(lines.some((line) => line.startsWith(`Could not write ${path.join(home, '.config/openshell/gateway.env')}`)))
  assert.equal(calls.run.at(-1).command, '/bin/sh')
})

test('on Linux the Docker line says the gateway needs it and the plain command is printed', async () => {
  const { options, lines } = setup({ platform: 'linux', arch: 'x64', dockerReady: async () => false, ask: async () => 'n' })
  assert.equal(await offerOpenShellInstall(options), 'skipped')
  assert.ok(lines.includes("Docker isn't running. OpenShell's gateway won't start without it."))
  assert.equal(lines.at(-1), `  ${INSTALL_COMMAND}`)
})

test('an answer that is neither yes nor no asks again', async () => {
  const answers = ['ט', 'maybe', 'y']
  const { options, calls } = setup({ ask: async (question) => { calls.ask.push(question); return answers.shift() } })
  assert.equal(await offerOpenShellInstall(options), 'ready')
  assert.deepEqual(calls.ask.slice(1), ['Please answer y or n. [Y/n] ', 'Please answer y or n. [Y/n] '])
  const fixture = setup({ ask: async (question) => { fixture.calls.ask.push(question); return 'ט' } })
  assert.equal(await offerOpenShellInstall(fixture.options), 'skipped')
  assert.equal(fixture.calls.ask.length, 4)
  assert.equal(fixture.calls.run.length, 0)
})
