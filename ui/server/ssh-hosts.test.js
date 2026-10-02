import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createSshHostStore, fingerprint, parseTarget, slugify } from './ssh-hosts.js'
import { listSshHosts } from './remote-hosts.js'

const BLOB = Buffer.from('test-host-key').toString('base64')
const keyscan = async () => ({ code: 0, timedOut: false, stdout: `# host:22 SSH-2.0-OpenSSH\nhost.example ssh-ed25519 ${BLOB}\nhost.example ssh-rsa ${BLOB}\n` })

async function setup(t, options = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ssh-hosts-'))
  t.after(() => fs.rm(home, { recursive: true, force: true }))
  await fs.mkdir(path.join(home, '.ssh'))
  await fs.writeFile(path.join(home, '.ssh/config'), 'Host mine\n  HostName 10.0.0.1\n')
  return { home, store: createSshHostStore({ home, keyscan, existingHosts: () => listSshHosts({ homeDirectory: home, systemConfigPath: '/nonexistent' }), ...options }) }
}

test('parses targets and rejects option-like or malformed hosts', () => {
  assert.deepEqual(parseTarget('me@host.example'), { user: 'me', host: 'host.example' })
  assert.deepEqual(parseTarget('[::1]'), { user: null, host: '::1' })
  for (const bad of ['-oProxyCommand=x', 'a b', 'host\nHost x', 'me@', '@host', 'a@b@-c', '']) assert.throws(() => parseTarget(bad), bad)
})

test('slugifies display names into SSH aliases', () => {
  assert.equal(slugify('  My Build Server! '), 'my-build-server')
  assert.equal(slugify('---'), '')
})

test('fingerprint matches the OpenSSH SHA256 format', () => {
  assert.match(fingerprint(BLOB), /^SHA256:[A-Za-z0-9+/]{43}$/)
})

test('scan then add saves the host, trusts exactly the scanned keys and lists it in SSH config', async (t) => {
  const { home, store } = await setup(t)
  const scan = await store.scan({ name: 'Build Box', hostname: 'me@host.example', port: '2222', auth: 'default' })
  assert.equal(scan.alias, 'build-box')
  assert.deepEqual(scan.fingerprints.map(item => item.type), ['ssh-ed25519', 'ssh-rsa'])
  assert.deepEqual(await store.list(), [])
  await store.add(scan.token)
  const config = await fs.readFile(store.configFile, 'utf8')
  assert.match(config, /^Host build-box\n {2}HostName host\.example\n {2}User me\n {2}Port 2222\n/)
  assert.match(config, /HostKeyAlias build-box/)
  assert.doesNotMatch(config, /IdentityFile/)
  assert.match(await fs.readFile(store.hostsFile, 'utf8'), new RegExp(`^build-box ssh-ed25519 ${BLOB}`))
  const user = await fs.readFile(path.join(home, '.ssh/config'), 'utf8')
  assert.ok(user.startsWith(`Include "${store.configFile}"\n`), 'Include goes before any Host block')
  const names = listSshHosts({ homeDirectory: home, systemConfigPath: '/nonexistent' }).map(host => host.name)
  assert.deepEqual(names, ['build-box', 'mine'])
  await assert.rejects(store.add(scan.token), /expired/)
  assert.equal((await fs.stat(store.configFile)).mode & 0o777, 0o600)
})

test('identity auth requires an existing private key and is pinned with IdentitiesOnly', async (t) => {
  const { home, store } = await setup(t)
  const key = path.join(home, 'id_test')
  await fs.writeFile(key, 'key')
  await assert.rejects(store.scan({ name: 'a', hostname: 'host.example', auth: 'identity', identityFile: path.join(home, 'missing') }), /does not exist/)
  await assert.rejects(store.scan({ name: 'a', hostname: 'host.example', auth: 'identity', identityFile: `${key}.pub` }), /public key/)
  await assert.rejects(store.scan({ name: 'a', hostname: 'host.example', auth: 'identity', identityFile: `${key}"\nProxyCommand x` }), /full path|does not exist/)
  await store.add((await store.scan({ name: 'a', hostname: 'host.example', auth: 'identity', identityFile: key })).token)
  const config = await fs.readFile(store.configFile, 'utf8')
  assert.match(config, new RegExp(`IdentityFile "${key}"\\n {2}IdentitiesOnly yes`))
})

test('rejects bad ports, duplicate names and names that shadow the user’s own hosts', async (t) => {
  const { store } = await setup(t)
  await assert.rejects(store.scan({ name: 'x', hostname: 'host.example', port: '70000' }), /port/)
  await assert.rejects(store.scan({ name: 'x', hostname: 'host.example', port: '22; rm' }), /port/)
  await assert.rejects(store.scan({ name: 'Mine', hostname: 'host.example' }), /already a host/)
  await store.add((await store.scan({ name: 'one', hostname: 'host.example' })).token)
  await assert.rejects(store.scan({ name: 'One', hostname: 'host.example' }), /already saved/)
})

test('an unreachable host yields a clear error and nothing is saved', async (t) => {
  const { store } = await setup(t, { keyscan: async () => ({ code: 0, timedOut: false, stdout: '' }) })
  await assert.rejects(store.scan({ name: 'x', hostname: 'host.example' }), /host key/)
  const timedOut = createSshHostStore({ home: store.directory, keyscan: async () => ({ timedOut: true, stdout: '' }), existingHosts: () => [] })
  await assert.rejects(timedOut.scan({ name: 'y', hostname: 'host.example' }), /Timed out/)
})

test('an expired confirmation cannot be used', async (t) => {
  let clock = 1000
  const { store } = await setup(t, { now: () => clock })
  const { token } = await store.scan({ name: 'x', hostname: 'host.example' })
  clock += 6 * 60_000
  await assert.rejects(store.add(token), /expired/)
})

test('remove deletes the entry, its config block and its trusted keys', async (t) => {
  const { store } = await setup(t)
  await store.add((await store.scan({ name: 'one', hostname: 'host.example' })).token)
  await store.add((await store.scan({ name: 'two', hostname: 'host.example' })).token)
  await store.remove('one')
  assert.deepEqual((await store.list()).map(host => host.alias), ['two'])
  assert.doesNotMatch(await fs.readFile(store.configFile, 'utf8'), /Host one\b/)
  assert.doesNotMatch(await fs.readFile(store.hostsFile, 'utf8'), /^one /m)
  assert.match(await fs.readFile(store.hostsFile, 'utf8'), /^two /m)
  await assert.rejects(store.remove('one'), /not saved/)
})

test('adding a host keeps the rest of ~/.ssh/config byte for byte, even when it is not UTF-8', async (t) => {
  const { home, store } = await setup(t)
  const userConfig = path.join(home, '.ssh/config')
  const original = Buffer.concat([Buffer.from('# caf'), Buffer.from([0xe9]), Buffer.from('\r\nHost mine\r\n  HostName 10.0.0.1\r\n')])
  await fs.writeFile(userConfig, original)
  await store.add((await store.scan({ name: 'Box', hostname: 'host.example', auth: 'default' })).token)
  const include = Buffer.from(`Include "${store.configFile}"\n`)
  assert.deepEqual(await fs.readFile(userConfig), Buffer.concat([include, original]))
  await store.add((await store.scan({ name: 'Other', hostname: 'host.example', auth: 'default' })).token)
  assert.deepEqual(await fs.readFile(userConfig), Buffer.concat([include, original]))
})

test('a symlinked ~/.ssh/config is refused before anything is saved, unless it already includes our config', async (t) => {
  const { home, store } = await setup(t)
  const userConfig = path.join(home, '.ssh/config'), target = path.join(home, 'dotfiles-config')
  await fs.rename(userConfig, target)
  await fs.symlink(target, userConfig)
  const scan = await store.scan({ name: 'Box', hostname: 'host.example', auth: 'default' })
  await assert.rejects(store.add(scan.token), /symlink.*Include "/s)
  assert.deepEqual(await store.list(), [])
  await assert.rejects(fs.lstat(store.configFile), { code: 'ENOENT' })
  await fs.writeFile(target, `Include "${store.configFile}"\r\nHost mine\n  HostName 10.0.0.1\n`)
  await store.add((await store.scan({ name: 'Box', hostname: 'host.example', auth: 'default' })).token)
  assert.deepEqual((await store.list()).map(item => item.alias), ['box'])
  assert.ok((await fs.lstat(userConfig)).isSymbolicLink())
  assert.equal(await fs.readFile(target, 'utf8'), `Include "${store.configFile}"\r\nHost mine\n  HostName 10.0.0.1\n`)
})

test('a ~/.ssh directory OpenRod cannot write to is refused before anything is saved', { skip: process.getuid?.() === 0 }, async (t) => {
  const { home, store } = await setup(t)
  const sshDir = path.join(home, '.ssh')
  const scan = await store.scan({ name: 'Box', hostname: 'host.example', auth: 'default' })
  await fs.chmod(sshDir, 0o500)
  try {
    await assert.rejects(store.add(scan.token), error => error.status === 409 && /can't update ~\/\.ssh\/config \(EACCES\).*Include "/s.test(error.message))
  } finally { await fs.chmod(sshDir, 0o700) }
  assert.deepEqual(await store.list(), [])
  await assert.rejects(fs.lstat(store.configFile), { code: 'ENOENT' })
  assert.equal(await fs.readFile(path.join(sshDir, 'config'), 'utf8'), 'Host mine\n  HostName 10.0.0.1\n')
})
