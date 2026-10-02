import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { fail, findExecutable, runCli } from './openshell-cli.js'
import { listSshHosts } from './remote-hosts.js'

const DNS = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/
const IPV6 = /^(?=(?:[^:]*:){2})[0-9A-Fa-f:]{2,45}$/
const USER = /^[A-Za-z_][A-Za-z0-9._-]{0,31}$/
const KEY_TYPE = /^(ssh-ed25519|ecdsa-sha2-nistp(?:256|384|521)|ssh-rsa|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com)$/
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/
const TOKEN_TTL_MS = 5 * 60_000

// Config values are written between quotes; reject anything that could end the
// value or start another directive.
const plain = value => typeof value === 'string' && !/[\0-\x1f\x7f"\\]/.test(value)
const configQuote = value => `"${value}"`

export const slugify = value => String(value ?? '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '')

export const fingerprint = blob => `SHA256:${createHash('sha256').update(Buffer.from(blob, 'base64')).digest('base64').replace(/=+$/, '')}`

// "host" or "user@host" -> { user, host }. Hostnames never start with "-", so
// they cannot be read as ssh options.
export function parseTarget(value) {
  if (typeof value !== 'string') throw fail('Enter a hostname.')
  const text = value.trim()
  const at = text.lastIndexOf('@')
  const user = at < 0 ? null : text.slice(0, at)
  const host = (at < 0 ? text : text.slice(at + 1)).replace(/^\[(.*)\]$/, '$1')
  if (user !== null && !USER.test(user)) throw fail('The user name before @ is not valid.')
  if (!host) throw fail('Enter a hostname.')
  if (!DNS.test(host) && !IPV6.test(host)) throw fail('The hostname is not valid. Use a name like host.example.com or an IP address.')
  return { user, host }
}

export function createSshHostStore({ home = os.homedir(), keyscan, now = Date.now, existingHosts = () => listSshHosts({ homeDirectory: home }) } = {}) {
  const directory = path.join(home, '.config/openrod')
  const configFile = path.join(directory, 'ssh_config'), hostsFile = path.join(directory, 'known_hosts'), dataFile = path.join(directory, 'ssh_hosts.json')
  const pending = new Map()
  let queue = Promise.resolve()
  const serial = task => { const result = queue.then(task, task); queue = result.catch(() => {}); return result }

  async function readText(file) {
    try {
      const stat = await fs.lstat(file)
      if (!stat.isFile() || stat.isSymbolicLink()) throw fail(`${path.basename(file)} must be a regular file.`, 409)
      return await fs.readFile(file, 'utf8')
    } catch (error) { if (error.code === 'ENOENT') return ''; throw error }
  }
  async function writeText(file, text) {
    await readText(file)
    const temp = `${file}.${randomUUID()}.tmp`
    try { await fs.writeFile(temp, text, { mode: 0o600, flag: 'wx' }); await fs.rename(temp, file) } finally { await fs.rm(temp, { force: true }) }
  }
  async function load() {
    const text = await readText(dataFile)
    if (!text) return []
    try {
      const value = JSON.parse(text)
      return Array.isArray(value) ? value.filter(item => item && typeof item.alias === 'string') : []
    } catch { throw fail('Saved SSH hosts are unreadable. Remove ~/.config/openrod/ssh_hosts.json to start over.', 409) }
  }

  const render = hosts => hosts.map(({ alias, host, user, port, identityFile }) => [
    `Host ${alias}`, `  HostName ${host}`, ...(user ? [`  User ${user}`] : []), ...(port ? [`  Port ${port}`] : []),
    `  HostKeyAlias ${alias}`, `  UserKnownHostsFile ${configQuote(hostsFile)}`, '  GlobalKnownHostsFile /dev/null',
    '  CheckHostIP no', '  UpdateHostKeys no',
    ...(identityFile ? [`  IdentityFile ${configQuote(identityFile)}`, '  IdentitiesOnly yes'] : []),
    '  PasswordAuthentication no', '  KbdInteractiveAuthentication no',
  ].join('\n') + '\n').join('\n')

  async function validate(input) {
    if (!input || typeof input !== 'object') throw fail('Enter the connection details.')
    const name = typeof input.name === 'string' ? input.name.trim() : ''
    if (!name || name.length > 60) throw fail('Enter a display name of up to 60 characters.')
    const alias = slugify(name)
    if (!alias) throw fail('The display name needs at least one letter or number.')
    const { user, host } = parseTarget(input.hostname)
    let port = null
    if (input.port !== undefined && input.port !== null && String(input.port).trim() !== '') {
      port = Number(input.port)
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw fail('The SSH port must be a number from 1 to 65535.')
    }
    let identityFile = null
    if (input.auth === 'identity') {
      const raw = typeof input.identityFile === 'string' ? input.identityFile.trim() : ''
      if (!raw) throw fail('Choose the private key file to use.')
      const resolved = raw === '~' || raw.startsWith('~/') ? path.join(home, raw.slice(1)) : raw
      if (!path.isAbsolute(resolved) || !plain(resolved)) throw fail('Enter the full path to a private key, for example ~/.ssh/id_ed25519.')
      if (resolved.endsWith('.pub')) throw fail('That is a public key. Choose the matching private key file.')
      let stat
      try { stat = await fs.stat(resolved) } catch { throw fail('That key file does not exist.') }
      if (!stat.isFile()) throw fail('That path is not a key file.')
      identityFile = resolved
    } else if (input.auth !== undefined && input.auth !== 'default') throw fail('Choose how to authenticate.')
    return { name, alias, host, user, port, identityFile, auth: identityFile ? 'identity' : 'default' }
  }

  async function assertFree(alias) {
    if ((await load()).some(item => item.alias === alias)) throw fail(`You already saved a connection called “${alias}”. Choose another name.`, 409)
    if ((await existingHosts()).some(item => item.name === alias)) throw fail(`“${alias}” is already a host in your SSH configuration. Choose another name.`, 409)
  }

  async function scanKeys({ host, port }) {
    const run = keyscan ?? (async args => {
      const executable = findExecutable('ssh-keyscan')
      if (!executable) throw fail('The ssh-keyscan tool is missing. Install the OpenSSH client and try again.', 409)
      return runCli(executable, args, { timeoutMs: 15_000, outputLimit: 64 * 1024 })
    })
    const result = await run(['-T', '8', '-t', 'ed25519,ecdsa,rsa', ...(port ? ['-p', String(port)] : []), '--', host])
    if (result.timedOut) throw fail(`Timed out reaching ${host}. Check the hostname, the port and your network.`, 504)
    const keys = []
    for (const line of String(result.stdout).split('\n')) {
      if (!line || line.startsWith('#')) continue
      const [, type, blob] = line.trim().split(/\s+/)
      if (KEY_TYPE.test(type ?? '') && BASE64.test(blob ?? '') && !keys.some(key => key.type === type)) keys.push({ type, blob, fingerprint: fingerprint(blob) })
    }
    if (!keys.length) throw fail(`Couldn’t read a host key from ${host}. Check the hostname and port, and that SSH is running there.`, 502)
    return keys
  }

  return {
    directory, configFile, hostsFile,
    list: async () => (await load()).map(({ alias, name, host, user, port, identityFile }) => ({ alias, name, host, user, port, identityFile })),
    // Step 1: validate, read the host's keys and hold them until the user confirms.
    async scan(input) {
      const value = await validate(input)
      await assertFree(value.alias)
      const keys = await scanKeys(value)
      for (const [token, entry] of pending) if (entry.expires <= now()) pending.delete(token)
      const token = randomBytes(24).toString('base64url')
      pending.set(token, { value, keys, expires: now() + TOKEN_TTL_MS })
      return { token, alias: value.alias, host: value.host, user: value.user, port: value.port, fingerprints: keys.map(({ type, fingerprint }) => ({ type, fingerprint })) }
    },
    // Step 2: the user trusted exactly the keys shown in step 1.
    add: token => serial(async () => {
      const entry = pending.get(token)
      if (!entry || entry.expires <= now()) { pending.delete(token); throw fail('This confirmation expired. Start again.', 409) }
      const { value, keys } = entry
      await assertFree(value.alias)
      // The user's ~/.ssh/config is checked and updated before OpenRod's own files,
      // so a config we cannot edit leaves no half-saved host behind. It is handled
      // as bytes: it need not be UTF-8 and is kept unchanged after the Include.
      await fs.mkdir(path.join(home, '.ssh'), { recursive: true, mode: 0o700 })
      const userConfig = path.join(home, '.ssh/config'), include = `Include ${configQuote(configFile)}`
      const current = await fs.readFile(userConfig).catch(error => {
        if (error.code === 'ENOENT') return Buffer.alloc(0)
        throw fail(`OpenRod can't read ~/.ssh/config (${error.code ?? error.message}).`, 409)
      })
      const hasInclude = current.toString('latin1').split('\n').some(line => line.replace(/\r$/, '') === Buffer.from(include).toString('latin1'))
      if (!hasInclude) {
        const stat = await fs.lstat(userConfig).catch(error => { if (error.code === 'ENOENT') return null; throw error })
        if (stat && !stat.isFile()) throw fail(`~/.ssh/config is a symlink or not a regular file, so OpenRod won't edit it. Add this line at the top of the file it points to, then try again: ${include}`, 409)
      }
      await fs.mkdir(directory, { recursive: true, mode: 0o700 })
      const stat = await fs.lstat(directory)
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw fail('~/.config/openrod must be a regular directory.', 409)
      await fs.chmod(directory, 0o700)
      const hosts = [...await load(), { alias: value.alias, name: value.name, host: value.host, user: value.user, port: value.port, identityFile: value.identityFile }]
      const known = (await readText(hostsFile)).split('\n').filter(line => line && !line.startsWith(`${value.alias} `))
      // An Include after a Host line would only apply to that Host, so it goes first.
      // Including a file that does not exist yet is harmless to ssh.
      if (!hasInclude) await writeText(userConfig, Buffer.concat([Buffer.from(`${include}\n`), current])).catch(error => {
        throw error.status ? error : fail(`OpenRod can't update ~/.ssh/config (${error.code ?? error.message}). Add this line at its top yourself, then try again: ${include}`, 409)
      })
      await writeText(hostsFile, [...known, ...keys.map(key => `${value.alias} ${key.type} ${key.blob}`)].join('\n') + '\n')
      await writeText(dataFile, JSON.stringify(hosts, null, 2) + '\n')
      await writeText(configFile, render(hosts))
      pending.delete(token)
      return { alias: value.alias, name: value.name }
    }),
    remove: alias => serial(async () => {
      const hosts = await load()
      if (!hosts.some(item => item.alias === alias)) throw fail('That connection is not saved here.', 404)
      const rest = hosts.filter(item => item.alias !== alias)
      await writeText(dataFile, JSON.stringify(rest, null, 2) + '\n')
      await writeText(configFile, render(rest))
      await writeText(hostsFile, (await readText(hostsFile)).split('\n').filter(line => line && !line.startsWith(`${alias} `)).map(line => `${line}\n`).join(''))
      return { alias }
    }),
  }
}
