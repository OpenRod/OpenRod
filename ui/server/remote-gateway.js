import fs from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { CONFIG_DIR, clearConsoleContext, contextConfigured, contextSelection, defaultContextSelection, listGateways, gatewayWorkspaces, selectConsoleContext } from './gateway.js'
import { stateDirectory } from './paths.js'
import { fail, findExecutable, runCli, sshBinary } from './openshell-cli.js'
import { listSshHosts, probeHost, installDocker as installHostDocker, installRuntime, sshArgs } from './remote-hosts.js'
import { prepareGatewayState, registerManagedGateway } from './remote-gateway-state.js'
import { ensureGateway } from './gateway-install.js'
import { startRemoteRuntime } from './remote-runtime.js'
import { reapOrphans } from './orphan-processes.js'

const PACKAGE_LIMIT = 4 * 1024 ** 3
const localGateways = () => listGateways().filter(target => target.name !== 'aws-eks' && target.supported && !target.remote && ['localhost', '127.0.0.1', '[::1]'].includes(new URL(target.endpoint).hostname))

function ownedProcess(executable, args, env, onExit) {
  const child = spawn(executable, args, { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = '', error = null, ended = false, stopping = false
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output = (output + chunk.toString()).slice(-8000) })
  const done = new Promise(resolve => {
    child.once('error', value => { error = value })
    child.once('close', (code, signal) => {
      ended = true
      error ??= new Error(`${path.basename(executable)} exited (${signal ?? code}). ${output.trim()}`)
      if (!stopping) onExit(error)
      resolve()
    })
  })
  const kill = signal => { try { process.kill(-child.pid, signal) } catch { /* already stopped */ } }
  return {
    check() { if (ended || error) throw error },
    async stop() {
      stopping = true
      if (!ended) {
        kill('SIGTERM')
        const timer = setTimeout(() => kill('SIGKILL'), 2000)
        try { await done } finally { clearTimeout(timer) }
      }
    },
  }
}

function pingDocker(socketPath) {
  return new Promise((resolve, reject) => {
    const req = http.get({ socketPath, path: '/_ping', timeout: 2000 }, res => {
      res.resume()
      res.once('end', () => res.statusCode === 200 ? resolve() : reject(new Error(`Docker returned HTTP ${res.statusCode}`)))
      res.once('error', reject)
    })
    req.once('timeout', () => req.destroy(new Error('Docker tunnel timed out')))
    req.once('error', reject)
  })
}

async function waitReady(check, guards, signal, description) {
  let last
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    signal.throwIfAborted()
    for (const guard of guards) guard.check()
    try {
      await check()
      for (const guard of guards) guard.check()
      return
    } catch (error) { last = error }
    await delay(250, undefined, { signal })
  }
  throw fail(`${description}: ${last?.message ?? 'timed out'}`, 504)
}

async function acquireLock() {
  const root = path.join(stateDirectory(), 'remote-gateways')
  await fs.mkdir(root, { recursive: true, mode: 0o700 })
  const file = path.join(root, 'process.lock')
  const claim = async () => {
    const handle = await fs.open(file, 'wx', 0o600)
    try { await handle.writeFile(JSON.stringify({ pid: process.pid })) } finally { await handle.close() }
    return () => fs.rm(file, { force: true })
  }
  try { return await claim() } catch (error) { if (error.code !== 'EEXIST') throw error }
  let owner
  try { owner = JSON.parse(await fs.readFile(file, 'utf8')) } catch { throw fail('Another console is starting a remote connection.', 409) }
  if (!Number.isInteger(owner.pid) || owner.pid < 1) throw fail(`Invalid remote process lock: ${file}`, 409)
  try { process.kill(owner.pid, 0) } catch (error) {
    if (error.code === 'ESRCH') { await fs.rm(file); return claim() }
    throw error
  }
  throw fail('Another console is managing the remote gateway. Disconnect or close that console first.', 409)
}

export function createRemoteConnections({ onSelected = () => {}, onDeselected = () => {}, logger = console } = {}) {
  let job = null, active = null, processes = [], temporary = null, unlock = null, closed = false
  let gatewayExecutable
  let disconnecting = false
  const initial = contextSelection()
  let returnContext = contextConfigured() && localGateways().some(target => target.name === initial.gateway) ? initial : null
  let lastRemote = null, historyReady = null, historyWrites = Promise.resolve()
  const historyFile = path.join(stateDirectory(), 'remote-gateways', 'last-location.json')
  const validContext = value => value && /^[\w.-]{1,64}$/.test(value.gateway ?? '') && /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(value.workspace ?? '')
  const loadHistory = () => historyReady ??= (async () => {
    try {
      const saved = JSON.parse(await fs.readFile(historyFile, 'utf8'))
      if (!returnContext && validContext(saved.returnContext) && localGateways().some(target => target.name === saved.returnContext.gateway)) returnContext = saved.returnContext
      if (validContext(saved.remote) && /^console-ssh-[a-f0-9]{24}$/.test(saved.remote.gateway) && typeof saved.remote.host === 'string') lastRemote = { ...saved.remote, status: 'disconnected', error: null }
    } catch (error) { if (error.code !== 'ENOENT') logger.warn(`Remote location history unavailable: ${error.message}`) }
  })()
  const saveHistory = () => {
    const data = JSON.stringify({ returnContext, remote: lastRemote })
    historyWrites = historyWrites.catch(() => {}).then(async () => {
      await fs.mkdir(path.dirname(historyFile), { recursive: true, mode: 0o700 })
      const temporary = `${historyFile}.${randomUUID()}.tmp`
      await fs.writeFile(temporary, data, { mode: 0o600 })
      await fs.rename(temporary, historyFile)
    })
    return historyWrites.catch(error => logger.warn(`Remote location history could not be saved: ${error.message}`))
  }
  async function locationSnapshot() {
    await loadHistory()
    const selected = defaultContextSelection()
    const before = JSON.stringify({ returnContext, remote: lastRemote })
    if (contextConfigured() && localGateways().some(target => target.name === selected.gateway)) returnContext = selected
    if (active?.status === 'connected' && selected.gateway === active.gateway) {
      active.workspace = selected.workspace
      lastRemote = { host: active.host, gateway: active.gateway, workspace: active.workspace, status: 'disconnected', error: null }
    }
    let remote = active?.workspace && (active.status === 'connected' || active.gateway === lastRemote?.gateway) ? active : lastRemote
    if (!remote && /^console-ssh-[a-f0-9]{24}$/.test(selected.gateway)) {
      try {
        const owner = JSON.parse(await fs.readFile(path.join(CONFIG_DIR, 'gateways', selected.gateway, 'console-managed.json'), 'utf8'))
        if (typeof owner.host === 'string') remote = { host: owner.host, ...selected, status: 'disconnected', error: null }
      } catch { /* No managed registration to retain. */ }
    }
    if (!returnContext && (remote || contextConfigured())) {
      const locals = localGateways()
      const target = locals.find(candidate => candidate.name === 'openshell') ?? (locals.length === 1 ? locals[0] : null)
      if (target) returnContext = { gateway: target.name, workspace: process.env.OPENSHELL_WORKSPACE || 'default' }
    }
    if (before !== JSON.stringify({ returnContext, remote: lastRemote })) await saveHistory()
    const local = returnContext && localGateways().some(target => target.name === returnContext.gateway) ? returnContext : null
    return view({ returnContext: local, remote: remote ? { host: remote.host, gateway: remote.gateway, workspace: remote.workspace, status: remote.status, error: remote.error ?? null } : null })
  }
  const jobs = new Map(), pending = new Set(), abort = new AbortController()
  const signal = abort.signal
  const view = value => value ? structuredClone(value) : null
  const checkOpen = () => { if (closed) throw fail('The console is shutting down.', 503) }
  const getJob = id => {
    const value = jobs.get(id)
    if (!value) throw fail('This connection attempt has expired. Connect again.', 404)
    return value
  }
  const track = (value, operation) => {
    const running = Promise.resolve().then(operation).catch(error => {
      value.status = 'failed'; value.error = closed ? 'The console was closed.' : error.message
      value.stage = 'Connection failed'
    }).finally(() => pending.delete(running))
    pending.add(running)
  }
  const idle = () => {
    checkOpen()
    if (disconnecting || job?.status === 'working' || pending.size) throw fail('A connection operation is already running.', 409)
  }
  async function stopRemote() {
    const stopping = processes; processes = []
    const directory = temporary, release = unlock
    temporary = null; unlock = null
    if (active) active.status = 'disconnected'
    // Only local transports are owned here. The remote Docker gateway and
    // workloads deliberately survive console shutdown and workstation sleep.
    for (const child of stopping.reverse()) await child.stop()
    if (directory) await fs.rm(directory, { recursive: true, force: true })
    if (release) await release()
  }
  function exited(error) {
    // Startup failures are handled by readiness guards and their catch block.
    if (closed || active?.status !== 'connected') return
    if (active) { active.status = 'failed'; active.error = error.message }
    logger.warn(`Remote connection stopped: ${error.message}`)
    const stopping = stopRemote().catch(error => logger.warn(`Remote cleanup failed: ${error.message}`)).finally(() => {
      if (active) active.status = 'failed'
      pending.delete(stopping)
    })
    pending.add(stopping)
  }
  async function select(gateway, preferredWorkspace) {
    checkOpen()
    await loadHistory()
    const workspaces = await gatewayWorkspaces(gateway)
    const previous = defaultContextSelection()
    if (contextConfigured() && localGateways().some(target => target.name === previous.gateway)) returnContext = previous
    const preferred = preferredWorkspace ?? (previous.gateway === gateway ? previous.workspace : 'default')
    const workspace = process.env.OPENSHELL_WORKSPACE || workspaces.find(item => item.name === preferred)?.name || workspaces.find(item => item.name === 'default')?.name || workspaces[0]?.name
    if (!workspace) throw fail('This gateway returned no accessible workspaces.', 409)
    const result = await selectConsoleContext({ gateway, workspace })
    if (localGateways().some(target => target.name === gateway)) returnContext = { gateway, workspace }
    if (active?.gateway === gateway) active.workspace = workspace
    await saveHistory()
    checkOpen()
    onSelected(result)
  }
  // With a local gateway already selected, the remote joins as a second
  // location instead of replacing the console context, so no page reloads.
  async function attach(gateway) {
    checkOpen()
    const workspaces = await gatewayWorkspaces(gateway)
    const workspace = process.env.OPENSHELL_WORKSPACE || workspaces.find(item => item.name === 'default')?.name || workspaces[0]?.name
    if (!workspace) throw fail('This gateway returned no accessible workspaces.', 409)
    if (active?.gateway === gateway) active.workspace = workspace
  }
  const keepsLocalSelection = () => contextConfigured() && localGateways().some(target => target.name === contextSelection().gateway)
  async function startGateway(value) {
    checkOpen()
    value.stage = 'Starting the persistent gateway on the SSH host'
    await stopRemote()
    unlock = await acquireLock()
    try {
      await reapOrphans({ stateRoot: stateDirectory(), logger })
      temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'os-ssh-'))
      const socket = path.join(temporary, 'docker.sock')
      const state = await prepareGatewayState(value.host, value.probe, socket)
      active = { host: value.host, gateway: state.name, architecture: value.probe.arch, status: 'connecting', error: null }
      await startRemoteRuntime(value.host, value.probe, state, { signal, download: value.runtimeInstallation !== 'upload' })
      const args = sshArgs(value.host)
      args.splice(args.length - 2, 0, '-N', '-o', 'ExitOnForwardFailure=yes', '-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-o', 'StreamLocalBindMask=0177', '-L', `${socket}:${value.probe.dockerSocket}`, '-L', `127.0.0.1:${state.port}:127.0.0.1:${state.port}`)
      const tunnel = ownedProcess(sshBinary(), args, process.env, exited)
      processes.push(tunnel)
      await waitReady(() => pingDocker(socket), [tunnel], signal, 'The SSH Docker tunnel did not become ready')
      signal.throwIfAborted()
      await registerManagedGateway(state, value.host)
      await waitReady(() => gatewayWorkspaces(state.name), [tunnel], signal, 'The remote gateway did not become ready')
      if (keepsLocalSelection()) await attach(state.name)
      else await select(state.name)
      tunnel.check()
      active.status = 'connected'
      lastRemote = { host: active.host, gateway: active.gateway, workspace: active.workspace, status: 'disconnected', error: null }
      await saveHistory()
      value.gateway = state.name; value.status = 'ready'; value.stage = 'Connected'
    } catch (error) {
      await stopRemote()
      if (active) { active.status = 'failed'; active.error = error.message }
      throw error
    }
  }
  async function version(value) {
    if (!sshBinary()) throw fail('Install OpenSSH on this computer first.', 409)
    gatewayExecutable = await ensureGateway({ signal, onProgress: stage => { value.stage = stage } })
    const result = await runCli(gatewayExecutable, ['--version'], { timeoutMs: 5000 })
    const match = /^openshell-gateway (\d+\.\d+\.\d+(?:-[\w.-]+)?)\s*$/.exec(result.stdout.trim())
    if (result.code !== 0 || !match) throw fail('Could not determine the local OpenShell gateway version.', 409)
    return match[1]
  }
  async function prepareRuntime(value) {
    signal.throwIfAborted()
    if (value.probe.dockerInstalled === false) {
      value.status = 'needs-docker'
      value.stage = value.probe.dockerInstallReason || 'Docker Engine is missing. Approve installation to continue.'
      return
    }
    if (!value.probe.runtimeReady) {
      if (value.runtimeInstallation === 'upload') { value.status = 'needs-install'; value.stage = 'Install the OpenShell sandbox runtime'; return }
      value.stage = 'Downloading OpenShell runtime images on the remote machine'
      try {
        value.probe = await installRuntime(value.host, value.probe.version, 'download', { signal, onProgress: stage => { value.stage = stage } })
      } catch (error) {
        signal.throwIfAborted()
        throw fail(`${error.message} Check the SSH host's access to ghcr.io, or reconnect using Docker-save package upload.`, error.status ?? 502)
      }
    }
    await startGateway(value)
  }
  function begin(input) {
    idle()
    if (Boolean(input.host) === Boolean(input.localGateway)) throw fail('Choose one local gateway or SSH host.')
    if (process.env.OPENSHELL_GATEWAY && input.localGateway !== process.env.OPENSHELL_GATEWAY) throw fail('Remove OPENSHELL_GATEWAY to select a different connection.', 409)
    const runtimeInstallation = input.runtimeInstallation === undefined ? 'download' : input.runtimeInstallation
    if (input.host && runtimeInstallation !== 'download' && runtimeInstallation !== 'upload') throw fail('Choose runtime download or Docker-save package upload.')
    if (['needs-install', 'needs-docker'].includes(job?.status)) { job.status = 'failed'; job.error = 'Replaced by another connection attempt.' }
    const value = { id: randomUUID(), host: input.host ?? null, runtimeInstallation, status: 'working', stage: input.host ? 'Checking SSH and the remote runtime' : 'Connecting to the local gateway' }
    job = value; jobs.set(value.id, value)
    while (jobs.size > 20) jobs.delete(jobs.keys().next().value)
    track(value, async () => {
      if (input.localGateway) {
        if (!localGateways().some(target => target.name === input.localGateway)) throw fail('Choose a registered local gateway.')
        await select(input.localGateway)
        value.gateway = input.localGateway; value.status = 'ready'; value.stage = 'Connected'
        return
      }
      if (!(await listSshHosts()).some(host => host.name === input.host)) throw fail('Choose a host from your SSH configuration.')
      const installedVersion = await version(value)
      value.probe = await probeHost(input.host, installedVersion, { signal })
      await prepareRuntime(value)
    })
    return view(value)
  }
  function installation(id) {
    idle()
    const value = getJob(id)
    if (value !== job || value.status !== 'needs-install') throw fail('This connection is not waiting for an installation.', 409)
    value.status = 'working'; value.error = null
    return value
  }
  function install(value, method, packagePath) {
    track(value, async () => {
      try {
        value.probe = await installRuntime(value.host, value.probe.version, method, { packagePath, signal, onProgress: stage => { value.stage = stage } })
        await startGateway(value)
      } finally { if (packagePath) await fs.rm(path.dirname(packagePath), { recursive: true, force: true }) }
    })
    return view(value)
  }
  return {
    locationSnapshot,
    async overview() {
      const snapshot = await locationSnapshot()
      const connection = snapshot.remote
      return { hosts: await listSshHosts(), locals: localGateways().map(({ name, endpoint }) => ({ name, endpoint })), active: view(connection), job: view(job), tools: { ssh: Boolean(sshBinary()), gateway: Boolean(findExecutable('openshell-gateway')) } }
    },
    changing: () => disconnecting || job?.status === 'working',
    architecture: () => active?.status === 'connected' ? active.architecture : null,
    begin,
    job: id => view(getJob(id)),
    installDocker(id, approve) {
      idle()
      if (approve !== true) throw fail('Approve Docker package installation, service activation, and Docker-group access before continuing.')
      const value = getJob(id)
      if (value !== job || value.status !== 'needs-docker') throw fail('This connection is not waiting for Docker installation.', 409)
      if (!value.probe.dockerInstallSupported) throw fail(value.probe.dockerInstallReason || 'Install Docker Engine manually on this host, then reconnect.', 409)
      value.status = 'working'; value.error = null; value.stage = 'Installing Docker Engine on the remote machine'
      track(value, async () => {
        value.probe = await installHostDocker(value.host, value.probe.version, { signal, onProgress: stage => { value.stage = stage } })
        await prepareRuntime(value)
      })
      return view(value)
    },
    download(id) {
      const value = installation(id)
      value.stage = 'Downloading OpenShell runtime images on the remote machine'
      return install(value, 'download')
    },
    async upload(id, req) {
      const length = Number(req.headers['content-length'])
      if (!Number.isSafeInteger(length) || length < 1 || length > PACKAGE_LIMIT) throw fail('Choose a Docker-save package between 1 byte and 4 GiB.', 413)
      const value = installation(id)
      value.stage = 'Receiving the runtime package'
      let directory
      try {
        directory = await fs.mkdtemp(path.join(os.tmpdir(), 'os-package-'))
        const file = path.join(directory, 'runtime.tar')
        let bytes = 0
        const counter = new Transform({ transform(chunk, encoding, callback) {
          bytes += chunk.length
          callback(bytes > length ? fail('The runtime package exceeds its declared size.', 413) : null, chunk)
        } })
        await pipeline(req, counter, createWriteStream(file, { mode: 0o600, flags: 'wx' }), { signal })
        if (bytes !== length) throw fail('The runtime package upload was incomplete.')
        return install(value, 'upload', file)
      } catch (error) {
        if (directory) await fs.rm(directory, { recursive: true, force: true })
        value.status = 'failed'; value.error = error.message; value.stage = 'Package upload failed'
        throw error
      }
    },
    // Disconnects if needed, then drops the remembered location so it no longer
    // appears. The host itself stays in the user's SSH configuration.
    async forget() {
      if (disconnecting || job?.status === 'working') throw fail('Wait for the current connection change to finish.', 409)
      await loadHistory()
      if (active?.status === 'connected' || active?.status === 'connecting') await this.disconnect()
      active = null
      lastRemote = null
      await saveHistory()
      return { ok: true }
    },
    async disconnect() {
      idle()
      const current = contextSelection()
      const replaceSelection = current.gateway === active?.gateway || /^console-ssh-[a-f0-9]{24}$/.test(current.gateway)
      if (replaceSelection && process.env.OPENSHELL_GATEWAY) throw fail('Remove OPENSHELL_GATEWAY before disconnecting its selected gateway.', 409)
      disconnecting = true
      try {
        await stopRemote()
        job = null
        if (!replaceSelection) return { ok: true }
        const locals = localGateways()
        let target = locals.find(candidate => candidate.name === returnContext?.gateway)
        if (!target) {
          // A restarted console may not remember the prior local selection.
          // Restore only an unambiguous reachable registration, never a guess.
          const reachable = (await Promise.all(locals.map(async candidate => {
            try { return (await gatewayWorkspaces(candidate.name)).length ? candidate : null }
            catch { return null }
          }))).filter(Boolean)
          if (reachable.length === 1) target = reachable[0]
        }
        if (target) {
          try {
            await select(target.name, returnContext?.gateway === target.name ? returnContext.workspace : undefined)
            return { ok: true }
          } catch (error) { logger.warn(`Remote disconnected; local connection unavailable: ${error.message}`) }
        }
        clearConsoleContext()
        onDeselected()
        return { ok: true }
      } finally { disconnecting = false }
    },
    async close() {
      if (closed) return
      closed = true; abort.abort()
      await Promise.allSettled([...pending])
      await historyWrites.catch(() => {})
      await stopRemote()
    },
  }
}
