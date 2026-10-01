import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
const module = await import('./local-cloud-native.js').catch(() => ({}))
const key = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBQ0mhdsCYeaMy1QaI3/GDYUHJRTerTsKhXvrFTHkmEa'
function req(method, body = {}) { const req = Readable.from([JSON.stringify(body)]); req.method = method; req.headers = { host: 'localhost:4311', 'content-type': 'application/json', 'x-openshell-console': '1' }; return req }
function res() { return { writeHead(status) { this.status = status }, end(body) { this.value = JSON.parse(body) } } }
const sandbox = { name: 'demo', phase: 'ready', labels: { 'openshell.console/project': 'project' } }
function services(uid = 'alice') { const grant = { token: 'secret-grant', user: { uid }, expires: Date.now() + 10000 }; return { connection: () => grant, call: async (target) => target.endsWith('ssh-ticket') ? { ticket: 'one-use', hostKeys: [key], user: 'sandbox' } : sandbox } }

test('managed SSH config pins cloud host key and preserves unrelated SSH config', async () => {
  assert.equal(typeof module.createLocalCloudNative, 'function')
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'openrod-native-'))
  try {
    await fs.mkdir(path.join(home, '.ssh')); const existing = 'Host my-work\n  HostName work.example\n'
    await fs.writeFile(path.join(home, '.ssh/config'), existing)
    const native = module.createLocalCloudNative({ home, node: '/usr/bin/node', helper: '/openrod/cloud-ssh-proxy.cjs', env: { PATH: '/usr/bin:/bin' } })
    const response = res(); assert.equal(await native(req('POST'), response, '/api/os/sandboxes/demo/ssh-config', services()), true)
    const { config, alias, command } = response.value
    assert.match(alias, /^openrod-cloud-[0-9a-f]{16}-demo$/)
    assert.match(config, /StrictHostKeyChecking yes/)
    assert.match(config, /UserKnownHostsFile/)
    assert.match(config, /cloud-ssh-proxy.cjs/)
    assert.match(command, /ssh.*-F/)
    assert.doesNotMatch(config, /secret-grant|StrictHostKeyChecking no|Bearer/)
    const installed = await fs.readFile(path.join(home, '.ssh/config'), 'utf8'); assert.ok(installed.endsWith(existing))
    assert.match(await fs.readFile(path.join(home, '.config/openrod/cloud_known_hosts'), 'utf8'), new RegExp(`${alias} ssh-ed25519`))
    assert.equal((await fs.stat(path.join(home, '.config/openrod/cloud_ssh_config'))).mode & 0o777, 0o600)
    await native(req('POST'), res(), '/api/os/sandboxes/demo/ssh-config', services())
    assert.equal((await fs.readFile(path.join(home, '.ssh/config'), 'utf8')).split('Include ').length, 2)
    const other = res(); await native(req('POST'), other, '/api/os/sandboxes/demo/ssh-config', services('bob'))
    assert.notEqual(other.value.alias, alias)
    assert.match(await fs.readFile(path.join(home, '.config/openrod/cloud_ssh_config'), 'utf8'), new RegExp(alias))
  } finally { await fs.rm(home, { recursive: true, force: true }) }
})

test('native launcher opens installed local editors and Terminal with fixed alias and remote project', async () => {
  assert.equal(typeof module.createLocalCloudNative, 'function')
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'openrod-native-'))
  let launched, terminal
  const native = module.createLocalCloudNative({ home, findEditor: id => id === 'cursor' ? '/Applications/Cursor.app/bin/cursor' : null, launchEditor: async (file, args) => { launched = { file, args } }, launchTerminal: async command => { terminal = command }, env: { PATH: '/usr/bin:/bin' }, platform: 'darwin' })
  try {
    const editors = res(); await native(req('GET'), editors, '/api/os/editors', services()); assert.equal(editors.value[0].installed, true); assert.equal(editors.value[1].installed, false)
    const view = res(); await native(req('GET'), view, '/api/os/sandboxes/demo/ssh', services()); assert.equal(view.value.canOpenTerminal, true)
    assert.equal(view.value.defaultMode, 'exec')
    assert.equal(view.value.modes[view.value.defaultMode].mode, 'exec')
    const result = res(); await native(req('POST', { editor: 'cursor', command: 'evil', folder: '/etc' }), result, '/api/os/sandboxes/demo/editor', services())
    assert.equal(launched.file, '/Applications/Cursor.app/bin/cursor'); assert.deepEqual(launched.args, ['--remote', `ssh-remote+${view.value.alias}`, '/sandbox/project'])
    await native(req('POST', { mode: view.value.defaultMode, command: 'evil' }), res(), '/api/os/sandboxes/demo/ssh-open', services()); assert.match(terminal, /ssh.*-F/); assert.doesNotMatch(terminal, /evil/)
    await assert.rejects(native(req('POST', { editor: 'vscode' }), res(), '/api/os/sandboxes/demo/editor', services()), { status: 409 })
    assert.equal(await native(req('GET'), res(), '/api/os/overview', services()), false)
    await assert.rejects(native(req('POST', { mode: 'attach' }), res(), '/api/os/sandboxes/demo/ssh-open', services()), { status: 400 })
  } finally { await fs.rm(home, { recursive: true, force: true }) }
})

test('old account proxy commands cannot obtain tickets after switching Google accounts', async () => {
  assert.equal(typeof module.createLocalCloudNative, 'function')
  const native = module.createLocalCloudNative()
  await assert.rejects(native(req('POST', { owner: '0000000000000000' }), res(), '/api/os/sandboxes/demo/ssh-ticket', services()), { status: 403 })
})


test('account switches and same-account reconnects cancel a pending native launch', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'openrod-native-race-'))
  try {
    for (const uid of ['bob', 'alice']) {
      const initial = { user: { uid: 'alice' }, token: 'old', expires: Date.now() + 10000 }
      let grant = initial, tickets = 0, launched = false
      const native = module.createLocalCloudNative({ home, platform: 'darwin', env: { PATH: '/usr/bin:/bin' }, launchTerminal: async () => { launched = true } })
      const pending = native(req('POST'), res(), '/api/os/sandboxes/demo/ssh-open', {
        connection: () => grant,
        call: async target => { if (target.endsWith('ssh-ticket')) { tickets++; return { ticket: 'one-use', hostKeys: [key] } } grant = { user: { uid }, token: 'new', expires: Date.now() + 10000 }; return sandbox },
      })
      await assert.rejects(pending, { status: 403 }); assert.equal(tickets, 0); assert.equal(launched, false)
    }
  } finally { await fs.rm(home, { recursive: true, force: true }) }
})

test('native aliases and proxy commands stay bound to their originating cloud workspace', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'openrod-native-workspace-'))
  const native = module.createLocalCloudNative({ home, env: { PATH: '/usr/bin:/bin' } })
  const grant = { user: { uid: 'alice' }, expires: Date.now() + 10000 }
  const aliases = []
  try {
    for (const workspace of ['alpha', 'beta']) {
      const context = JSON.stringify(['worker', workspace]), calls = []
      const scoped = {
        connection: () => grant,
        call: async target => {
          const url = new URL(target, 'http://local')
          calls.push(url)
          return url.pathname.endsWith('ssh-ticket') ? { ticket: 'one-use', hostKeys: [key], context } : { ...sandbox, workspace }
        },
      }
      const response = res()
      await native(req('POST'), response, '/api/os/sandboxes/demo/ssh-config?' + new URLSearchParams({ context, location: '1' }), scoped)
      aliases.push(response.value.alias)
      assert.match(response.value.config, /--context/)
      assert.ok(response.value.config.includes(context))
      assert.equal(calls.length, 2)
      for (const call of calls) {
        assert.equal(call.searchParams.get('context'), context)
        assert.equal(call.searchParams.get('location'), '1')
      }
    }
    assert.notEqual(aliases[0], aliases[1])
    const config = await fs.readFile(path.join(home, '.config/openrod/cloud_ssh_config'), 'utf8')
    for (const alias of aliases) assert.ok(config.includes(alias))
    await assert.rejects(native(req('POST'), res(), '/api/os/sandboxes/demo/ssh-config?' + new URLSearchParams({ context: '["worker","alpha"]' }), {
      connection: () => grant,
      call: async target => new URL(target, 'http://local').pathname.endsWith('ssh-ticket') ? { ticket: 'one-use', hostKeys: [key], context: '["worker","beta"]' } : sandbox,
    }), { status: 409 })
  } finally { await fs.rm(home, { recursive: true, force: true }) }
})
