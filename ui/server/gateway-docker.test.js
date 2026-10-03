import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import {
  LABEL, MARK, brewPrefix, chooseEnvFile, createGatewayDocker, decideFix, driverSocket, envValue, findDriver,
  newer, parseProcesses, procEnviron, quote, readManaged, validateEnvFile, wrapperPrefixFile, writeEnvFile, writeManaged,
} from './gateway-docker.js'

// The Homebrew wrapper's env-file section, as shipped with OpenShell 0.1.2.
const wrapperText = (prefix) => [
  '#!/bin/sh', 'set -eu', '',
  'if [ -z "${HOME:-}" ]; then', '  echo "HOME must be set for Docker TLS bind mounts" >&2', '  exit 1', 'fi', '',
  'xdg_config_home="${XDG_CONFIG_HOME:-${HOME}/.config}"',
  'xdg_gateway_env="${xdg_config_home}/openshell/gateway.env"',
  `prefix_gateway_env="${prefix}/var/openshell/gateway.env"`,
  'if [ -f "${xdg_gateway_env}" ]; then', '  set -a', '  . "${xdg_gateway_env}"', '  set +a',
  'elif [ -f "${prefix_gateway_env}" ]; then', '  set -a', '  . "${prefix_gateway_env}"', '  set +a', 'fi', '',
  `exec "${prefix}/opt/openshell/bin/openshell-gateway"`, '',
].join('\n')

const VM = '/opt/homebrew/Cellar/openshell/0.1.2/libexec/openshell-driver-vm'
const DRIVER = `${VM} --bind-socket /Users/me/.local/state/openshell/vm-driver.sock --log-level info`
const listing = (prefix) => [
  '  501     1 /usr/sbin/cfprefsd agent',
  ` 1533 34228 ${VM} --internal-run-vm --vm-id 7f1c --rootfs /x`,
  ` 9952 34228 ${VM} --internal-run-vm --vm-id 22aa --rootfs /y`,
  `34124     1 ${prefix}/opt/openshell/bin/openshell-gateway`,
  `34228 34124 ${DRIVER}`,
  '',
].join('\n')

const sh = (file, args, { env, timeoutMs } = {}) => new Promise((resolve) => execFile(file, args, { env, timeout: timeoutMs }, (error, stdout, stderr) => (
  resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout, stderr })
)))
const isFile = (p) => fs.stat(p).then((s) => s.isFile(), () => false)
const exists = (p) => fs.lstat(p).then(() => true, () => false)

async function setup(t, { platform = 'darwin' } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'openrod-gateway-docker-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const home = path.join(dir, 'home'), prefix = path.join(dir, 'brew')
  const xdgFile = path.join(home, '.config/openshell/gateway.env'), prefixFile = path.join(prefix, 'var/openshell/gateway.env')
  for (const d of [path.dirname(xdgFile), path.dirname(prefixFile), path.join(prefix, 'opt/openshell/libexec'), path.join(prefix, 'bin'), path.join(home, '.docker/run')]) await fs.mkdir(d, { recursive: true })
  await fs.writeFile(path.join(prefix, 'opt/openshell/libexec/openshell-gateway-homebrew-service'), wrapperText(prefix))
  await fs.writeFile(path.join(prefix, 'bin/brew'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
  const socket = path.join(home, '.docker/run/docker.sock')
  await fs.writeFile(socket, '')
  const endpoint = `unix://${socket}`
  const fake = {
    platform, target: { name: 'openshell', endpoint: 'https://127.0.0.1:17670', remote: false },
    drivers: [{ name: 'vm', capabilities: { driverName: 'openshell-driver-vm' } }], version: '0.1.2',
    down: false, healthFailures: 0, engineId: 'DESKTOP', engines: { [endpoint]: 'DESKTOP' }, images: [], sandboxes: [], listFails: false,
    env: { HOME: home, PATH: '/usr/bin:/bin' }, listing: listing(prefix), launchd: 34124, listen: 17670, listener: null, plistEnv: false,
    brew: 'ok', gate: null, slowStart: 0, restarts: 0, busy: null, proc: {},
  }
  // The module swallows most command errors, so unexpected calls are checked after the test.
  const calls = [], jobs = [], unexpected = []
  t.after(() => assert.deepEqual(unexpected, []))
  let clock = 1_000_000, forgets = 0

  // The wrapper sources the env file with set -a; this mirrors that.
  async function reload() {
    const xdg = path.join(fake.env.XDG_CONFIG_HOME || path.join(fake.env.HOME, '.config'), 'openshell/gateway.env')
    const file = await isFile(xdg) ? xdg : await isFile(prefixFile) ? prefixFile : null
    const host = file ? readManaged(await fs.readFile(file, 'utf8')).effective : null
    if (host == null) delete fake.env.DOCKER_HOST
    else fake.env.DOCKER_HOST = host
  }
  async function restart() {
    fake.restarts++
    if (fake.gate) await fake.gate
    if (fake.brew === 'fail') return { code: 1, stdout: '', stderr: 'Error: Failure while executing\nBootstrap failed: 5: Input/output error\n' }
    if (fake.brew === 'down') fake.down = true
    fake.healthFailures = fake.slowStart
    if (fake.brew !== 'ignore') await reload()
    return { code: 0, stdout: '==> Successfully started `openshell`\n', stderr: '' }
  }
  const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' })
  async function run(file, args, options = {}) {
    const name = path.basename(file)
    calls.push({ name, args, options })
    if (name === 'ps' && args[0] === '-ww') return ok(fake.listing)
    if (name === 'ps' && args[0] === 'eww') return ok(`${DRIVER} ${Object.entries(fake.env).map(([k, v]) => `${k}=${v}`).join(' ')}\n`)
    if (file === '/bin/launchctl' && args[0] === 'print') return fake.launchd ? ok(`gui/501/${LABEL} = {\n\tactive count = 1\n\tpid = ${fake.launchd}\n\tstate = running\n}\n`) : { code: 113, stdout: '', stderr: 'Could not find service\n' }
    if (name === 'lsof' && args.includes('-p')) return ok(`p${args[args.indexOf('-p') + 1]}\nf9\nn127.0.0.1:${fake.listen}\n`)
    if (name === 'lsof') return ok(fake.listener ? `p${fake.listener}\n` : '')
    if (name === 'plutil') return fake.plistEnv ? ok('{"OPENSHELL_X":"1"}') : { code: 1, stdout: '', stderr: 'No value at that key path\n' }
    if (file === '/bin/sh') return sh(file, args, options)
    if (file === path.join(prefix, 'bin/brew') && args.join(' ') === 'services restart openshell') return restart()
    unexpected.push(`${file} ${args.join(' ')}`)
    throw new Error(`unexpected command: ${file}`)
  }
  async function docker(args, { engine } = {}) {
    calls.push({ name: 'docker', args, engine })
    if (args[0] === 'info') {
      const id = fake.engines[engine.endpoint]
      if (id === undefined) throw new Error('Cannot connect to the Docker daemon')
      return JSON.stringify({ ID: id })
    }
    if (args[0] === 'image' && args[1] === 'inspect') {
      if (engine.endpoint === endpoint && fake.images.includes(args.at(-1))) return 'sha256:1\n'
      throw new Error(`No such image: ${args.at(-1)}`)
    }
    unexpected.push(`docker ${args.join(' ')}`)
    throw new Error('unexpected docker')
  }
  const client = async () => ({
    raw: { getGatewayInfo: async () => ({ computeDrivers: fake.drivers }) },
    health: async () => {
      if (fake.down) throw new Error('unavailable')
      if (fake.healthFailures > 0) { fake.healthFailures--; throw new Error('connection refused') }
      return { status: 'healthy', version: fake.version }
    },
  })
  const stateFile = path.join(dir, 'state/gateway-docker.json')
  const make = (extra = {}) => createGatewayDocker({
    platform: fake.platform, home, uid: 501, target: async () => fake.target, client, forget: () => { forgets++ },
    sandboxes: async () => { if (fake.listFails) throw new Error('listing failed'); return fake.sandboxes },
    localEngine: async () => ({ endpoint, engineId: fake.engineId, architecture: 'arm64' }), docker, run,
    busy: () => fake.busy, stateFile, onJob: (p) => jobs.push(p), now: () => clock, wait: async (ms) => { clock += ms },
    logger: { warn() {} }, readProc: async (pid, name) => { if (fake.proc[`${pid}/${name}`] === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return Buffer.from(fake.proc[`${pid}/${name}`]) },
    ...extra,
  })
  return {
    dir, home, prefix, xdgFile, prefixFile, socket, endpoint, fake, calls, jobs, stateFile, make,
    tick: (ms) => { clock += ms }, clock: () => clock, forgets: () => forgets,
    count: (name, first) => calls.filter((c) => c.name === name && (!first || c.args[0] === first)).length,
  }
}
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r }); return { promise, resolve } }
const flush = () => new Promise((r) => setImmediate(r))

test('picks the VM driver whose parent is the gateway and ignores VM launchers', () => {
  const procs = parseProcesses(`${listing('/opt/homebrew')}  777     1 ${VM} --bind-socket /tmp/stray.sock\n`)
  assert.equal(procs.length, 6)
  const found = findDriver(procs)
  assert.equal(found.gateway.pid, 34124)
  assert.equal(found.driver.pid, 34228)
  assert.equal(findDriver(parseProcesses(' 1533 34228 /x/openshell-driver-vm --internal-run-vm\n34124 1 /x/openshell-gateway\n')), null)
})

test('disambiguates two gateways by the endpoint listener and reports ambiguity otherwise', async (t) => {
  const two = `${listing('/opt/homebrew')}40000     1 /usr/local/bin/openshell-gateway --config /tmp/g.toml\n40001 40000 ${DRIVER}\n`
  const procs = parseProcesses(two)
  assert.deepEqual(findDriver(procs), { ambiguous: true })
  assert.equal(findDriver(procs, { listener: 40000 }).driver.pid, 40001)
  assert.deepEqual(findDriver(procs, { listener: 1 }), { ambiguous: true })

  const env = await setup(t)
  env.fake.listing = `${listing(env.prefix)}40000     1 /usr/local/bin/openshell-gateway --config /tmp/g.toml\n40001 40000 ${DRIVER}\n`
  const gd = env.make()
  assert.equal((await gd.status()).state, 'unknown')
  env.fake.listener = 34124
  const s = await gd.status({ fresh: true })
  assert.equal(s.state, 'mismatch')
  assert.ok(env.calls.some((c) => c.name === 'lsof' && c.args.includes('-iTCP:17670')))
})

test('reads DOCKER_HOST, HOME and XDG_CONFIG_HOME from ps eww output, including values with spaces', () => {
  const out = `${DRIVER} DOCKER_HOST=unix:///Users/a b/.docker/run/docker.sock HOME=/Users/a b XDG_CONFIG_HOME=/Users/a b/My Config PATH=/usr/bin:/bin\n`
  assert.equal(envValue(out, 'DOCKER_HOST'), 'unix:///Users/a b/.docker/run/docker.sock')
  assert.equal(envValue(out, 'HOME'), '/Users/a b')
  assert.equal(envValue(out, 'XDG_CONFIG_HOME'), '/Users/a b/My Config')
  assert.equal(envValue(out, 'PATH'), '/usr/bin:/bin')
  assert.equal(envValue(out, 'SHELL'), undefined)
  assert.equal(envValue(`${DRIVER} DOCKER_HOST= HOME=/h`, 'DOCKER_HOST'), '')
})

test('treats ps output without HOME or PATH as an unreadable environment', async (t) => {
  const env = await setup(t)
  env.fake.env = {}
  const gd = env.make()
  const s = await gd.status()
  assert.equal(s.driver.source, 'default')
  assert.equal(s.driver.dockerHost, null)
  await fs.writeFile(env.xdgFile, `${MARK}\nDOCKER_HOST=${env.endpoint}\n`)
  const again = await gd.status({ fresh: true })
  assert.equal(again.driver.source, 'file')
  assert.equal(again.state, 'ok')
})

test('reads a NUL-separated /proc environ', () => {
  assert.deepEqual(procEnviron(Buffer.from('HOME=/home/a\0PATH=/usr/bin\0EMPTY=\0X=a=b\0')), { HOME: '/home/a', PATH: '/usr/bin', EMPTY: '', X: 'a=b' })
  assert.deepEqual(procEnviron(Buffer.alloc(0)), {})
})

test('driver socket follows bollard: unix DOCKER_HOST wins; empty, tcp, ssh and unset fall back to /var/run/docker.sock', () => {
  assert.equal(driverSocket('unix:///Users/me/.docker/run/docker.sock'), '/Users/me/.docker/run/docker.sock')
  for (const h of ['', 'tcp://127.0.0.1:2375', 'ssh://me@host', undefined, null]) assert.equal(driverSocket(h), '/var/run/docker.sock')
})

test('parses the Homebrew wrapper and refuses one it does not recognise', () => {
  assert.equal(wrapperPrefixFile(wrapperText('/opt/homebrew')), '/opt/homebrew/var/openshell/gateway.env')
  assert.equal(wrapperPrefixFile(wrapperText('/opt/homebrew').replace('elif [ -f "${prefix_gateway_env}" ]; then', 'else')), null)
  assert.equal(wrapperPrefixFile(wrapperText('/opt/$PREFIX')), null)
  assert.equal(wrapperPrefixFile(''), null)
  assert.equal(brewPrefix('/opt/homebrew/opt/openshell/bin/openshell-gateway --config /x'), '/opt/homebrew')
  assert.equal(brewPrefix('/usr/local/bin/openshell-gateway'), null)
})

test('env file choice mirrors the wrapper: XDG when present, prefix when only it exists, XDG created when neither', async (t) => {
  const pick = (xdgIsFile, prefixIsFile) => chooseEnvFile({ xdgFile: 'x', prefixFile: 'p', xdgIsFile, prefixIsFile })
  assert.deepEqual([pick(true, true), pick(false, true), pick(false, false), pick(true, false)], ['x', 'p', 'x', 'x'])
  assert.equal(chooseEnvFile({ xdgFile: 'x', prefixFile: null, xdgIsFile: false, prefixIsFile: false }), 'x')

  const env = await setup(t)
  const gd = env.make()
  assert.equal((await gd.status()).steps.file, '~/.config/openshell/gateway.env')
  await fs.writeFile(env.prefixFile, 'OPENSHELL_COMPUTE_DRIVER=vm\n')
  assert.equal((await gd.status({ fresh: true })).steps.file, env.prefixFile)
  await fs.writeFile(env.xdgFile, '')
  assert.equal((await gd.status({ fresh: true })).steps.file, '~/.config/openshell/gateway.env')
})

test('XDG_CONFIG_HOME from the service environment moves the XDG file', async (t) => {
  const env = await setup(t)
  env.fake.env.XDG_CONFIG_HOME = path.join(env.dir, 'conf dir')
  const s = await env.make().status()
  assert.equal(s.steps.file, path.join(env.dir, 'conf dir/openshell/gateway.env'))
  assert.equal(s.steps.append, `mkdir -p '${path.join(env.dir, 'conf dir/openshell')}' && printf '\\n%s\\n' 'DOCKER_HOST=${env.endpoint}' >> '${path.join(env.dir, 'conf dir/openshell/gateway.env')}'`)
})

test('writing the managed line twice is idempotent and keeps other lines and comments', () => {
  const text = '# my settings\nOPENSHELL_COMPUTE_DRIVER=vm\n\nRUST_LOG=info'
  const once = writeManaged(text, 'unix:///Users/me/.docker/run/docker.sock')
  assert.equal(once, `${text}\n${MARK}\nDOCKER_HOST=unix:///Users/me/.docker/run/docker.sock\n`)
  assert.equal(writeManaged(once, 'unix:///Users/me/.docker/run/docker.sock'), once)
  assert.deepEqual(readManaged(once), { managed: 'unix:///Users/me/.docker/run/docker.sock', foreign: [], effective: 'unix:///Users/me/.docker/run/docker.sock' })
  assert.equal(writeManaged('', 'unix:///a.sock'), `${MARK}\nDOCKER_HOST=unix:///a.sock\n`)
})

test('a new engine replaces only the managed block, which stays last', () => {
  const text = `A=1\r\n${MARK}\nDOCKER_HOST=unix:///old.sock\nB=2\n`
  const next = writeManaged(text, 'unix:///new.sock')
  assert.equal(next, `A=1\r\nB=2\n${MARK}\nDOCKER_HOST=unix:///new.sock\n`)
  assert.equal(readManaged(next).managed, 'unix:///new.sock')
})

test('a foreign DOCKER_HOST is reported, never removed, and a confirmed connect appends an override', async (t) => {
  const env = await setup(t)
  const before = 'OPENSHELL_COMPUTE_DRIVER=vm\nDOCKER_HOST=unix:///var/run/docker.sock\n'
  await fs.writeFile(env.xdgFile, before)
  env.fake.env.DOCKER_HOST = 'unix:///var/run/docker.sock'
  const gd = env.make()
  const s = await gd.status()
  assert.equal(s.state, 'mismatch')
  assert.deepEqual(s.conflict, { dockerHost: 'unix:///var/run/docker.sock', source: 'file' })
  assert.equal(s.fix, 'confirm')
  await assert.rejects(gd.connect({}), (e) => e.status === 409 && e.code === 'GATEWAY_DOCKER_MISMATCH' && e.fix === 'confirm')
  assert.equal(env.fake.restarts, 0)

  await gd.connect({ confirm: true, seen: [] })
  await env.jobs[0]
  const after = await fs.readFile(env.xdgFile, 'utf8')
  assert.equal(after, `${before}${MARK}\nDOCKER_HOST=${env.endpoint}\n`)
  assert.deepEqual(readManaged(after).foreign, ['DOCKER_HOST=unix:///var/run/docker.sock'])
  assert.equal((await gd.status()).state, 'ok')

  // A DOCKER_HOST set outside the file is a conflict too.
  const other = await setup(t)
  other.fake.env.DOCKER_HOST = 'tcp://10.0.0.2:2375'
  assert.deepEqual((await other.make().status()).conflict, { dockerHost: 'tcp://10.0.0.2:2375', source: 'process' })
})

test('a foreign DOCKER_HOST after the managed block moves the block last on a confirmed connect', async (t) => {
  const env = await setup(t)
  const before = `OPENSHELL_COMPUTE_DRIVER=vm\n${MARK}\nDOCKER_HOST=${env.endpoint}\nDOCKER_HOST=unix:///var/run/docker.sock\n`
  await fs.writeFile(env.xdgFile, before)
  env.fake.env.DOCKER_HOST = 'unix:///var/run/docker.sock'
  const gd = env.make()
  const s = await gd.status()
  assert.equal(s.state, 'mismatch')
  assert.equal(s.pending, false)
  await gd.connect({ confirm: true, seen: [] })
  await env.jobs[0]
  assert.equal(await fs.readFile(env.xdgFile, 'utf8'), `OPENSHELL_COMPUTE_DRIVER=vm\nDOCKER_HOST=unix:///var/run/docker.sock\n${MARK}\nDOCKER_HOST=${env.endpoint}\n`)
  const after = await gd.status()
  assert.equal(after.job.status, 'done')
  assert.equal(after.state, 'ok')
  assert.equal(env.fake.restarts, 1)
})

test('the manual append step survives a missing final newline and a missing directory', async (t) => {
  const env = await setup(t)
  env.fake.env.XDG_CONFIG_HOME = path.join(env.dir, 'conf dir')
  const file = path.join(env.dir, 'conf dir/openshell/gateway.env')
  const { append } = (await env.make().status()).steps
  const source = (f) => sh('/bin/sh', ['-c', 'set -eu; set -a; . "$1"; printf %s "$DOCKER_HOST|${OPENSHELL_X-}"', 'check', f])

  const r = await sh('/bin/sh', ['-c', append])
  assert.equal(r.code, 0)
  assert.equal((await fs.readFile(file, 'utf8')).endsWith(`DOCKER_HOST=${env.endpoint}\n`), true)
  assert.equal((await source(file)).stdout, `${env.endpoint}|`)

  await fs.writeFile(file, 'OPENSHELL_X=foo')
  assert.equal((await sh('/bin/sh', ['-c', append])).code, 0)
  assert.equal((await source(file)).stdout, `${env.endpoint}|foo`)
})

test('undo removes only the managed block and deletes a file OpenRod created', async (t) => {
  assert.equal(writeManaged(`A=1\n${MARK}\nDOCKER_HOST=unix:///a.sock\nB=2\n`, null), 'A=1\nB=2\n')

  const env = await setup(t)
  const gd = env.make()
  await gd.ensure()
  assert.equal(await fs.readFile(env.xdgFile, 'utf8'), `${MARK}\nDOCKER_HOST=${env.endpoint}\n`)
  const connected = await gd.status()
  assert.equal(connected.lastChange.kind, 'connect')
  assert.equal(connected.lastChange.undoable, true)

  await gd.undo({ confirm: true, seen: [] })
  await env.jobs[1]
  assert.equal(await exists(env.xdgFile), false)
  assert.equal(env.fake.env.DOCKER_HOST, undefined)
  const s = await gd.status({ fresh: true })
  assert.equal(s.lastChange.kind, 'undo')
  assert.equal(s.lastChange.undoable, false)
  const saved = JSON.parse(await fs.readFile(env.stateFile, 'utf8'))
  assert.deepEqual(saved.declined, ['DESKTOP'])
  assert.equal(saved.undo, null)
  await assert.rejects(gd.undo({ confirm: true }), /Edit the file yourself to undo/)

  // An existing file keeps everything but the block.
  const kept = await setup(t)
  await fs.writeFile(kept.xdgFile, 'OPENSHELL_COMPUTE_DRIVER=vm\n')
  const gd2 = kept.make()
  await gd2.ensure()
  await gd2.undo({ confirm: true })
  await kept.jobs[1]
  assert.equal(await fs.readFile(kept.xdgFile, 'utf8'), 'OPENSHELL_COMPUTE_DRIVER=vm\n')
})

test('a second connect to a file OpenRod created still deletes it on undo', async (t) => {
  const env = await setup(t)
  await env.make().ensure()
  const orb = path.join(env.home, '.orbstack/run/docker.sock')
  await fs.mkdir(path.dirname(orb), { recursive: true })
  await fs.writeFile(orb, '')
  env.fake.engines[`unix://${orb}`] = 'ORB'
  const gd = env.make({ localEngine: async () => ({ endpoint: `unix://${orb}`, engineId: 'ORB', architecture: 'arm64' }) })
  assert.equal((await gd.ensure()).state, 'ok')
  assert.equal(await fs.readFile(env.xdgFile, 'utf8'), `${MARK}\nDOCKER_HOST=unix://${orb}\n`)
  assert.equal(JSON.parse(await fs.readFile(env.stateFile, 'utf8')).undo.created, true)
  await gd.undo({ confirm: true })
  await env.jobs[2]
  assert.equal(await exists(env.xdgFile), false)
})

test('a prefix-only gateway.env is edited in place and the XDG file is never created', async (t) => {
  const env = await setup(t)
  await fs.writeFile(env.prefixFile, 'OPENSHELL_COMPUTE_DRIVER=vm\n')
  const gd = env.make()
  assert.equal((await gd.ensure()).state, 'ok')
  assert.equal(await fs.readFile(env.prefixFile, 'utf8'), `OPENSHELL_COMPUTE_DRIVER=vm\n${MARK}\nDOCKER_HOST=${env.endpoint}\n`)
  assert.equal(await exists(env.xdgFile), false)
  await gd.undo({ confirm: true })
  await env.jobs[1]
  assert.equal(await fs.readFile(env.prefixFile, 'utf8'), 'OPENSHELL_COMPUTE_DRIVER=vm\n')
  assert.equal(await exists(env.xdgFile), false)
})

test('a managed line the service never loaded is restarted without a rewrite', async (t) => {
  const env = await setup(t)
  await fs.writeFile(env.xdgFile, `${MARK}\nDOCKER_HOST=${env.endpoint}\n`)
  const gd = env.make()
  const s = await gd.status()
  assert.equal(s.pending, true)
  assert.equal(s.fix, 'auto')
  const done = await gd.ensure()
  assert.equal(done.state, 'ok')
  assert.equal(env.count('sh'), 0)
  assert.equal(env.fake.restarts, 1)
  assert.equal(done.lastChange.undoable, true)
  assert.deepEqual(JSON.parse(await fs.readFile(env.stateFile, 'utf8')).undo, { file: env.xdgFile, created: false })
})

test('a dangling gateway.env symlink is never replaced', async (t) => {
  const env = await setup(t)
  const target = path.join(env.dir, 'dotfiles/gateway.env')
  await fs.symlink(target, env.xdgFile)
  const s = await env.make().status()
  assert.equal(s.fix, 'manual')
  assert.equal(s.blocked, 'OpenRod can’t write ~/.config/openshell/gateway.env.')
  await assert.rejects(writeEnvFile(env.xdgFile, 'A=1\n', ''), /can’t write/)
  assert.equal((await fs.lstat(env.xdgFile)).isSymbolicLink(), true)
  assert.equal(await exists(target), false)
})

test('a state file holding null reads as empty', async (t) => {
  const env = await setup(t)
  await fs.mkdir(path.dirname(env.stateFile), { recursive: true })
  await fs.writeFile(env.stateFile, 'null\n')
  const gd = env.make()
  assert.equal((await gd.status()).fix, 'auto')
  await gd.assertLaunch({ built: true })
  assert.equal(env.fake.env.DOCKER_HOST, env.endpoint)
})

test('quote leaves safe values bare, single-quotes others, and refuses quotes and newlines', () => {
  assert.equal(quote('unix:///Users/me/.docker/run/docker.sock'), 'unix:///Users/me/.docker/run/docker.sock')
  assert.equal(quote('unix:///Users/a b/docker.sock'), "'unix:///Users/a b/docker.sock'")
  assert.equal(quote('unix:///x/$HOME/d.sock'), "'unix:///x/$HOME/d.sock'")
  for (const bad of ["unix:///it's.sock", 'unix:///a\nB=1', 'unix:///a\rb', 'unix:///a\0b', '']) assert.throws(() => quote(bad), { status: 409 })
})

test('writes keep the file mode, follow a symlink to the real file and keep a one-time backup', async (t) => {
  const env = await setup(t)
  const real = path.join(env.dir, 'dotfiles/gateway.env')
  await fs.mkdir(path.dirname(real))
  await fs.writeFile(real, 'A=1\n', { mode: 0o640 })
  await fs.chmod(real, 0o640)
  await fs.symlink(real, env.xdgFile)
  assert.equal(await writeEnvFile(env.xdgFile, 'A=2\n', 'A=1\n'), await fs.realpath(real))
  assert.equal((await fs.lstat(env.xdgFile)).isSymbolicLink(), true)
  assert.equal(await fs.readFile(real, 'utf8'), 'A=2\n')
  assert.equal((await fs.stat(real)).mode & 0o777, 0o640)
  assert.equal(await fs.readFile(`${real}.openrod.bak`, 'utf8'), 'A=1\n')
  assert.equal((await fs.stat(`${real}.openrod.bak`)).mode & 0o777, 0o640)
  await writeEnvFile(env.xdgFile, 'A=3\n', 'A=2\n')
  assert.equal(await fs.readFile(`${real}.openrod.bak`, 'utf8'), 'A=1\n')
  assert.deepEqual((await fs.readdir(path.dirname(real))).sort(), ['gateway.env', 'gateway.env.openrod.bak'])

  const fresh = path.join(env.dir, 'new/openshell/gateway.env')
  await writeEnvFile(fresh, 'B=1\n', '')
  assert.equal((await fs.stat(fresh)).mode & 0o777, 0o600)
  assert.equal((await fs.stat(path.dirname(fresh))).mode & 0o777, 0o700)
  assert.equal(await exists(`${fresh}.openrod.bak`), false)
})

test('refuses to write when the file changed since it was read', async (t) => {
  const env = await setup(t)
  await fs.writeFile(env.xdgFile, 'A=edited\n')
  await assert.rejects(writeEnvFile(env.xdgFile, 'A=2\n', 'A=1\n'), { status: 409, message: 'OpenShell’s settings file changed while OpenRod was editing it. Try again.' })
  assert.equal(await fs.readFile(env.xdgFile, 'utf8'), 'A=edited\n')
  assert.deepEqual(await fs.readdir(path.dirname(env.xdgFile)), ['gateway.env'])
})

test('a file that fails set -eu sourcing is never installed', async (t) => {
  const env = await setup(t)
  const check = (expect) => (temp) => validateEnvFile(sh, temp, { home: env.home, expect })
  await fs.writeFile(env.xdgFile, 'A=1\n')
  await writeEnvFile(env.xdgFile, writeManaged('A=1\n', env.endpoint), 'A=1\n', check(env.endpoint))
  assert.equal(readManaged(await fs.readFile(env.xdgFile, 'utf8')).managed, env.endpoint)

  const bad = 'LOG_DIR=$OPENROD_TEST_UNSET/logs\n'
  await fs.writeFile(env.xdgFile, bad)
  await assert.rejects(writeEnvFile(env.xdgFile, writeManaged(bad, env.endpoint), bad, check(env.endpoint)), { unsafe: true })
  assert.equal(await fs.readFile(env.xdgFile, 'utf8'), bad)
  assert.equal((await fs.readdir(path.dirname(env.xdgFile))).some((f) => f.endsWith('.tmp')), false)

  // Through the automatic fix: nothing is written or restarted, and the fix turns manual.
  const gd = env.make()
  await gd.ensure()
  const s = await gd.status({ fresh: true })
  assert.equal(s.job.status, 'failed')
  assert.match(s.job.error, /can’t check/)
  assert.equal(env.fake.restarts, 0)
  assert.equal(await fs.readFile(env.xdgFile, 'utf8'), bad)
  assert.equal(s.fix, 'manual')
})

test('engines match by ID and fall back to socket paths when IDs are empty', async (t) => {
  const env = await setup(t)
  const other = path.join(env.dir, 'other.sock')
  await fs.writeFile(other, '')
  env.fake.env.DOCKER_HOST = `unix://${other}`
  env.fake.engines[`unix://${other}`] = 'DESKTOP'
  const gd = env.make()
  const s = await gd.status()
  assert.equal(s.state, 'ok')
  assert.equal(s.driver.engineId, 'DESKTOP')

  env.fake.engines[`unix://${other}`] = 'SOMETHING-ELSE'
  assert.equal((await gd.status({ fresh: true })).state, 'mismatch')

  const link = path.join(env.dir, 'link.sock')
  await fs.symlink(env.socket, link)
  env.fake.env.DOCKER_HOST = `unix://${link}`
  env.fake.engineId = ''
  env.fake.engines = { [env.endpoint]: '', [`unix://${link}`]: '' }
  const linked = await gd.status({ fresh: true })
  assert.equal(linked.state, 'ok')
  assert.equal(linked.driver.engineId, null)
})

test('status is n/a for remote targets, non-VM drivers, unsupported platforms and fixed versions', async (t) => {
  const env = await setup(t)
  env.fake.target = { ...env.fake.target, remote: true }
  assert.equal((await env.make().status()).state, 'n/a')
  env.fake.target = null
  assert.equal((await env.make().status()).state, 'n/a')
  env.fake.target = { name: 'openshell', endpoint: 'https://127.0.0.1:17670', remote: false }
  env.fake.drivers = [{ name: 'docker', capabilities: { driverName: 'openshell-driver-docker' } }]
  assert.equal((await env.make().status()).state, 'n/a')
  env.fake.drivers = [{ name: 'vm' }]
  assert.equal((await env.make({ platform: 'win32' }).status()).state, 'n/a')
  assert.equal(env.count('ps'), 0)
  // FIXED_IN is unset until upstream ships the fix, so every version is checked.
  assert.equal(newer('0.1.3', '0.1.2'), true)
  assert.equal(newer('0.1.2', 'v0.1.2'), false)
  assert.equal(newer('0.2.0', '0.10.0'), false)
  assert.equal(newer('0.1.3', 'dev'), false)
  env.fake.version = '9.9.9'
  assert.equal((await env.make().status()).state, 'mismatch')
})

test('mismatch is fixed automatically when the service is loaded, nothing runs and DOCKER_HOST is unset or managed', async (t) => {
  const env = await setup(t)
  const gd = env.make()
  const s = await gd.status()
  assert.equal(s.state, 'mismatch')
  assert.equal(s.fix, 'auto')
  assert.equal(s.alternative, 'docker-desktop-socket')
  assert.deepEqual(s.steps, {
    file: '~/.config/openshell/gateway.env', line: `DOCKER_HOST=${env.endpoint}`,
    append: `mkdir -p '${path.dirname(env.xdgFile)}' && printf '\\n%s\\n' 'DOCKER_HOST=${env.endpoint}' >> '${env.xdgFile}'`, restart: 'brew services restart openshell',
  })
  const done = await gd.ensure()
  assert.equal(done.state, 'ok')
  assert.equal(done.job.status, 'done')
  assert.equal(done.lastChange.auto, true)
  assert.equal(env.fake.restarts, 1)

  const old = await setup(t)
  await fs.writeFile(old.xdgFile, `${MARK}\nDOCKER_HOST=unix:///Users/old/.colima/docker.sock\n`)
  old.fake.env.DOCKER_HOST = 'unix:///Users/old/.colima/docker.sock'
  const managed = await old.make().status()
  assert.equal(managed.conflict, null)
  assert.equal(managed.fix, 'auto')
})

test('running sandboxes, stranded images, a foreign DOCKER_HOST, an earlier undo or a failed sandbox listing require confirmation', async (t) => {
  const env = await setup(t)
  const gd = env.make()
  const fix = async () => (await gd.status({ fresh: true })).fix
  assert.equal(await fix(), 'auto')
  env.fake.sandboxes = [{ name: 'a', workspace: 'default', phase: 'ready', image: 'ubuntu:24.04' }]
  assert.equal(await fix(), 'confirm')
  env.fake.sandboxes = [{ name: 'a', workspace: 'default', phase: 'stopped', image: 'ubuntu:24.04' }]
  assert.equal(await fix(), 'auto')
  env.fake.listFails = true
  assert.equal(await fix(), 'confirm')
  assert.equal((await gd.status()).sandboxes, null)
  env.fake.listFails = false
  assert.equal(decideFix({ platform: 'darwin', service: true, plistOk: true, prefixOk: true, brew: '/b', fileOk: true, quotable: true, sandboxes: [], stranded: [{ name: 'x' }] }).fix, 'confirm')
  await fs.writeFile(env.xdgFile, 'DOCKER_HOST=tcp://10.0.0.2:2375\n')
  assert.equal(await fix(), 'confirm')
  await fs.rm(env.xdgFile)
  assert.equal(await fix(), 'auto')

  await fs.mkdir(path.dirname(env.stateFile), { recursive: true })
  await fs.writeFile(env.stateFile, JSON.stringify({ version: 1, undo: null, declined: ['DESKTOP'], lastChange: null }))
  const declined = await env.make().status()
  assert.equal(declined.fix, 'confirm')
  assert.equal(await env.make().ensure().then((s) => s.state), 'mismatch')
  assert.equal(env.fake.restarts, 0)
})

test('a service that is not loaded, does not own the gateway pid, does not listen on the port, or has plist EnvironmentVariables needs manual steps', async (t) => {
  const env = await setup(t)
  const gd = env.make()
  const check = async (patch, blocked, restart) => {
    const saved = { ...env.fake }
    Object.assign(env.fake, patch)
    const s = await gd.status({ fresh: true })
    assert.equal(s.fix, 'manual')
    assert.equal(s.blocked, blocked)
    assert.ok(s.steps.line)
    assert.equal(s.steps.restart, restart)
    Object.assign(env.fake, saved)
  }
  await check({ launchd: null }, 'OpenShell isn’t running as a Homebrew service.', null)
  await check({ launchd: 999 }, 'OpenShell isn’t running as a Homebrew service.', null)
  await check({ listen: 1 }, 'OpenShell isn’t running as a Homebrew service.', null)
  await check({ plistEnv: true }, 'This OpenShell setup is different from what OpenRod expects.', `launchctl kickstart -k gui/501/${LABEL}`)
  assert.equal((await gd.status({ fresh: true })).fix, 'auto')
  env.fake.launchd = null
  await assert.rejects(gd.connect({ confirm: true, seen: [] }), (e) => e.code === 'GATEWAY_DOCKER_MISMATCH' && e.fix === 'manual' && e.message === 'OpenShell isn’t running as a Homebrew service.')
  assert.equal(env.fake.restarts, 0)
})

test('Linux always needs manual steps and shows the systemd restart when the gateway runs in its unit', async (t) => {
  const env = await setup(t, { platform: 'linux' })
  env.fake.proc['34228/environ'] = `HOME=${env.home}\0PATH=/usr/bin\0SECRET=never-kept\0`
  const gd = env.make()
  const s = await gd.status()
  assert.equal(s.state, 'mismatch')
  assert.equal(s.fix, 'manual')
  assert.equal(s.blocked, 'Add one setting to OpenShell and restart it.')
  assert.equal(s.steps.file, '~/.config/openshell/gateway.env')
  assert.equal(s.steps.restart, null)
  assert.equal(s.alternative, null)
  assert.equal(JSON.stringify(s).includes('never-kept'), false)
  env.fake.proc['34124/cgroup'] = '0::/user.slice/user-1000.slice/user@1000.service/app.slice/openshell-gateway.service\n'
  assert.equal((await gd.status({ fresh: true })).steps.restart, 'systemctl --user restart openshell-gateway')
  assert.equal(env.calls.some((c) => c.name === 'launchctl' || c.name === 'plutil'), false)
  await gd.ensure()
  assert.equal(env.fake.restarts, 0)
})

test('lists sandboxes whose template images the build engine lacks', async (t) => {
  const env = await setup(t)
  env.fake.sandboxes = [
    { name: 'a', workspace: 'default', phase: 'ready', image: 'openshell-template/foo:1' },
    { name: 'b', workspace: 'team', phase: 'provisioning', image: 'openshell-template/bar:1' },
    { name: 'c', workspace: 'default', phase: 'stopped', image: 'openshell-template/baz:1' },
    { name: 'd', workspace: 'default', phase: 'ready', image: 'ubuntu:24.04' },
    { name: 'e', workspace: 'team', phase: 'starting', image: 'openshell-template/foo:1' },
  ]
  env.fake.images = ['openshell-template/bar:1']
  const s = await env.make().status()
  assert.deepEqual(s.stranded, [
    { name: 'a', workspace: 'default', image: 'openshell-template/foo:1' },
    { name: 'e', workspace: 'team', image: 'openshell-template/foo:1' },
  ])
  assert.deepEqual(s.sandboxes.map((x) => x.name), ['a', 'b', 'd', 'e'])
  assert.equal(env.calls.filter((c) => c.name === 'docker' && c.args[0] === 'image').length, 2)
})

test('connect writes, restarts with brew services, waits for health and verifies the driver environment', async (t) => {
  const env = await setup(t)
  const gd = env.make()
  env.fake.slowStart = 3
  const started = await gd.connect({})
  assert.equal(started.state, 'working')
  assert.equal(started.job.kind, 'connect')
  const done = await env.jobs[0]
  assert.equal(done.state, 'ok')
  assert.equal(done.job.status, 'done')
  assert.equal(done.lastChange.auto, false)
  assert.equal(env.fake.env.DOCKER_HOST, env.endpoint)
  const brew = env.calls.find((c) => c.name === 'brew')
  assert.deepEqual(brew.args, ['services', 'restart', 'openshell'])
  assert.equal(brew.options.env.HOMEBREW_NO_AUTO_UPDATE, '1')
  assert.equal(brew.options.timeoutMs, 120_000)
  assert.ok(env.forgets() >= 1)
  assert.equal(env.fake.restarts, 1)
  const order = env.calls.map((c) => c.name).filter((n) => ['sh', 'brew'].includes(n))
  assert.deepEqual(order, ['sh', 'brew'])
  const saved = JSON.parse(await fs.readFile(env.stateFile, 'utf8'))
  assert.deepEqual(saved.undo, { file: env.xdgFile, created: true })
  assert.equal(saved.lastChange.kind, 'connect')
})

test('connect is refused when a sandbox started after the user looked', async (t) => {
  const env = await setup(t)
  env.fake.sandboxes = [{ name: 'a', workspace: 'default', phase: 'ready' }]
  const gd = env.make()
  assert.equal((await gd.status()).fix, 'confirm')
  env.fake.sandboxes.push({ name: 'b', workspace: 'team', phase: 'provisioning' })
  await assert.rejects(gd.connect({ confirm: true, seen: ['default/a'] }), (e) => {
    assert.equal(e.code, 'GATEWAY_DOCKER_MISMATCH')
    assert.equal(e.fix, 'confirm')
    assert.deepEqual(e.sandboxes, [{ name: 'a', workspace: 'default' }, { name: 'b', workspace: 'team' }])
    assert.equal(e.message, 'Connecting restarts OpenShell and running sandboxes.')
    return true
  })
  assert.equal(env.fake.restarts, 0)
  await gd.connect({ confirm: true, seen: ['default/a', 'team/b'] })
  assert.equal((await env.jobs[0]).state, 'ok')
})

test('connect puts the file back and restarts again when health never returns within 60 seconds', async (t) => {
  const env = await setup(t)
  await fs.writeFile(env.xdgFile, 'A=1\n')
  env.fake.brew = 'down'
  const gd = env.make()
  const start = env.clock()
  await gd.connect({})
  const s = await env.jobs[0]
  assert.equal(s.job.status, 'failed')
  assert.equal(s.job.error, 'OpenShell didn’t come back within a minute. OpenRod put its settings back.')
  assert.equal(await fs.readFile(env.xdgFile, 'utf8'), 'A=1\n')
  assert.equal(env.fake.restarts, 2)
  // The second restart read the restored file.
  assert.equal(env.fake.env.DOCKER_HOST, undefined)
  assert.ok(env.clock() - start >= 60_000)
})

test('connect puts the file back without a second restart when the driver does not pick up the line', async (t) => {
  const env = await setup(t)
  env.fake.brew = 'ignore'
  const gd = env.make()
  await gd.connect({})
  const s = await env.jobs[0]
  assert.equal(s.job.error, 'OpenShell restarted but didn’t pick up the Docker setting. Use the steps instead.')
  assert.equal(env.fake.restarts, 1)
  assert.equal(await exists(env.xdgFile), false)
})

test('only one job runs at a time and ensure joins it', { timeout: 10_000 }, async (t) => {
  const env = await setup(t)
  const gate = deferred()
  env.fake.gate = gate.promise
  const gd = env.make()
  const first = gd.ensure(), second = gd.ensure()
  while (!env.fake.restarts) await flush()
  const working = await gd.status()
  assert.equal(working.state, 'working')
  assert.equal(working.job.stage, 'Restarting OpenShell…')
  assert.equal((await gd.connect({ confirm: true })).state, 'working')
  const third = gd.ensure()
  gate.resolve()
  const results = await Promise.all([first, second, third])
  assert.deepEqual(results.map((s) => s.state), ['ok', 'ok', 'ok'])
  assert.equal(env.fake.restarts, 1)
  assert.equal(env.jobs.length, 1)
})

test('connect is refused while a template is being saved', async (t) => {
  const env = await setup(t)
  env.fake.busy = 'saving'
  const gd = env.make()
  assert.equal((await gd.status()).fix, 'confirm')
  await assert.rejects(gd.connect({ confirm: true, seen: [] }), { status: 409, message: 'A template is being saved. Try again in a moment.' })
  env.fake.busy = 'connection'
  await assert.rejects(gd.connect({ confirm: true, seen: [] }), { status: 409, message: 'Wait for the connection change to finish.' })
  assert.equal((await gd.ensure()).state, 'mismatch')
  assert.equal(env.fake.restarts, 0)
  assert.equal(await exists(env.xdgFile), false)
})

test('a failed automatic connect is not retried automatically in the same process', async (t) => {
  const env = await setup(t)
  env.fake.brew = 'fail'
  const gd = env.make()
  const s = await gd.ensure()
  assert.equal(s.job.status, 'failed')
  assert.equal(s.job.error, 'OpenShell didn’t restart: Bootstrap failed: 5: Input/output error')
  assert.equal(env.fake.restarts, 1)
  assert.equal(await exists(env.xdgFile), false)
  const again = await gd.status({ fresh: true })
  assert.equal(again.fix, 'confirm')
  await gd.ensure()
  await assert.rejects(gd.assertLaunch({ built: true }), { code: 'GATEWAY_DOCKER_MISMATCH', fix: 'confirm' })
  assert.equal(env.fake.restarts, 1)
})

test('status is cached for 30 seconds and fresh forces a probe', async (t) => {
  const env = await setup(t)
  const gd = env.make()
  await Promise.all([gd.status(), gd.status()])
  assert.equal(env.count('ps', '-ww'), 1)
  env.tick(29_000)
  await gd.status()
  assert.equal(env.count('ps', '-ww'), 1)
  env.tick(2_000)
  await gd.status()
  assert.equal(env.count('ps', '-ww'), 2)
  await gd.status({ fresh: true })
  assert.equal(env.count('ps', '-ww'), 3)
})

test('assertLaunch waits for a running job, fails open when the state is unknown, and throws GATEWAY_DOCKER_MISMATCH for built or local-only images', { timeout: 10_000 }, async (t) => {
  const env = await setup(t)
  const gate = deferred()
  env.fake.gate = gate.promise
  const gd = env.make()
  void gd.ensure()
  while (!env.fake.restarts) await flush()
  let launched = false
  const launch = gd.assertLaunch({ built: true }).then(() => { launched = true })
  await flush()
  assert.equal(launched, false)
  gate.resolve()
  await launch
  assert.equal((await gd.status()).state, 'ok')

  const down = await setup(t)
  down.fake.down = true
  await down.make().assertLaunch({ built: true })

  const busy = await setup(t)
  busy.fake.sandboxes = [{ name: 'a', workspace: 'default', phase: 'ready' }]
  const gd2 = busy.make()
  await assert.rejects(gd2.assertLaunch({ built: true }), (e) => e.status === 409 && e.code === 'GATEWAY_DOCKER_MISMATCH' && e.fix === 'confirm' && e.sandboxes.length === 1
    && e.message === 'OpenShell can’t use your Docker images yet. Connect it to Docker, then try again.')
  await assert.rejects(gd2.assertLaunch({ localOnly: async () => true }), { code: 'GATEWAY_DOCKER_MISMATCH' })
  await gd2.assertLaunch({ built: false, localOnly: async () => false })
  assert.equal(busy.fake.restarts, 0)

  const auto = await setup(t)
  await auto.make().assertLaunch({ built: true })
  assert.equal(auto.fake.restarts, 1)
  assert.equal(auto.fake.env.DOCKER_HOST, auto.endpoint)
})
