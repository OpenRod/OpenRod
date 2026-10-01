import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'

async function registration(t, metadata = { gateway_endpoint: 'https://127.0.0.1:1', auth_mode: 'mtls' }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'console-onboarding-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const config = path.join(root, 'config', 'openshell')
  const directory = path.join(config, 'gateways', 'suggested')
  await fs.mkdir(path.join(directory, 'mtls'), { recursive: true })
  await fs.writeFile(path.join(directory, 'metadata.json'), JSON.stringify(metadata))
  return { root, config, directory }
}

test('SSH discovery and a failed local connection never activate a fresh console or create activity state', { timeout: 15000 }, async (t) => {
  const { root, config } = await registration(t)
  await fs.writeFile(path.join(config, 'active_gateway'), 'suggested')
  const state = path.join(root, 'state')
  const moduleUrl = new URL('./api.js', import.meta.url).href
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { createServer } from 'node:http'
    import { createOpenShellApi } from ${JSON.stringify(moduleUrl)}
    const server = createServer((request, response) => api.middleware(request, response))
    const api = createOpenShellApi({ httpServer: server })
    server.listen(0, '127.0.0.1', () => console.log('READY http://127.0.0.1:' + server.address().port))
    process.on('SIGTERM', async () => {
      await api.close()
      server.close(() => process.exit(0))
      server.closeAllConnections()
    })
  `], {
    env: { ...process.env, XDG_CONFIG_HOME: path.dirname(config), OPENSHELL_CONSOLE_DATA_DIR: state, OPENSHELL_GATEWAY: '', OPENSHELL_WORKSPACE: '', OPENSHELL_CONSOLE_SWEEP: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const stopped = new Promise((resolve) => child.once('close', resolve))
  t.after(async () => {
    child.kill('SIGTERM')
    const deadline = setTimeout(() => child.kill('SIGKILL'), 3000)
    await stopped
    clearTimeout(deadline)
  })
  let stderr = ''
  child.stderr.on('data', (chunk) => { stderr += chunk })
  const origin = await new Promise((resolve, reject) => {
    let output = ''
    child.once('error', reject)
    child.once('exit', (code) => reject(new Error(`Console exited ${code}: ${stderr}`)))
    child.stdout.on('data', (chunk) => {
      output += chunk
      const match = /READY (http:\/\/127\.0\.0\.1:\d+)/.exec(output)
      if (match) resolve(match[1])
    })
  })
  const get = async (route) => fetch(`${origin}/api/os/${route}`)
  const before = await (await get('context')).json()
  assert.equal(before.gateway, 'suggested')
  assert.equal(before.selectionSource, 'cli')
  assert.equal(before.configured, false)
  assert.deepEqual(before.workspaces, [])
  assert.equal(before.workspaceError, null)
  assert.deepEqual((await (await get('connections')).json()).locals, [{ name: 'suggested', endpoint: 'https://127.0.0.1:1' }])
  for (const route of ['overview', 'activity', 'stream']) {
    const response = await get(route)
    assert.equal(response.status, 428)
    assert.equal((await response.json()).setupRequired, true)
  }
  const check = await fetch(`${origin}/api/os/connections/connect`, {
    method: 'POST', headers: { origin, 'content-type': 'application/json', 'x-openshell-console': '1' }, body: JSON.stringify({ localGateway: 'suggested' }),
  })
  assert.equal(check.status, 200)
  const attempt = await check.json()
  let report
  for (let tries = 0; tries < 100; tries++) {
    report = await (await get(`connections/jobs/${attempt.id}`)).json()
    if (report.status !== 'working') break
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.equal(report.status, 'failed')
  assert.equal(typeof report.error, 'string')
  assert.equal((await (await get('context')).json()).configured, false)
  await assert.rejects(fs.access(path.join(config, 'console-context.json')), { code: 'ENOENT' })
  await assert.rejects(fs.access(state), { code: 'ENOENT' })
})

async function remoteFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'console-runtime-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  await fs.mkdir(path.join(root, '.ssh'))
  await fs.writeFile(path.join(root, '.ssh/config'), 'Host target\n  HostName 127.0.0.1\n')
  const state = path.join(root, 'state')
  await fs.mkdir(path.join(state, 'remote-gateways'), { recursive: true })
  // Reaching this real lock proves installation proceeded to gateway startup,
  // without launching a daemon or touching the operator's gateways.
  await fs.writeFile(path.join(state, 'remote-gateways/process.lock'), JSON.stringify({ pid: process.pid }))
  await fs.writeFile(path.join(root, 'openshell-gateway'), `#!${process.execPath}\nconsole.log('openshell-gateway 0.1.2')\n`, { mode: 0o700 })
  await fs.writeFile(path.join(root, 'ssh'), `#!${process.execPath}
const fs = require('node:fs')
const command = process.argv.at(-1)
fs.appendFileSync(process.env.REPORT, JSON.stringify(command) + '\\n')
if (command.includes('apt-get install -y --no-install-recommends docker.io')) {
  fs.writeFileSync(process.env.DOCKER_INSTALLED, 'yes')
} else if (command.includes('engine pull --quiet')) {
  if (process.env.FAIL_PULL) { process.stderr.write('registry access denied'); process.exit(1) }
  fs.writeFileSync(process.env.INSTALLED, 'yes')
} else if (command.includes('engine load --quiet')) {
  const chunks = []
  process.stdin.on('data', chunk => chunks.push(chunk))
  process.stdin.on('end', () => {
    fs.writeFileSync(process.env.ARCHIVE, Buffer.concat(chunks))
    fs.writeFileSync(process.env.INSTALLED, 'yes')
  })
} else {
  if (process.env.NO_DOCKER && !fs.existsSync(process.env.DOCKER_INSTALLED)) {
    console.log('OPENSHELL_HOST_OS=Linux\\nOPENSHELL_HOST_ARCH=x86_64\\nOPENSHELL_DOCKER_INSTALLED=false\\nOPENSHELL_DISTRIBUTION=ubuntu\\nOPENSHELL_DOCKER_INSTALL_SUPPORTED=true\\nOPENSHELL_DOCKER_INSTALL_REASON=')
    process.exit(0)
  }
  const ready = process.env.READY || fs.existsSync(process.env.INSTALLED)
  console.log('OPENSHELL_HOST_OS=Linux\\nOPENSHELL_HOST_ARCH=x86_64\\nOPENSHELL_HOST_KERNEL=6.8.0\\nOPENSHELL_SOCKET=/run/docker.sock')
  console.log('OPENSHELL_ENGINE=' + JSON.stringify({ ID: 'engine-one', OSType: 'linux', Architecture: 'x86_64', KernelVersion: '6.8.0', OperatingSystem: 'Ubuntu', SecurityOptions: ['name=seccomp'] }))
  for (const [index, kind] of ['sandbox', 'supervisor'].entries()) {
    console.log('OPENSHELL_IMAGE_' + index + '=' + JSON.stringify(ready ? { Os: 'linux', Architecture: 'amd64', RepoTags: ['ghcr.io/nvidia/openshell/' + kind + ':0.1.2'] } : null))
  }
}
`, { mode: 0o700 })
  const report = path.join(root, 'report')
  const archive = path.join(root, 'archive')
  const dockerInstalled = path.join(root, 'docker-installed')
  const moduleUrl = new URL('./remote-gateway.js', import.meta.url).href
  const run = async (code, extra = {}) => {
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', `
      import { createRemoteConnections } from ${JSON.stringify(moduleUrl)}
      import { setTimeout as delay } from 'node:timers/promises'
      const connections = createRemoteConnections()
      const settle = async id => {
        for (let attempt = 0; attempt < 500; attempt++) {
          const job = connections.job(id)
          if (job.status !== 'working') return job
          await delay(10)
        }
        throw new Error('Connection did not settle')
      }
      try { ${code} } finally { await connections.close() }
    `], {
      env: { ...process.env, HOME: root, PATH: `${root}:/usr/bin:/bin`, XDG_CONFIG_HOME: path.join(root, 'config'), OPENSHELL_CONSOLE_DATA_DIR: state, OPENSHELL_GATEWAY: '', OPENSHELL_WORKSPACE: '', REPORT: report, INSTALLED: path.join(root, 'installed'), DOCKER_INSTALLED: dockerInstalled, ARCHIVE: archive, ...extra },
      timeout: 10000,
    })
    return JSON.parse(stdout)
  }
  return { run, report, archive, dockerInstalled }
}

test('SSH connect installs missing runtime by default before attempting managed gateway startup', async t => {
  const { run, report } = await remoteFixture(t)
  const result = await run(`console.log(JSON.stringify(await settle(connections.begin({host:'target'}).id)))`)
  assert.equal(result.status, 'failed')
  assert.equal(result.probe.runtimeReady, true)
  assert.match(result.error, /Another console is managing the remote gateway/)
  const commands = (await fs.readFile(report, 'utf8')).trim().split('\n').map(JSON.parse)
  assert.equal(commands.filter(command => command.includes('engine pull --quiet')).length, 1)
})

test('SSH connect skips installation when pinned runtime is already installed', async t => {
  const { run, report } = await remoteFixture(t)
  const result = await run(`console.log(JSON.stringify(await settle(connections.begin({host:'target'}).id)))`, { READY: '1' })
  assert.match(result.error, /Another console is managing the remote gateway/)
  assert.equal(result.probe.runtimeReady, true)
  assert.doesNotMatch(await fs.readFile(report, 'utf8'), /engine pull|engine load/)
})

test('SSH upload mode waits for package bytes and then attempts gateway startup', async t => {
  const { run, report, archive } = await remoteFixture(t)
  const result = await run(`
    const waiting = await settle(connections.begin({host:'target',runtimeInstallation:'upload'}).id)
    const { Readable } = await import('node:stream')
    const req = Readable.from([Buffer.from('runtime archive')])
    req.headers = {'content-length':'15'}
    await connections.upload(waiting.id, req)
    console.log(JSON.stringify({waiting,finished:await settle(waiting.id)}))
  `)
  assert.equal(result.waiting.status, 'needs-install')
  assert.equal(result.waiting.probe.runtimeReady, false)
  assert.equal(result.finished.probe.runtimeReady, true)
  assert.match(result.finished.error, /Another console is managing the remote gateway/)
  assert.equal(await fs.readFile(archive, 'utf8'), 'runtime archive')
  assert.doesNotMatch(await fs.readFile(report, 'utf8'), /engine pull/)
})

test('invalid SSH runtime modes are rejected before creating jobs or invoking SSH', async t => {
  const { run, report } = await remoteFixture(t)
  const result = await run(`
    const errors = []
    for (const runtimeInstallation of [null, '', 'automatic', false, {}, []]) {
      try { connections.begin({host:'target',runtimeInstallation}); errors.push(null) }
      catch (error) { errors.push(error.status) }
    }
    console.log(JSON.stringify({errors,job:(await connections.overview()).job}))
  `)
  assert.deepEqual(result.errors, [400, 400, 400, 400, 400, 400])
  assert.equal(result.job, null)
  await assert.rejects(fs.access(report), { code: 'ENOENT' })
})

test('automatic runtime download failures remain actionable and do not start a gateway', async t => {
  const { run, report } = await remoteFixture(t)
  const result = await run(`console.log(JSON.stringify(await settle(connections.begin({host:'target',runtimeInstallation:'download'}).id)))`, { FAIL_PULL: '1' })
  assert.equal(result.status, 'failed')
  assert.equal(result.probe.runtimeReady, false)
  assert.match(result.error, /registry access denied/)
  assert.match(result.error, /ghcr.io.*Docker-save package upload/)
  assert.doesNotMatch(result.error, /Another console/)
  const commands = (await fs.readFile(report, 'utf8')).trim().split('\n').map(JSON.parse)
  assert.equal(commands.filter(command => command.includes('engine pull --quiet')).length, 1)
})

test('missing Docker waits for explicit approval and continues the chosen runtime installation mode', async t => {
  for (const runtimeInstallation of ['download', 'upload']) await t.test(runtimeInstallation, async t => {
    const { run, dockerInstalled } = await remoteFixture(t)
    const result = await run(`
      const waiting = await settle(connections.begin({host:'target',runtimeInstallation:${JSON.stringify(runtimeInstallation)}}).id)
      const fs = await import('node:fs/promises')
      const before = await fs.access(process.env.DOCKER_INSTALLED).then(() => true, () => false)
      const rejected = []
      for (const approval of [undefined, false, 'true', 1]) {
        try { connections.installDocker(waiting.id, approval); rejected.push(null) }
        catch (error) { rejected.push(error.status) }
      }
      const afterRejected = await fs.access(process.env.DOCKER_INSTALLED).then(() => true, () => false)
      connections.installDocker(waiting.id, true)
      const finished = await settle(waiting.id)
      console.log(JSON.stringify({waiting,before,rejected,afterRejected,finished}))
    `, { NO_DOCKER: '1' })
    assert.equal(result.waiting.status, 'needs-docker')
    assert.equal(result.waiting.probe.dockerInstalled, false)
    assert.equal(result.before, false)
    assert.deepEqual(result.rejected, [400, 400, 400, 400])
    assert.equal(result.afterRejected, false)
    assert.equal(await fs.readFile(dockerInstalled, 'utf8'), 'yes')
    assert.equal(result.finished.probe.dockerInstalled, true)
    if (runtimeInstallation === 'upload') {
      assert.equal(result.finished.status, 'needs-install')
      assert.equal(result.finished.probe.runtimeReady, false)
    } else {
      assert.equal(result.finished.status, 'failed')
      assert.equal(result.finished.probe.runtimeReady, true)
      assert.match(result.finished.error, /Another console is managing the remote gateway/)
    }
  })
})

test('a replaced connection cannot reuse Docker installation approval', async t => {
  const { run, dockerInstalled } = await remoteFixture(t)
  const result = await run(`
    const old = await settle(connections.begin({host:'target'}).id)
    const current = await settle(connections.begin({host:'target'}).id)
    let status
    try { connections.installDocker(old.id, true) } catch (error) { status = error.status }
    console.log(JSON.stringify({status,current,old:connections.job(old.id)}))
  `, { NO_DOCKER: '1' })
  assert.equal(result.status, 409)
  assert.equal(result.old.status, 'failed')
  assert.equal(result.current.status, 'needs-docker')
  await assert.rejects(fs.access(dockerInstalled), { code: 'ENOENT' })
})

test('disconnect restores local context or requires selection instead of retaining the stopped remote endpoint', async t => {
  const managed = 'console-ssh-' + 'a'.repeat(24)
  const cases = [
    { name: 'remembered local workspace wins over other reachable registrations', initial: 'alpha', switchRemote: true, reachable: ['alpha', 'beta'], expected: 'alpha', workspace: 'team' },
    { name: 'restart restores the only reachable local registration', initial: managed, reachable: ['alpha'], expected: 'alpha', workspace: 'default' },
    { name: 'ambiguous local registrations require an explicit choice', initial: managed, reachable: ['alpha', 'beta'], expected: null },
    { name: 'unavailable local gateway clears the remote selection', initial: 'alpha', switchRemote: true, reachable: [], expected: null },
    { name: 'disconnect leaves an already selected local gateway alone', initial: 'alpha', reachable: ['alpha'], expected: 'alpha', workspace: 'team' },
  ]
  for (const scenario of cases) await t.test(scenario.name, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'console-disconnect-'))
    t.after(() => fs.rm(root, { recursive: true, force: true }))
    const config = path.join(root, 'config', 'openshell')
    const names = ['alpha', 'beta', managed]
    for (const [index, name] of names.entries()) {
      const directory = path.join(config, 'gateways', name)
      await fs.mkdir(path.join(directory, 'mtls'), { recursive: true })
      await fs.writeFile(path.join(directory, 'metadata.json'), JSON.stringify({
        gateway_endpoint: `https://127.0.0.1:${10001 + index}`, auth_mode: 'mtls', is_remote: name === managed,
      }))
      for (const file of ['ca.crt', 'tls.crt', 'tls.key']) await fs.writeFile(path.join(directory, 'mtls', file), 'test certificate')
    }
    await fs.writeFile(path.join(config, 'console-context.json'), JSON.stringify({ gateway: scenario.initial, workspace: 'team' }))
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', `
      import fs from 'node:fs/promises'
      import { OpenShellClient } from '@nvidia/openshell-sdk'
      import { contextSelection, contextConfigured, selectConsoleContext } from ${JSON.stringify(new URL('./gateway.js', import.meta.url).href)}
      import { createRemoteConnections } from ${JSON.stringify(new URL('./remote-gateway.js', import.meta.url).href)}
      const scenario = ${JSON.stringify(scenario)}
      const names = ${JSON.stringify(names)}
      OpenShellClient.connect = async ({ gateway }) => {
        const name = names[Number(new URL(gateway).port) - 10001]
        if (name !== ${JSON.stringify(managed)} && !scenario.reachable.includes(name)) throw Error('Local gateway unavailable')
        return { transport: { unary() {}, stream() {} }, raw: { listWorkspaces: async () => ({ workspaces: ['default', 'team'].map(name => ({ metadata: { name } })) }) } }
      }
      let deselected = false
      const connections = createRemoteConnections({ onDeselected: () => { deselected = true }, logger: { warn() {} } })
      if (scenario.switchRemote) await selectConsoleContext({ gateway: ${JSON.stringify(managed)}, workspace: 'default' })
      await connections.disconnect()
      console.log(JSON.stringify({
        configured: contextConfigured(), selected: contextSelection(), deselected,
        persisted: JSON.parse(await fs.readFile(${JSON.stringify(path.join(config, 'console-context.json'))}, 'utf8')),
      }))
      await connections.close()
    `], {
      cwd: path.resolve(import.meta.dirname, '..'),
      env: { ...process.env, XDG_CONFIG_HOME: path.dirname(config), OPENSHELL_GATEWAY: '', OPENSHELL_WORKSPACE: '', OPENSHELL_CONSOLE_DATA_DIR: path.join(root, 'state') },
      timeout: 10000,
    })
    const result = JSON.parse(stdout)
    assert.equal(result.configured, Boolean(scenario.expected))
    if (scenario.expected) {
      const expected = { gateway: scenario.expected, workspace: scenario.workspace }
      assert.deepEqual(result.selected, expected)
      assert.deepEqual(result.persisted, expected)
      assert.equal(result.deselected, false)
    } else {
      assert.deepEqual(result.persisted, {})
      assert.equal(result.deselected, true)
      assert.notEqual(result.selected.gateway, managed)
    }
  })
})

