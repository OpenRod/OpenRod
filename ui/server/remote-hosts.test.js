import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import net from 'node:net'
import { listSshHosts } from './remote-hosts.js'

const exec = promisify(execFile)
const modulePath = fileURLToPath(new URL('./remote-hosts.js', import.meta.url))
const version = '0.1.2'
const image = (kind) => ({ Os: 'linux', Architecture: 'amd64', RepoTags: [`ghcr.io/nvidia/openshell/${kind}:${version}`] })
const engine = { ID: 'engine-one', OSType: 'linux', Architecture: 'x86_64', KernelVersion: '6.8.0', OperatingSystem: 'Ubuntu', SecurityOptions: ['name=seccomp,profile=builtin'] }
const response = ({ info = engine, images = [null, null, null], socket = '/run/docker.sock', arch = 'x86_64' } = {}) => [
  'OPENSHELL_HOST_OS=Linux', `OPENSHELL_HOST_ARCH=${arch}`, 'OPENSHELL_HOST_KERNEL=6.8.0', `OPENSHELL_SOCKET=${socket}`,
  `OPENSHELL_ENGINE=${JSON.stringify(info)}`, ...images.map((value, index) => `OPENSHELL_IMAGE_${index}=${JSON.stringify(value)}`), '',
].join('\n')

async function fixture(t, sshProgram) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'remote-hosts-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(path.join(root, '.ssh'))
  await writeFile(path.join(root, '.ssh/config'), 'Host target\n  HostName 127.0.0.1\n')
  if (sshProgram) await writeFile(path.join(root, 'ssh'), `#!${process.execPath}\n${sshProgram}`, { mode: 0o700 })
  const env = { ...process.env, HOME: root, PATH: `${root}:/usr/bin:/bin`, REPORT: path.join(root, 'report'), PROBE: response() }
  const run = async (code, extra = {}) => {
    const { stdout } = await exec(process.execPath, ['--input-type=module', '-e', `import * as remote from ${JSON.stringify(modulePath)}; ${code}`], {
      env: { ...env, ...extra }, timeout: 10_000, maxBuffer: 1024 * 1024,
    })
    return JSON.parse(stdout)
  }
  return { root, env, run }
}

const shellSsh = `const {spawn} = require('node:child_process');
require('node:fs').writeFileSync(process.env.REPORT, JSON.stringify(process.argv.slice(2)));
const child = spawn('/bin/sh', ['-c', process.argv.at(-1)], {stdio:'inherit'});
child.on('exit', (code) => process.exit(code ?? 1));`
const catchError = (expression) => `try { console.log(JSON.stringify(await ${expression})) } catch(error) { console.log(JSON.stringify({error:error.message,status:error.status})) }`
const abortWhenStarted = (expression) => `
  const { watch } = await import('node:fs');
  const { dirname, basename } = await import('node:path');
  const controller = new AbortController();
  const ready = new Promise(resolve => {
    const watcher = watch(dirname(process.env.REPORT), (_event, filename) => {
      if (filename === basename(process.env.REPORT)) { watcher.close(); resolve(); }
    });
  });
  const outcome = ${expression}.then(value => ({value}), error => ({error:error.message,status:error.status}));
  await ready;
  // File creation can be observed before writeFileSync writes the PID.
  // Abort only after the test process has published its complete identity.
  const { readFile } = await import('node:fs/promises');
  const { setTimeout: delay } = await import('node:timers/promises');
  let pid;
  for (let attempt = 0; attempt < 100; attempt++) {
    const report = await readFile(process.env.REPORT, 'utf8');
    if (/^[1-9][0-9]*$/.test(report)) { pid = Number(report); break; }
    await delay(10);
  }
  if (!pid) throw new Error('SSH fixture did not publish its PID');
  controller.abort();
  console.log(JSON.stringify(await outcome));
`

test('SSH aliases include quoted and nested glob files, ignore patterns, and guard include cycles', async (t) => {
  const { root } = await fixture(t)
  await mkdir(path.join(root, '.ssh/parts'))
  await writeFile(path.join(root, '.ssh/config'), `# heading\nHost=primary "quoted" '*.wild' x?y !negated -option user@host bad;command\nInclude "parts/*.conf" # comment\nInclude "with space"\nHost primary\n`)
  await writeFile(path.join(root, '.ssh/parts/one.conf'), 'Host nested\nInclude config\n')
  await symlink(path.join(root, '.ssh/config'), path.join(root, '.ssh/parts/cycle.conf'))
  await writeFile(path.join(root, '.ssh/with space'), 'Host spaced-file\n')
  await writeFile(path.join(root, 'system.conf'), 'Host system\nInclude system.d/*\n')
  await mkdir(path.join(root, 'system.d'))
  await writeFile(path.join(root, 'system.d/one'), 'Host system-included\n')
  assert.deepEqual(listSshHosts({ homeDirectory: root, systemConfigPath: path.join(root, 'system.conf') }),
    ['nested', 'primary', 'quoted', 'spaced-file', 'system', 'system-included'].map((name) => ({ name })))
})

test('missing user config gives no hosts even if the system config names hosts', async (t) => {
  const { root } = await fixture(t)
  const systemConfigPath = path.join(root, '.ssh/config')
  assert.deepEqual(listSshHosts({ homeDirectory: path.join(root, 'absent'), systemConfigPath }), [])
})

test('malformed config quoting fails closed', async (t) => {
  const { root } = await fixture(t)
  await writeFile(path.join(root, '.ssh/config'), 'Host "unterminated\n')
  assert.throws(() => listSshHosts({ homeDirectory: root }), /Malformed quoting/)
})

test('remote commands reject unlisted and option-like aliases before spawning SSH', async (t) => {
  const { run, env } = await fixture(t, shellSsh)
  for (const host of ['unknown', '-oProxyCommand=touch', 'target;touch', 'target\nHost injected', 'user@target', '../target']) {
    const result = await run(catchError(`remote.runSsh(${JSON.stringify(host)}, 'true')`))
    assert.match(result.error, /concrete Host alias/)
  }
  await assert.rejects(readFile(env.REPORT), { code: 'ENOENT' })
})

test('commands preserve shell quoting while SSH retains user config with strict authentication', async (t) => {
  const { run, env } = await fixture(t, shellSsh)
  const value = `quote' dollar$ semicolon; newline\nend`
  const script = `printf '%s' '${value.replaceAll("'", "'\\''")}'`
  assert.equal(await run(catchError(`remote.runSsh('target', ${JSON.stringify(script)})`)), value)
  const args = JSON.parse(await readFile(env.REPORT, 'utf8'))
  for (const option of ['BatchMode=yes', 'StrictHostKeyChecking=yes', 'ForwardAgent=no', 'ControlPath=none']) assert.ok(args.includes(option))
  assert.equal(args.includes('-F'), false)
  assert.deepEqual(args.slice(-3, -1), ['--', 'target'])
})

test('SSH diagnostic failures, output overflow, and timeouts reject partial output', async (t) => {
  const { run } = await fixture(t, shellSsh)
  assert.match((await run(catchError(`remote.runSsh('target', "printf 'Permission denied (publickey)' >&2; exit 255")`))).error, /Permission denied.*trusted host key/)
  const commandFailure = await run(catchError(`remote.runSsh('target', "printf 'docker service failed' >&2; exit 1")`))
  assert.match(commandFailure.error, /Remote command.*docker service failed/)
  assert.doesNotMatch(commandFailure.error, /credentials|trusted host key/)
  assert.match((await run(catchError(`remote.runSsh('target', 'printf 123456789', {outputLimit:4})`))).error, /exceeded/)
  assert.match((await run(catchError(`remote.runSsh('target', 'sleep 30', {timeoutMs:100})`))).error, /timed out/)
})

test('abort kills the SSH process and reports cancellation', async (t) => {
  const { run, env } = await fixture(t, `const fs = require('node:fs'); fs.writeFileSync(process.env.REPORT, '');
setTimeout(() => fs.writeFileSync(process.env.REPORT, String(process.pid)), 100); setInterval(()=>{},1000)`)
  const result = await run(abortWhenStarted("remote.runSsh('target','true',{signal:controller.signal})"))
  assert.match(result.error, /cancelled/)
  const pid = Number(await readFile(env.REPORT, 'utf8'))
  assert.ok(Number.isSafeInteger(pid) && pid > 0)
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
})

test('probe is read-only and checks both pinned runtime platforms', async (t) => {
  const { run } = await fixture(t, 'process.stdout.write(process.env.PROBE)')
  const probe = await run(catchError(`remote.probeHost('target','${version}')`))
  assert.deepEqual(probe, { os: 'linux', arch: 'amd64', dockerSocket: '/run/docker.sock', runtimeReady: false, version, engineId: 'engine-one', dockerInstalled: true })
  assert.equal((await run(catchError(`remote.probeHost('target','${version}')`), { PROBE: response({ images: [image('sandbox'), image('supervisor'), image('gateway')] }) })).runtimeReady, true)
  assert.equal((await run(catchError(`remote.probeHost('target','${version}')`), { PROBE: response({ images: [image('sandbox'), { ...image('supervisor'), Architecture: 'arm64' }, image('gateway')] }) })).runtimeReady, false)
})

test('probe rejects incompatible daemons, unsafe sockets, and missing workload isolation', async (t) => {
  const { run } = await fixture(t, 'process.stdout.write(process.env.PROBE)')
  for (const [data, expected] of [
    [{ info: { ...engine, OSType: 'windows' } }, /native Linux/],
    [{ info: { ...engine, OperatingSystem: 'Docker Desktop' } }, /Docker Desktop/],
    [{ info: { ...engine, Architecture: 'aarch64' } }, /same supported architecture/],
    [{ info: { ...engine, SecurityOptions: [] } }, /seccomp/],
    [{ info: { ...engine, SecurityOptions: [...engine.SecurityOptions, 'name=rootless'] } }, /Rootless Docker/],
    [{ info: { ...engine, KernelVersion: '6.8.0-linuxkit' } }, /separate VM/],
    [{ info: { ...engine, ID: '' } }, /identity/],
    [{ socket: '/run/../docker.sock' }, /safe absolute/],
    [{ socket: '/run/docker.sock:8080' }, /safe absolute/],
  ]) assert.match((await run(catchError(`remote.probeHost('target','${version}')`), { PROBE: response(data) })).error, expected)
  assert.match((await run(catchError(`remote.probeHost('target', 'latest; touch /tmp/injected')`))).error, /pinned release version/)
})

test('probe executes actual discovery and rejects a remote TCP Docker context without pulling', async (t) => {
  const { root, run } = await fixture(t, shellSsh)
  await writeFile(path.join(root, 'uname'), '#!/bin/sh\nprintf "%s\\n" Linux\n', { mode: 0o700 })
  await writeFile(path.join(root, 'docker'), '#!/bin/sh\necho tcp://127.0.0.1:2375\n', { mode: 0o700 })
  const result = await run(catchError(`remote.probeHost('target','${version}')`), { DOCKER_CONTEXT: '', DOCKER_HOST: 'tcp://127.0.0.1:2375' })
  assert.match(result.error, /local Unix Docker Engine socket/)
})

test('upload streams archive bytes only to docker load and requires every pinned image afterward', async (t) => {
  const { root, run, env } = await fixture(t, `const fs=require('node:fs');
if (process.argv.at(-1).includes('engine load --quiet')) {
 const chunks=[];process.stdin.on('data',c=>chunks.push(c));process.stdin.on('end',()=>fs.writeFileSync(process.env.REPORT,Buffer.concat(chunks)));
} else process.stdout.write(fs.existsSync(process.env.REPORT) ? process.env.INSTALLED : process.env.PROBE);`)
  const packagePath = path.join(root, "package';unsafe.tar")
  const archive = Buffer.from('docker-save archive bytes\0do not execute')
  await writeFile(packagePath, archive)
  const call = `remote.installRuntime('target','${version}','upload',{packagePath:${JSON.stringify(packagePath)}})`
  const result = await run(catchError(call), { INSTALLED: response({ images: [image('sandbox'), image('supervisor'), image('gateway')] }) })
  assert.equal(result.runtimeReady, true)
  assert.deepEqual(await readFile(env.REPORT), archive)
  const invalid = await run(catchError(call), { INSTALLED: response({ images: [image('sandbox'), null, image('gateway')] }) })
  assert.match(invalid.error, /still needs the pinned .*gateway:/)
})

test('upload failure closes the stream and child; cancellation terminates a blocked transfer', async (t) => {
  const { root, run, env } = await fixture(t, `const fs=require('node:fs');
if(process.argv.at(-1).includes('engine load --quiet')) {
 fs.writeFileSync(process.env.REPORT,String(process.pid));
 if(process.env.BLOCK) setInterval(()=>{},1000);
 else { process.stderr.write('docker load rejected archive'); process.exit(1) }
} else process.stdout.write(process.env.PROBE);`)
  const packagePath = path.join(root, 'package.tar')
  await writeFile(packagePath, Buffer.alloc(4 * 1024 * 1024))
  const call = `remote.installRuntime('target','${version}','upload',{packagePath:${JSON.stringify(packagePath)},signal:controller.signal})`
  const failed = await run(`const controller = new AbortController(); ${catchError(call)}`)
  assert.match(failed.error, /upload failed|docker load rejected archive/)
  await rm(env.REPORT)
  const cancelled = await run(abortWhenStarted(call), { BLOCK: '1' })
  assert.match(cancelled.error, /cancelled/)
  const pid = Number(await readFile(env.REPORT, 'utf8'))
  assert.ok(Number.isSafeInteger(pid) && pid > 0)
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
})

// Run the real remote scripts with an isolated PATH and mapped host filesystem.
// No fixture command can invoke a real package manager, sudo, or service manager.
async function dockerHost(t, options = {}) {
  const f = await fixture(t, `
const fs = require('node:fs'), {spawn} = require('node:child_process');
const sessions = process.env.HOME + '/sessions';
const session = fs.existsSync(sessions) ? Number(fs.readFileSync(sessions, 'utf8')) + 1 : 1;
fs.writeFileSync(sessions, String(session));
if (process.env.RACE && session === 2) fs.copyFileSync(process.env.HOME + '/bin/docker-template', process.env.HOME + '/bin/docker');
const command = process.argv.at(-1).replace(/\\/(?:usr|etc|run|var|snap|lib)\\/[A-Za-z0-9_./-]+|\\/bin\\/docker/g, value => process.env.HOME + '/host' + value);
const child = spawn('/bin/sh', ['-c', command], {
 stdio: 'inherit', env: {...process.env, PATH: process.env.HOME + '/bin', SSH_SESSION: String(session)}
});
child.on('exit', code => process.exit(code ?? 1));
`)
  const bin = path.join(f.root, 'bin')
  await mkdir(bin)
  await symlink('/bin/sh', path.join(bin, 'sh'))
  await mkdir(path.join(f.root, 'host/etc'), { recursive: true })
  await writeFile(path.join(f.root, 'host/etc/os-release'), `ID=${options.distribution ?? 'ubuntu'}\n`)
  if (options.systemd !== false) await mkdir(path.join(f.root, 'host/run/systemd/system'), { recursive: true })
  const program = `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path'), {spawnSync} = require('node:child_process');
const name = path.basename(process.argv[1]), args = process.argv.slice(2), home = process.env.HOME;
if (['sudo','apt-get','systemctl','usermod'].includes(name)) fs.appendFileSync(home + '/mutations', JSON.stringify([name, ...args]) + '\\n');
if (name === 'uname') console.log(args[0] === '-s' ? 'Linux' : args[0] === '-m' ? (process.env.ARCH || 'x86_64') : '6.8.0');
else if (name === 'dpkg-query') { console.log(process.env.PACKAGE_STATE || ''); process.exit(process.env.PACKAGE_ERROR ? 2 : process.env.PACKAGE_STATE ? 0 : 1); }
else if (name === 'id') console.log(args[0] === '-u' ? (process.env.UID_VALUE || '1000') : 'remote-user');
else if (name === 'sudo') {
 if(process.env.DENY_SUDO) {console.error('sudo: a password is required');process.exit(1);}
 if(args[1] !== 'true') {const child = spawnSync(args[1], args.slice(2), {stdio:'inherit'});process.exit(child.status ?? 1);}
}
else if(name === 'env') {
 const child = spawnSync(args[1], args.slice(2), {stdio:'inherit'});process.exit(child.status ?? 1);
}
else if(name === 'apt-get') {
 if(process.env.BLOCK && args[0] === 'update') {fs.writeFileSync(process.env.REPORT, String(process.pid));setInterval(()=>{},1000);}
 else if(process.env.FAIL_STAGE === args[0]) {console.error('fixture apt ' + args[0] + ' failed');process.exit(1);}
 else if(args[0] === 'install') fs.copyFileSync(home + '/bin/docker-template', home + '/bin/docker');
}
else if(name === 'systemctl') {
 if(process.env.FAIL_STAGE === 'service') {console.error('fixture service failed');process.exit(1);}
 fs.writeFileSync(home + '/service-started', 'yes');
}
else if(name === 'usermod') {
 if(process.env.FAIL_STAGE === 'group') {console.error('fixture group failed');process.exit(1);}
 fs.writeFileSync(home + '/group-session', process.env.SSH_SESSION);
}
else if(name === 'docker' || name === 'docker-template') {
 if(args[0] === 'context') console.log('unix://' + process.env.DOCKER_SOCKET);
 else if(args[2] === 'info') {
  if(process.env.DOCKER_ERROR) {console.error(process.env.DOCKER_ERROR);process.exit(1);}
  const group = home + '/group-session';
  if(fs.existsSync(group) && Number(process.env.SSH_SESSION) <= Number(fs.readFileSync(group,'utf8'))) {console.error('new login required for docker group');process.exit(1);}
  console.log(JSON.stringify({...JSON.parse(process.env.ENGINE), Architecture: process.env.ARCH || 'x86_64'}));
 } else if(args[2] === 'image') process.exit(1);
}
`
  for (const name of ['uname', 'dpkg-query', 'id', 'sudo', 'env', 'apt-get', 'systemctl', 'usermod', 'docker-template']) {
    await writeFile(path.join(bin, name), program, { mode: 0o700 })
  }
  if (options.installed) await writeFile(path.join(bin, 'docker'), program, { mode: 0o700 })
  const socket = path.join(f.root, 'docker.sock')
  const server = net.createServer()
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve) })
  t.after(() => new Promise(resolve => server.close(resolve)))
  f.env.DOCKER_SOCKET = options.inaccessible ? path.join(f.root, 'no-socket') : socket
  f.env.ENGINE = JSON.stringify(engine)
  f.env.DOCKER_CONTEXT = ''
  f.env.DOCKER_HOST = ''
  f.mutations = async () => {
    try { return (await readFile(path.join(f.root, 'mutations'), 'utf8')).trim().split('\n').map(line => JSON.parse(line)) }
    catch (error) { if (error.code === 'ENOENT') return []; throw error }
  }
  return f
}

test('missing Docker is a read-only consent state, with distro and native platform support', async (t) => {
  const f = await dockerHost(t)
  const probe = await f.run(catchError(`remote.probeHost('target','${version}')`))
  assert.deepEqual(probe, {
    os: 'linux', arch: 'amd64', version, runtimeReady: false,
    dockerInstalled: false, distribution: 'ubuntu', dockerInstallSupported: true,
  })
  assert.equal((await f.run(catchError(`remote.probeHost('target','${version}')`), { ARCH: 'aarch64' })).arch, 'arm64')
  assert.deepEqual(await f.mutations(), [])
})

test('unusable existing Docker never becomes a missing-Docker installation', async (t) => {
  for (const options of [{ installed: true, inaccessible: true }, { installed: true }, {}]) {
    await t.test(JSON.stringify(options), async (t) => {
      const f = await dockerHost(t, options)
      const extra = options.installed ? { DOCKER_ERROR: 'Cannot connect: daemon stopped or permission denied' } : { PACKAGE_STATE: 'installed' }
      for (const method of ['probeHost', 'installDocker']) {
        const result = await f.run(catchError(`remote.${method}('target','${version}')`), extra)
        assert.match(result.error, /socket is missing or inaccessible|daemon stopped or permission denied|packages already exist/)
        assert.equal(result.dockerInstalled, undefined)
      }
      assert.deepEqual(await f.mutations(), [])
    })
  }
})

test('partial Docker files and unreadable package state cannot authorize an install', async (t) => {
  for (const component of ['usr/bin/docker', 'etc/systemd/system/docker.service', 'package-error']) {
    await t.test(component, async (t) => {
      const f = await dockerHost(t)
      if (component !== 'package-error') {
        const file = path.join(f.root, 'host', component)
        await mkdir(path.dirname(file), { recursive: true })
        await writeFile(file, 'nonexecutable existing Docker component')
      }
      const result = await f.run(catchError(`remote.installDocker('target','${version}')`), { PACKAGE_ERROR: component === 'package-error' ? '1' : '' })
      assert.match(result.error, /components already exist|Cannot inspect.*package state/)
      assert.deepEqual(await f.mutations(), [])
    })
  }
})

test('working Docker is reused without package, service, privilege, or group changes', async (t) => {
  const f = await dockerHost(t, { installed: true })
  const result = await f.run(catchError(`remote.installDocker('target','${version}')`))
  assert.equal(result.engineId, 'engine-one')
  assert.equal(result.dockerInstalled, true)
  assert.equal(result.runtimeReady, false)
  assert.deepEqual(await f.mutations(), [])
})

test('installation refuses unsupported distributions, non-systemd hosts, and unsupported architecture', async (t) => {
  for (const [options, extra, reason] of [
    [{ distribution: 'fedora' }, {}, /only Ubuntu and Debian/],
    [{ systemd: false }, {}, /running systemd/],
    [{}, { ARCH: 'riscv64' }, /native amd64 or arm64/],
  ]) {
    await t.test(reason.source, async (t) => {
      const f = await dockerHost(t, options)
      const probe = await f.run(catchError(`remote.probeHost('target','${version}')`), extra)
      assert.equal(probe.dockerInstalled, false)
      assert.equal(probe.dockerInstallSupported, false)
      assert.match(probe.dockerInstallReason, reason)
      assert.match((await f.run(catchError(`remote.installDocker('target','${version}')`), extra)).error, reason)
      assert.deepEqual(await f.mutations(), [])
    })
  }
})

test('absence is rechecked immediately before privilege and package changes', async (t) => {
  const f = await dockerHost(t)
  const result = await f.run(catchError(`remote.installDocker('target','${version}')`), { RACE: '1' })
  assert.equal(result.dockerInstalled, true)
  assert.deepEqual(await f.mutations(), [])
})

test('privilege denial is actionable and performs no package, service, or group changes', async (t) => {
  const f = await dockerHost(t)
  const result = await f.run(catchError(`remote.installDocker('target','${version}')`), { DENY_SUDO: '1' })
  assert.match(result.error, /root or passwordless sudo/)
  assert.deepEqual(await f.mutations(), [['sudo', '-n', 'true']])
})

test('approved Docker installer installs distro packages, starts service, grants group, and verifies a new login', async (t) => {
  const f = await dockerHost(t, { distribution: 'debian' })
  const result = await f.run(`const progress=[]; const probe=await remote.installDocker('target','${version}',{onProgress: value=>progress.push(value)});console.log(JSON.stringify({probe,progress}));`)
  assert.equal(result.probe.dockerInstalled, true)
  assert.equal(result.probe.runtimeReady, false)
  assert.equal(result.probe.engineId, 'engine-one')
})

test('root installation does not require sudo or redundant docker group membership', async (t) => {
  const f = await dockerHost(t)
  assert.equal((await f.run(catchError(`remote.installDocker('target','${version}')`), { UID_VALUE: '0', DENY_SUDO: '1' })).dockerInstalled, true)
  assert.equal((await f.mutations()).some(([name]) => name === 'sudo' || name === 'usermod'), false)
})

test('failed package, service, and group operations stop later mutations and report partial state honestly', async (t) => {
  for (const [stage, expected] of [['update', 1], ['install', 2], ['service', 3], ['group', 4]]) {
    await t.test(stage, async (t) => {
      const f = await dockerHost(t)
      const result = await f.run(catchError(`remote.installDocker('target','${version}')`), { FAIL_STAGE: stage })
      assert.match(result.error, /changes may already remain/)
      assert.match(result.error, new RegExp(`fixture (?:apt )?${stage} failed`))
      assert.equal((await f.mutations()).filter(([name]) => name !== 'sudo').length, expected)
      if (stage === 'service' || stage === 'group') {
        // A partial package install must not be overwritten or permission-repaired on retry.
        const previous = await f.mutations()
        await f.run(catchError(`remote.installDocker('target','${version}')`), { DOCKER_ERROR: 'daemon stopped or access denied' })
        assert.deepEqual(await f.mutations(), previous)
      }
    })
  }
})

test('cancellation stops an in-flight Docker installer and does not proceed to package installation', async (t) => {
  const f = await dockerHost(t)
  const result = await f.run(abortWhenStarted(`remote.installDocker('target','${version}',{signal:controller.signal})`), { BLOCK: '1' })
  assert.match(result.error, /changes may already remain.*cancelled/)
  assert.deepEqual((await f.mutations()).filter(([name]) => name !== 'sudo'), [['apt-get', 'update']])
  const pid = Number(await readFile(f.env.REPORT, 'utf8'))
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
})
