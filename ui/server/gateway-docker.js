import fs from 'node:fs/promises'
import { constants } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

// OpenShell's VM driver looks for local sandbox images only at DOCKER_HOST, or
// at /var/run/docker.sock when it is unset (NVIDIA/OpenShell#4155). Docker
// Desktop leaves that socket off by default, so the driver can't see the images
// OpenRod builds. This finds the driver, compares its engine with the build
// engine and, for the Homebrew service only, writes DOCKER_HOST to the
// gateway.env the service wrapper sources, then restarts the service.
// Everything is injected: nothing here imports the project, so tests never
// read the real OpenShell config.

export const FIXED_IN = null // first OpenShell release with NVIDIA/OpenShell#4155 fixed
export const LABEL = 'sh.brew.openshell'
export const MARK = "# openrod-managed: lets OpenShell's VM driver use your Docker images. Delete this line and the next to undo."
export const LIVE = ['ready', 'provisioning', 'starting', 'stopping', 'unknown', 'unspecified']
export const isVm = (drivers = []) => drivers.some((d) => d.name === 'vm' || d.capabilities?.driverName === 'openshell-driver-vm')

const fail = (message, status = 400) => Object.assign(new Error(message), { status })
const shQuote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`
const ASSIGN = /^\s*(?:export\s+)?DOCKER_HOST=(.*)$/
const isMark = (line) => line.startsWith('# openrod-managed')
const unquote = (v) => (v = v.trim(), /^'[^']*'$|^"[^"]*"$/.test(v) ? v.slice(1, -1) : v)
const bare = (line) => line?.replace(/\r$/, '') ?? ''
const argv0 = (command) => path.basename(command.trim().split(/\s+/)[0] ?? '')
const WRAPPER = ['xdg_gateway_env="${xdg_config_home}/openshell/gateway.env"', 'if [ -f "${xdg_gateway_env}" ]; then', 'elif [ -f "${prefix_gateway_env}" ]; then']

export function parseProcesses(listing) {
  return String(listing ?? '').split('\n').flatMap((line) => {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    return m ? [{ pid: Number(m[1]), ppid: Number(m[2]), command: m[3] }] : []
  })
}

// The driver serves the gateway on --bind-socket; its --internal-run-vm
// children are per-sandbox launchers and never match.
export function findDriver(processes, { listener = null } = {}) {
  const gateways = new Map(processes.filter((p) => argv0(p.command) === 'openshell-gateway').map((p) => [p.pid, p]))
  const drivers = processes.filter((p) => argv0(p.command) === 'openshell-driver-vm' && /\s--bind-socket(?:[\s=]|$)/.test(p.command) && gateways.has(p.ppid))
  const mine = listener ? drivers.filter((d) => d.ppid === listener) : drivers
  if (mine.length === 1) return { gateway: gateways.get(mine[0].ppid), driver: mine[0] }
  return drivers.length > 1 ? { ambiguous: true } : null
}

// `ps eww` prints the command then KEY=value pairs with no quoting; a value
// runs until the next ` KEY=` so values with spaces survive.
export function envValue(output, key) {
  let value
  for (const m of String(output ?? '').matchAll(new RegExp(`(?:^|\\s)${key}=(.*?)(?=\\s[A-Za-z_][A-Za-z0-9_]*=|\\s*$)`, 'g'))) value = m[1]
  return value
}

export function procEnviron(buffer) {
  const env = {}
  for (const entry of String(buffer ?? '').split('\0')) {
    const i = entry.indexOf('=')
    if (i > 0) env[entry.slice(0, i)] = entry.slice(i + 1)
  }
  return env
}

// bollard 0.20.2: only a unix:// DOCKER_HOST is used for a local socket.
export const driverSocket = (h) => h?.startsWith('unix://') ? h.slice(7) : '/var/run/docker.sock'
export const brewPrefix = (command) => /^(.+)\/opt\/openshell\/bin\/openshell-gateway(\s|$)/.exec(command ?? '')?.[1] ?? null

export function wrapperPrefixFile(script) {
  const lines = new Set(String(script ?? '').split('\n').map((l) => l.trim()))
  if (!WRAPPER.every((l) => lines.has(l))) return null
  return /^prefix_gateway_env="([^"$`\\]+)"$/m.exec(script)?.[1] ?? null
}

export const launchdPid = (out) => Number(/^\s*pid = (\d+)$/m.exec(out)?.[1]) || null
export const listensOn = (lsof, port) => lsof.split('\n').some((l) => l.startsWith('n') && l.endsWith(`:${port}`))

// Same order as the wrapper. Creating the XDG file when only the prefix file
// exists would hide the prefix file's settings.
export const chooseEnvFile = ({ xdgFile, prefixFile, xdgIsFile, prefixIsFile }) => xdgIsFile || !prefixFile || !prefixIsFile ? xdgFile : prefixFile

export function readManaged(text) {
  const lines = String(text ?? '').split('\n').map(bare), foreign = []
  let managed = null, effective = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i], next = ASSIGN.exec(lines[i + 1] ?? '')
    if (isMark(line) && next) { managed = effective = unquote(next[1]); i++; continue }
    if (line.trimStart().startsWith('#') || !/\bDOCKER_HOST\b/.test(line)) continue
    foreign.push(line)
    const m = ASSIGN.exec(line)
    if (m) effective = unquote(m[1])
    else if (/^\s*unset\b/.test(line)) effective = null
  }
  return { managed, foreign, effective }
}

// The block always goes last: in sh the last assignment wins, so it overrides a
// foreign line while leaving that line byte-for-byte in place.
export function writeManaged(text, value) {
  const lines = String(text ?? '').split('\n'), kept = []
  for (let i = 0; i < lines.length; i++) {
    if (!isMark(lines[i])) kept.push(lines[i])
    else if (ASSIGN.test(bare(lines[i + 1]))) i++
  }
  const rest = kept.join('\n')
  if (value == null) return rest
  return `${rest}${rest && !rest.endsWith('\n') ? '\n' : ''}${MARK}\nDOCKER_HOST=${quote(value)}\n`
}

export function quote(value) {
  if (typeof value !== 'string' || !value || /['\0\r\n]/.test(value)) throw fail('The Docker socket path has characters OpenRod won’t write.', 409)
  return /^[A-Za-z0-9_/.:@%+,=-]+$/.test(value) ? value : `'${value}'`
}

const semver = (v) => /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v ?? '').trim())?.slice(1).map(Number)
export const newer = (a, b) => {
  const x = semver(a), y = semver(b)
  if (!x || !y) return false
  const i = x.findIndex((n, k) => n !== y[k])
  return i >= 0 && x[i] > y[i]
}

export function decideFix(f) {
  const manual = (blocked) => ({ fix: 'manual', blocked })
  if (f.platform !== 'darwin') return manual('Add one setting to OpenShell and restart it.')
  if (!f.service) return manual('OpenShell isn’t running as a Homebrew service.')
  if (!f.plistOk || !f.prefixOk || !f.brew) return manual('This OpenShell setup is different from what OpenRod expects.')
  if (!f.fileOk) return manual(`OpenRod can’t write ${f.file}.`)
  if (!f.quotable) return manual('The Docker socket path has characters OpenRod won’t write.')
  if (f.conflict || !f.sandboxes || f.sandboxes.length || f.stranded?.length || f.declined || f.failedBefore || f.busy) return { fix: 'confirm', blocked: null }
  return { fix: 'auto', blocked: null }
}

const changed = () => fail('OpenShell’s settings file changed while OpenRod was editing it. Try again.', 409)
const readOrEmpty = (file) => fs.readFile(file, 'utf8').catch((e) => { if (e.code === 'ENOENT') return ''; throw e })
const realOrSelf = (file) => fs.realpath(file).catch((e) => { if (e.code === 'ENOENT') return file; throw e })
const dangling = (file) => fs.lstat(file).then((s) => s.isSymbolicLink(), () => false)

// Follows a symlink to the real file, keeps its mode, and only replaces it when
// it still holds what OpenRod read. A missing file reads as ''.
export async function writeEnvFile(file, next, expected, validate = null) {
  const real = await realOrSelf(file)
  // Renaming over a link OpenRod can't follow would replace it with a plain file.
  if (real === file && await dangling(file)) throw fail(`OpenRod can’t write ${file}.`, 409)
  let mode = 0o600, exists = true
  try {
    const st = await fs.stat(real)
    if (!st.isFile()) throw fail(`OpenRod can’t write ${real}.`, 409)
    mode = st.mode & 0o777
  } catch (e) {
    if (e.code !== 'ENOENT') throw e
    exists = false
    await fs.mkdir(path.dirname(real), { recursive: true, mode: 0o700 })
  }
  if (await readOrEmpty(real) !== expected) throw changed()
  if (exists) try { await fs.copyFile(real, `${real}.openrod.bak`, constants.COPYFILE_EXCL); await fs.chmod(`${real}.openrod.bak`, mode) } catch (e) { if (e.code !== 'EEXIST') throw e }
  const temp = `${real}.openrod-${randomUUID()}.tmp`
  try {
    await fs.writeFile(temp, next, { mode, flag: 'wx' })
    await fs.chmod(temp, mode)
    if (validate) await validate(temp)
    if (await readOrEmpty(real) !== expected) throw changed()
    await fs.rename(temp, real)
  } finally { await fs.rm(temp, { force: true }) }
  return real
}

// Sources the file the way the wrapper does (set -eu; set -a) with launchd's
// bare environment, so a line that would crash-loop the service never lands.
export async function validateEnvFile(run, file, { home, expect } = {}) {
  const r = await run('/bin/sh', ['-c', 'set -eu; set -a; . "$1"; set +a; printf %s "${DOCKER_HOST-}"', 'openrod-check', file], { env: { HOME: home, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }, timeoutMs: 5000 })
  if (r.code !== 0 || (expect !== undefined && r.stdout !== expect)) throw Object.assign(fail('OpenShell’s settings file has a line OpenRod can’t check. Use the steps instead.', 409), { unsafe: true })
}

async function removeEnvFile(file, expected) {
  const real = await realOrSelf(file)
  if (await readOrEmpty(real) !== expected) throw changed()
  await fs.rm(real, { force: true })
  return real
}

async function writable(file) {
  let real = file
  try { real = await fs.realpath(file); if (!(await fs.stat(real)).isFile()) return false } catch (e) { if (e.code !== 'ENOENT' || await dangling(file)) return false }
  for (let dir = path.dirname(real); ; dir = path.dirname(dir)) {
    try { await fs.access(dir, constants.W_OK); return true } catch (e) { if (e.code !== 'ENOENT' || dir === path.dirname(dir)) return false }
  }
}

const portOf = (endpoint) => { try { const u = new URL(endpoint); return u.port || (u.protocol === 'https:' ? '443' : '80') } catch { return null } }
const mismatch = (message, s, fix = s.fix) => Object.assign(fail(message, 409), { code: 'GATEWAY_DOCKER_MISMATCH', fix, sandboxes: s.sandboxes ?? null })

export function createGatewayDocker({
  platform = process.platform, home = os.userInfo().homedir, uid = process.getuid?.() ?? null,
  target, client, forget = () => {}, sandboxes, localEngine, docker, run, busy = () => null,
  stateFile, onJob = () => {}, now = Date.now, wait = (ms) => new Promise((r) => setTimeout(r, ms)), logger = console,
  readProc = (pid, name) => fs.readFile(`/proc/${pid}/${name}`),
} = {}) {
  const exec = (file, args, options) => run(file, args, { timeoutMs: 5000, ...options }).catch((e) => ({ code: null, stdout: '', stderr: e.message }))
  const iso = () => new Date(now()).toISOString()
  const tilde = (p) => p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p
  const isFile = (p) => p ? fs.stat(p).then((s) => s.isFile(), () => false) : false
  const keyOf = (build) => build.engineId ?? build.endpoint
  const failed = new Set(), unsafe = new Set()
  let state = null, loading = null, cache = null, probing = null, job = null, working = null

  const load = () => loading ??= fs.readFile(stateFile, 'utf8').then(JSON.parse).catch(() => ({})).then((v) => {
    v = v && typeof v === 'object' ? v : {}
    state = { undo: v.undo ?? null, declined: Array.isArray(v.declined) ? v.declined : [], lastChange: v.lastChange ?? null }
  })
  async function save() {
    if (!stateFile) return
    try {
      await fs.mkdir(path.dirname(stateFile), { recursive: true, mode: 0o700 })
      const temp = `${stateFile}.${randomUUID()}.tmp`
      try { await fs.writeFile(temp, `${JSON.stringify({ version: 1, ...state }, null, 2)}\n`, { mode: 0o600, flag: 'wx' }); await fs.rename(temp, stateFile) } finally { await fs.rm(temp, { force: true }) }
    } catch (e) { logger.warn?.(`OpenRod couldn’t save the Docker connection state: ${e.message}`) }
  }

  const blank = (patch = {}) => ({ state: 'n/a', reason: null, gateway: null, build: null, driver: null, pending: false, conflict: null, sandboxes: null, stranded: [], fix: null, blocked: null, steps: null, alternative: null, ...patch, checkedAt: iso() })
  function view(value) {
    const change = state?.lastChange
    return {
      ...value, ...(job?.status === 'working' ? { state: 'working' } : {}), job: job && { ...job },
      lastChange: change ? { ...change, undoable: Boolean(state.undo) && change.kind === 'connect' } : null,
    }
  }

  async function engineAt(socket) {
    try {
      await fs.stat(socket)
      return JSON.parse(await docker(['info', '--format', '{{json .}}'], { engine: { endpoint: `unix://${socket}` }, timeout: 10_000 }))?.ID || null
    } catch { return null }
  }

  // full: also work out the fix when the engines match (undo needs it).
  async function probe(full) {
    const out = blank(), done = (patch, facts = null) => ({ value: { ...out, ...patch }, facts })
    if (platform !== 'darwin' && platform !== 'linux') return done({})
    const t = await target()
    if (!t || t.remote) return done({})
    out.gateway = t.name
    let info, health
    try { const c = await client(t.name); [info, health] = await Promise.all([c.raw.getGatewayInfo({}), c.health()]) } catch { return done({ state: 'unknown', reason: 'OpenShell isn’t reachable.' }) }
    if (!isVm(info?.computeDrivers) || (FIXED_IN && !newer(FIXED_IN, health?.version))) return done({})
    let build
    try { const e = await localEngine(); build = { endpoint: e.endpoint, engineId: e.engineId || null, desktop: Boolean(e.desktop) } } catch (e) { return done({ state: 'no-docker', reason: e.message }) }
    out.build = build
    const port = portOf(t.endpoint)

    const processes = parseProcesses((await exec('ps', ['-ww', '-x', '-o', 'pid=,ppid=,command='], { outputLimit: 4 << 20 })).stdout)
    let found = findDriver(processes)
    if (found?.ambiguous && port) {
      const lsof = await exec('lsof', ['-nP', '-a', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fp'])
      found = findDriver(processes, { listener: Number(/^p(\d+)$/m.exec(lsof.stdout)?.[1]) || null })
    }
    if (!found || found.ambiguous) {
      const reason = 'OpenRod can’t find the OpenShell driver on this computer.'
      return done({ state: 'unknown', reason, fix: 'manual', blocked: reason })
    }
    const { gateway, driver } = found

    // Only these keys are kept from the driver's environment.
    let env = null
    if (platform === 'darwin') {
      const r = await exec('ps', ['eww', '-o', 'command=', '-p', String(driver.pid)], { outputLimit: 1 << 20 })
      const text = r.code === 0 ? r.stdout : ''
      env = { DOCKER_HOST: envValue(text, 'DOCKER_HOST'), XDG_CONFIG_HOME: envValue(text, 'XDG_CONFIG_HOME'), HOME: envValue(text, 'HOME'), PATH: envValue(text, 'PATH') !== undefined }
    } else {
      try { const e = procEnviron(await readProc(driver.pid, 'environ')); env = { DOCKER_HOST: e.DOCKER_HOST, XDG_CONFIG_HOME: e.XDG_CONFIG_HOME, HOME: e.HOME, PATH: 'PATH' in e } } catch { /* unreadable */ }
    }
    if (env && env.HOME === undefined && !env.PATH) env = null

    const prefix = brewPrefix(gateway.command)
    const xdgFile = path.join(env?.XDG_CONFIG_HOME || path.join(env?.HOME || home, '.config'), 'openshell', 'gateway.env')
    let prefixFile = null
    if (platform === 'darwin' && prefix) prefixFile = wrapperPrefixFile(await fs.readFile(path.join(prefix, 'opt/openshell/libexec/openshell-gateway-homebrew-service'), 'utf8').catch(() => ''))
    const prefixOk = Boolean(prefixFile)
    if (platform === 'darwin') prefixFile ??= path.join(prefix ?? '/opt/homebrew', 'var/openshell/gateway.env')
    const file = chooseEnvFile({ xdgFile, prefixFile, xdgIsFile: await isFile(xdgFile), prefixIsFile: await isFile(prefixFile) })
    let text = '', existed = false, readable = true
    try { text = await fs.readFile(file, 'utf8'); existed = true } catch (e) { readable = e.code === 'ENOENT' }
    const m = readManaged(text)

    const dockerHost = env ? env.DOCKER_HOST ?? null : m.effective
    const socket = driverSocket(dockerHost)
    const drv = { dockerHost, socket, source: env ? 'process' : m.effective != null ? 'file' : 'default', engineId: await engineAt(socket) }
    const [a, b] = await Promise.all([socket, build.endpoint.slice(7)].map((p) => fs.realpath(p).catch(() => null)))
    const same = Boolean((build.engineId && drv.engineId && build.engineId === drv.engineId) || (a && a === b))
    const facts = { name: t.name, gateway, file, text, existed, build, env: Boolean(env), driverHost: dockerHost, managed: m.managed, pending: m.managed === build.endpoint && m.effective === build.endpoint, brew: null, decision: null }
    if (same && !full) return done({ state: 'ok', driver: drv }, facts)

    const conflict = m.foreign.length ? { dockerHost: m.effective, source: 'file' }
      : env?.DOCKER_HOST && env.DOCKER_HOST !== m.managed && env.DOCKER_HOST !== build.endpoint ? { dockerHost: env.DOCKER_HOST, source: 'process' } : null
    let live = null
    try { live = (await sandboxes(t.name)).filter((s) => LIVE.includes(s.phase)) } catch { /* confirm instead */ }
    const listed = live && live.map(({ name, workspace }) => ({ name, workspace }))
    // A restart onto the build engine can't bring these back: their images live elsewhere.
    const stranded = []
    if (!same) for (const image of new Set((live ?? []).map((s) => s.image).filter((i) => i?.startsWith('openshell-template/')))) {
      try { await docker(['image', 'inspect', '--format', '{{.Id}}', image], { engine: { endpoint: build.endpoint }, timeout: 10_000 }) }
      catch { stranded.push(...live.filter((s) => s.image === image).map(({ name, workspace }) => ({ name, workspace, image }))) }
    }

    let service = false, plistOk = false
    if (platform === 'darwin') {
      const lc = await exec('/bin/launchctl', ['print', `gui/${uid}/${LABEL}`])
      const svcPid = lc.code === 0 ? launchdPid(lc.stdout) : null
      if (svcPid && svcPid === gateway.pid && port) service = listensOn((await exec('lsof', ['-nP', '-a', '-p', String(svcPid), '-iTCP', '-sTCP:LISTEN', '-Fn'])).stdout, port)
      const plist = await exec('plutil', ['-extract', 'EnvironmentVariables', 'raw', '-o', '-', path.join(home, 'Library/LaunchAgents', `${LABEL}.plist`)])
      plistOk = typeof plist.code === 'number' && plist.code !== 0
      if (prefix) facts.brew = await fs.access(path.join(prefix, 'bin/brew'), constants.X_OK).then(() => path.join(prefix, 'bin/brew'), () => null)
    }

    let line, quotable = true
    try { line = `DOCKER_HOST=${quote(build.endpoint)}` } catch { quotable = false; line = `DOCKER_HOST=${shQuote(build.endpoint)}` }
    // brew services restart would load a second gateway when this one isn't the service,
    // and rebuilds a hand-edited plist; kickstart restarts the loaded job as it is.
    const restart = platform === 'darwin' ? (!service ? null : plistOk ? 'brew services restart openshell' : `launchctl kickstart -k gui/${uid}/${LABEL}`)
      : String(await readProc(gateway.pid, 'cgroup').catch(() => '')).includes('openshell-gateway.service') ? 'systemctl --user restart openshell-gateway' : null
    const steps = { file: tilde(file), line, append: `mkdir -p ${shQuote(path.dirname(file))} && printf '\\n%s\\n' ${shQuote(line)} >> ${shQuote(file)}`, restart }
    const alternative = platform === 'darwin' && build.endpoint === `unix://${home}/.docker/run/docker.sock` ? 'docker-desktop-socket' : null
    const decision = decideFix({
      platform, service, plistOk, prefixOk, brew: facts.brew, fileOk: readable && !unsafe.has(file) && await writable(file), file: tilde(file), quotable,
      conflict, sandboxes: listed, stranded, declined: state.declined.includes(keyOf(build)), failedBefore: failed.has(`${build.engineId}|${file}`), busy: Boolean(busy()),
    })
    facts.decision = { ...decision, sandboxes: listed }
    if (same) return done({ state: 'ok', driver: drv }, facts)
    return done({ state: 'mismatch', driver: drv, pending: facts.pending, conflict, sandboxes: listed, stranded, ...decision, steps, alternative }, facts)
  }

  const remember = (r) => { cache = { at: now(), ...r }; return r }
  const safely = (full) => load().then(() => probe(full)).catch((e) => {
    logger.warn?.(`OpenRod couldn’t check OpenShell’s Docker setting: ${e.message}`)
    return { value: blank({ state: 'unknown', reason: 'OpenRod couldn’t check OpenShell’s Docker setting.' }), facts: null }
  })
  const refresh = ({ full = false } = {}) => full ? safely(true).then(remember) : probing ??= safely(false).then(remember).finally(() => { probing = null })

  async function status({ fresh = false } = {}) {
    await load()
    if (job?.status === 'working') return view(cache?.value ?? blank())
    if (!fresh && cache && now() - cache.at < 30_000) return view(cache.value)
    return view((await refresh()).value)
  }

  async function restartService(brew) {
    const r = await run(brew, ['services', 'restart', 'openshell'], { timeoutMs: 120_000, env: { ...process.env, HOMEBREW_NO_AUTO_UPDATE: '1', HOMEBREW_NO_ENV_HINTS: '1', NO_COLOR: '1' } }).catch((e) => ({ code: null, stdout: '', stderr: e.message }))
    if (r.code === 0 && !r.timedOut) return null
    return (r.stderr || r.stdout || '').trim().split('\n').at(-1) || (r.timedOut ? 'it timed out.' : `exit ${r.code}.`)
  }
  async function healthy(name, ms = 60_000) {
    const end = now() + ms
    forget(name)
    for (;;) {
      try { if ((await (await client(name)).health())?.status !== 'unhealthy') return true } catch { forget(name) }
      if (now() >= end) return false
      await wait(1000)
    }
  }
  const put = (file, text, expected, { created = false, check = null } = {}) => created && !text.trim() ? removeEnvFile(file, expected) : writeEnvFile(file, text, expected, check)

  // Write (when the text changes), restart the service, wait for health.
  // Failures put the file back as the rollback table in the spec says.
  async function change(j, f, { next, created = false, expect, writeStage }) {
    let real = f.file, wrote = false
    const restore = async () => {
      if (!wrote) return
      try { await put(real, f.text, next, { created: !f.existed }) } catch (e) { logger.warn?.(`OpenRod couldn’t put back ${real}: ${e.message}`) }
    }
    if (next !== f.text) {
      j.stage = writeStage
      real = await put(f.file, next, f.text, { created, check: (temp) => validateEnvFile(run, temp, { home, expect }) })
      wrote = true
      // A later rewrite of a file OpenRod created still removes it on undo. The
      // first write saved the unresolved path: the file wasn't there to resolve.
      if (j.kind === 'connect') { state.undo = { file: real, created: !f.existed || Boolean(state.undo?.created && [real, f.file].includes(state.undo.file)) }; await save() }
    }
    j.stage = 'Restarting OpenShell…'
    const lc = await exec('/bin/launchctl', ['print', `gui/${uid}/${LABEL}`])
    if (lc.code !== 0 || launchdPid(lc.stdout) !== f.gateway.pid) { await restore(); throw fail('OpenShell changed while OpenRod was working on it. Try again.', 409) }
    const problem = await restartService(f.brew)
    if (problem) {
      await restore()
      if (!(await healthy(f.name, 0) && (await refresh()).value.driver?.dockerHost === f.driverHost)) { await restartService(f.brew); await healthy(f.name) }
      throw fail(`OpenShell didn’t restart: ${problem}`, 502)
    }
    j.stage = 'Waiting for OpenShell…'
    if (!(await healthy(f.name))) {
      await restore(); await restartService(f.brew); await healthy(f.name)
      throw fail('OpenShell didn’t come back within a minute. OpenRod put its settings back.', 504)
    }
    j.stage = 'Checking Docker…'
    // The driver can show up a moment after the gateway answers health.
    let after = (await refresh()).value
    for (let i = 0; i < 10 && after.state === 'unknown'; i++) { await wait(1000); after = (await refresh()).value }
    return { after, restore }
  }

  async function connectJob(j, f) {
    const endpoint = f.build.endpoint
    // change() skips the write when the block is already in place and last.
    const next = writeManaged(f.text, endpoint)
    if (next === f.text) state.undo ??= { file: f.file, created: false }
    const { after, restore } = await change(j, f, { next, expect: endpoint, writeStage: 'Saving OpenShell settings…' })
    const picked = after.driver?.source === 'process' ? after.driver.dockerHost === endpoint : after.state === 'ok'
    if (!picked) { await restore(); throw fail('OpenShell restarted but didn’t pick up the Docker setting. Use the steps instead.', 502) }
    if (after.state !== 'ok') throw fail(`OpenShell still can’t reach Docker at ${endpoint}. Check that Docker is running.`, 502)
    state.lastChange = { id: j.id, kind: 'connect', auto: j.auto, at: iso() }
    state.declined = state.declined.filter((k) => k !== keyOf(f.build))
    await save()
  }

  async function undoJob(j, f) {
    const { after } = await change(j, f, { next: writeManaged(f.text, null), created: Boolean(state.undo?.created), writeStage: 'Undoing the Docker change…' })
    if (after.driver?.source === 'process' && after.driver.dockerHost === f.managed) throw fail('OpenShell restarted but still uses the Docker setting. Edit the file yourself to undo.', 502)
    const key = keyOf(f.build)
    state.declined = [...state.declined.filter((k) => k !== key), key]
    state.lastChange = { id: j.id, kind: 'undo', auto: false, at: iso() }
    state.undo = null
    await save()
  }

  // Checks busy() in the same tick that creates the job, so a template save
  // can't start in between.
  function start(kind, auto, f) {
    if (job?.status === 'working') return working
    const reason = busy()
    if (reason) throw fail(reason === 'saving' ? 'A template is being saved. Try again in a moment.' : 'Wait for the connection change to finish.', 409)
    const j = job = { id: randomUUID(), kind, auto, status: 'working', stage: null, error: null, startedAt: iso(), finishedAt: null }
    working = (kind === 'connect' ? connectJob : undoJob)(j, f)
      .then(() => { j.status = 'done' }, (e) => {
        j.status = 'failed'; j.error = e.message
        if (e.unsafe) unsafe.add(f.file)
        if (auto) failed.add(`${f.build.engineId}|${f.file}`)
        logger.warn?.(`OpenRod couldn’t ${kind === 'connect' ? 'connect OpenShell to Docker' : 'undo the Docker change'}: ${e.message}`)
      })
      // The verify probe ran before the outcome above was recorded.
      .then(() => { j.finishedAt = iso(); j.stage = null; cache = null })
      .then(() => status())
    onJob(working)
    return working
  }

  function gate(s, { confirm, seen, auto = false }, restarts) {
    if (s.fix === 'manual') throw mismatch(s.blocked, s)
    const saw = new Set(Array.isArray(seen) ? seen : [])
    if ((auto && s.fix !== 'auto') || (s.fix === 'confirm' && (!confirm || (s.sandboxes ?? []).some((x) => !saw.has(`${x.workspace}/${x.name}`))))) throw mismatch(restarts, s, 'confirm')
  }

  async function connect({ confirm = false, seen = [], auto = false } = {}) {
    await load()
    if (job?.status === 'working') return status()
    const r = await refresh()
    if (r.value.state !== 'mismatch') return view(r.value)
    gate(r.value, { confirm, seen, auto }, 'Connecting restarts OpenShell and running sandboxes.')
    start('connect', auto, r.facts)
    return status()
  }

  async function undo({ confirm = false, seen = [] } = {}) {
    await load()
    if (job?.status === 'working') return status()
    const r = await refresh({ full: true }), f = r.facts
    if (!f?.decision) throw fail(r.value.reason ?? 'OpenShell isn’t reachable.', 409)
    if (f.managed == null) throw fail('OpenShell’s settings changed after OpenRod edited them. Edit the file yourself to undo.', 409)
    gate(f.decision, { confirm, seen }, 'Undoing restarts OpenShell and running sandboxes.')
    start('undo', false, f)
    return status()
  }

  async function ensure() {
    try {
      await load()
      if (job?.status === 'working') return await working
      const r = await refresh()
      if (r.value.state === 'mismatch' && r.value.fix === 'auto') return await start('connect', true, r.facts)
      return view(r.value)
    } catch (e) { logger.warn?.(`OpenRod couldn’t check OpenShell’s Docker setting: ${e.message}`); return null }
  }

  async function settle() { while (job?.status === 'working') await working?.catch(() => {}) }

  // Fails open on unknown and no-docker: only a known mismatch blocks a launch.
  async function assertLaunch({ built = false, localOnly = false } = {}) {
    await settle()
    await load()
    let r = cache && now() - cache.at < 30_000 ? cache : null
    if (!r || r.value.state === 'mismatch') r = await refresh()
    if (r.value.state !== 'mismatch') return
    if (!built && !(typeof localOnly === 'function' ? await localOnly() : localOnly)) return
    if (r.value.fix === 'auto') {
      try { await start('connect', true, r.facts); r = await refresh() } catch { /* busy: ask the user instead */ }
      if (r.value.state !== 'mismatch') return
    }
    throw mismatch('OpenShell can’t use your Docker images yet. Connect it to Docker, then try again.', r.value)
  }

  return { status, ensure, settle, assertLaunch, connect, undo }
}
