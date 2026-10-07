import {createLocalCloudNative} from './local-cloud-native.js'
import { claimCloudAnnouncement } from './announcements.js'
import {cloudSshRoute,cloudSshUpgrade} from './cloud-ssh.js'
import {createLocalCloud} from './local-cloud.js'
import { cloudOrigin, CLOUD_SOON } from './cloud-origin.js'
import { setupTargetsFor, validateSetupTargets } from '../shared/setup-targets.js'
import { localTransfer, importTransfer, exportTransfer } from './cloud-transfer.js'
import { resourceImportRoute } from './resource-imports.js'
import { consoleCapabilities } from './capabilities.js'
import path from 'node:path'
import { Readable } from 'node:stream'
import { scopedStateDirectory, stateDirectory } from './paths.js'
import { createActivityStore } from './activity-store.js'
import { createActivityDelivery } from './activity-delivery.js'
import { exportEvent } from '../src/lib/activity-export.js'
import { agentInventory } from './agent-inventory.js'
import { randomUUID } from 'node:crypto'
import { imageTemplateLabels, nameSandboxImages } from '../src/lib/sandbox-images.js'
import { PROJECT_LABEL, templateSession, isSession, sessionLaunch, persistentTerminalPolicy, persistentGateway, PERSISTENT_TERMINAL_LABEL } from '../src/lib/sandbox-session.js'
import { sandboxIdentityLabels } from './sandbox-identity.js'
import { consoleContext, contextConfigured, contextKey, contextSelection, forgetGatewayConnection, gateway, gatewayWorkspaces, iso, listGateways, logView, policyView, providerView, runWithContext, sandboxView, selectConsoleContext, workspaceScope } from './gateway.js'
import { createRemoteConnections } from './remote-gateway.js'
import { createSshHostStore } from './ssh-hosts.js'
import { createLocationInventory } from './location-inventory.js'
import { policyRoute } from './policy.js'
import { orgRoute, createInGroups, enforcePolicyOnly, startOrgSweeper, assignGroup } from './org.js'
import { expose, ingressRoute, startSweeper } from './ingress.js'
import { imageTemplateRoute, imageTemplateForLaunch, listImageTemplates, localEngine, runDocker, savingTemplate, setGatewayDocker } from './image-templates.js'
import { createGatewayDocker } from './gateway-docker.js'
import { runCli } from './openshell-cli.js'
import { editorRoute } from './editor.js'
import { terminalRoute, terminalUpgrade } from './terminal.js'
import { assertPackagesPrepared } from '../shared/setup-launch.js'
import { setupRoute, resolveSetups } from './setups.js'
import { deploymentRoute, startSetupInstall, launchSetupAccess, setupJobsForSandbox } from './setup-deployment.js'
import { setSandboxSetups, forgetSandbox } from './setup-members.js'
import { sshRoute } from './ssh.js'
import { agentAccessRules } from '../shared/agent-access.js'
import { filesRoute, planSeed, receiveUpload, serveDownload, startSeed } from './files.js'

// These routes act with the operator's gateway certificate. A loopback Host
// header alone is not proof of a local caller when Vite is bound to a LAN
// address, so check the socket, the Host and the browser's own origin claims.
export { isLocalApiRequest } from './security.js'
import { createSecurity, releaseConfig, assertCloudOperation, requestPath, identityContext } from './security.js'
import { createLaunchToken, createTokenGate, tokenUrl } from './launch-token.js'

// A mutation must also carry a JSON body and a custom header, which a
// cross-site form or image tag cannot send without a CORS preflight we never grant.
function isMutation(req, security) {
  return req.method === 'POST'
    && req.headers.origin === security.originFor(req)
    && (req.headers['content-type'] ?? '').startsWith('application/json')
    && req.headers['x-openshell-console'] === '1'
}

const NAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/
const IMAGE = /^[\w./:@-]{1,256}$/

export async function readRequestBody(req, limit = 65536) {
  const chunks = []
  let bytes = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.length
    if (bytes > limit) throw Object.assign(new Error('Request too large'), { status: 413 })
    chunks.push(buffer)
  }
  if (!bytes) return {}
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) }
  catch { throw Object.assign(new Error('Invalid JSON request'), { status: 400 }) }
}
const body = readRequestBody

function send(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(payload))
}

const fail = (message, status = 400) => Object.assign(new Error(message), { status })

// ---- reads ------------------------------------------------------------------

async function listSandboxes(current) {
  const { client, workspaceScope } = current ?? await gateway()
  const response = await client.raw.listSandboxes({ workspaceScope })
  return nameSandboxImages(response.sandboxes.map(sandboxView), await listImageTemplates().catch(() => [])).sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))
}

// Deleted sandboxes have no draft or log buffer worth asking for.
const live = (sandboxes) => sandboxes.filter((s) => s.phase !== 'deleting')

async function overview() {
  const current = await gateway()
  const { client, target, workspace, workspaceScope } = current
  const [health, info, providers, sandboxes] = await Promise.all([
    client.health(),
    client.raw.getGatewayInfo({}),
    client.raw.listProviders({ workspaceScope }),
    listSandboxes(current),
  ])
  return {
    gateway: {
      name: target.name,
      endpoint: target.endpoint,
      authMode: target.authMode,
      remote: target.remote,
      workspace,
      status: health.status,
      version: health.version,
      drivers: (info.computeDrivers ?? []).map((d) => ({
        name: d.name,
        driver: d.capabilities?.driverName ?? d.name,
        version: d.capabilities?.driverVersion ?? null,
      })),
    },
    providers: providers.providers.map(providerView),
    sandboxes,
  }
}

async function sandboxDetail(name) {
  const { client, target, workspace, workspaceScope } = await gateway()
  const [sandbox, config] = await Promise.all([
    client.raw.getSandbox({ name, workspaceScope }),
    client.sandbox.getConfig(name, { workspace }).catch(() => null),
  ])
  const templates = await listImageTemplates().catch(() => [])
  const [view] = nameSandboxImages([sandboxView(sandbox.sandbox)], templates)
  const setupJobs = setupJobsForSandbox(name, view.createdAt)
  const inventory = await agentInventory(client, view, target.endpoint, JSON.stringify(setupJobs.map(job => [job.setup, job.status, job.at])))
  const setupIds = [...new Set([...(templates.find(t => t.name === view.workloadTemplate)?.recipe?.setups ?? []), ...(inventory.installedSetupIds ?? []), ...setupJobs.filter(job => job.status !== 'removed').map(job => job.setup)])]
  const installing = setupJobs.some(job => job.status === 'waiting')
  return {
    ...view,
    setupJobs,
    setupIds,
    agentInventory: installing ? { ...inventory, resources: null } : inventory,
    policy: policyView(config?.policy),
    policySource: config?.policySource ?? null,
    policyHash: config?.policyHash ?? null,
    policyVersionNumber: config?.version ?? null,
  }
}

// ---- writes -----------------------------------------------------------------

export async function createSandbox(input, { sessionOverride = false } = {}) {
  // An image template is an OpenShell sandbox template: the gateway supplies
  // its image and environment; the console adds how the sandbox starts.
  const saved = input.imageTemplate ? await imageTemplateForLaunch(String(input.imageTemplate)) : null
  // After the template check, which can restart the local gateway.
  const { client, target, workspace } = await gateway()
  const imageLabels = imageTemplateLabels(saved)
  // A built template's agents get their sign-in and model destinations from
  // the reviewed table in shared/agent-access.js, never from the recipe.
  let agentRules = []
  if (input.connectors?.length && !saved?.managed) throw fail('Connectors need a template built in OpenRod.')
  if (saved?.managed) { try { agentRules = agentAccessRules(saved.recipe, { connectors: input.connectors ?? [] }) } catch (error) { throw fail(error.message) } }
  if (saved) {
    const start = sessionOverride && input.session !== undefined ? String(input.session) : saved.recipe.command.trim()
    let selectedSession
    try { selectedSession = templateSession(saved, input.session) } catch (error) { throw fail(error.message) }
    input = { ...input, image: '', session: selectedSession, command: start ? ['/bin/bash', '-lc', start] : [] }
  }
  const setupIds = [...new Set([...(saved?.recipe?.setups ?? []), ...(Array.isArray(input.setups) ? input.setups : [])])]
  const setupTargets = input.setupTargets ?? setupTargetsFor(saved?.recipe?.agents ?? [])
  const selectedSetups = await resolveSetups(setupIds)
  assertPackagesPrepared(selectedSetups)
  // A Setup's egress policy reaches sandboxes that use it, or a Quick-setup snapshot of it.
  const setupMembers = [...new Set(selectedSetups.flatMap((s) => [s.id, s.preparedFrom?.id].filter(Boolean)))]
  const approvedSetupRevisions = launchSetupAccess(selectedSetups, saved?.recipe, input.setupAccessReview, input.includeTemplateAccess === true)
  if (setupIds.length) { try { validateSetupTargets(setupTargets) } catch (error) { throw fail(error.message) } }
  if (setupIds.length) input = { ...input, session: 'shell', command: [] }
  const name = String(input.name ?? '').trim()
  const image = String(input.image ?? '').trim()
  const providers = Array.isArray(input.providers) ? input.providers.map(String) : []
  const command = Array.isArray(input.command) ? input.command.map(String).filter(Boolean) : []
  const session = input.session ?? (command.length === 1 && command[0] === 'claude' ? 'claude' : command.length === 0 ? 'shell' : null)
  if (session != null && !isSession(session)) throw fail('Unknown session type.')
  const launch = sessionLaunch(session, command)
  // OpenShell caps sandbox names at 19 characters.
  if (!NAME.test(name) || name.length > 19) throw fail('Use lowercase letters, digits and dashes for the name, up to 19 characters.')
  if (image && !IMAGE.test(image)) throw fail('That image reference is not valid.')
  if (!providers.every((p) => NAME.test(p))) throw fail('Unknown provider name.')
  if (command.length > 32 || command.some((part) => part.length > 512)) throw fail('Command is too long.')
  // A folder or repository to start from is checked before anything is created.
  const seed = await planSeed({ folder: input.folder ? String(input.folder) : null, repository: input.repository ? String(input.repository) : null })
  // Files, Landlock and process identity are fixed at creation, and so is the
  // group label. The whole policy (template + organization + group rules) is
  // resolved here from stored policy, never accepted raw from the browser.
  let labels
  const { plan, ref } = await createInGroups({ name: String(input.name ?? ''), groups: input.groups ?? input.group, template: input.template ? String(input.template) : null, accessTemplates: input.accessTemplates, agentRules, requireGroup: true, setups: setupMembers }, async (plan) => {
    labels = { ...plan.labels, ...launch.labels, ...imageLabels, ...sandboxIdentityLabels(), ...(seed?.project ? { [PROJECT_LABEL]: seed.project } : {}), ...(persistentGateway(target) ? { [PERSISTENT_TERMINAL_LABEL]: '1' } : {}) }
    await enforcePolicyOnly(client)
    const spec = {
      policy: persistentGateway(target) ? persistentTerminalPolicy(plan.policy) : plan.policy,
      labels,
      name,
      providers,
      command: launch.command,
      // Interactive sessions run through exec, independently of the main process.
      tty: launch.tty,
    }
    const created = saved
      ? await client.sandbox.createFromTemplate({ ...spec, workloadTemplate: saved.name, workspace })
      : await client.sandbox.create({ ...spec, workspace, ...(image ? { image } : {}) })
    // Labels are fixed at creation, so Setup membership is bound to the
    // gateway and immutable id returned for this new sandbox.
    await setSandboxSetups({ name: created.name, id: created.id, gateway: target.endpoint }, setupMembers)
    return created
  })
  const template = plan.template

  // Services a template opens at start go through the same path as opening
  // one by hand, so they get the same auto-close deadline.
  const opened = []
  for (const door of template?.ingress ?? []) {
    try { opened.push({ ...door, ...(await expose({ sandbox: ref.name, name: door.name, port: door.port, closeAfterMinutes: door.closeAfterMinutes ?? null })) }) } catch { /* a door that failed to open is simply missing from `opened` */ }
  }
  // Files arrive once the sandbox is ready, as with `sandbox create --upload`.
  // Console sessions start through exec, so an agent opened later finds them.
  if (seed) startSeed(ref.name, seed)
  if (setupIds.length) await startSetupInstall(ref.name, setupIds, setupTargets, ref.id, approvedSetupRevisions, target.endpoint)
  return { name: ref.name, phase: ref.phase, opened, labels, setups: setupIds, seed: seed ? { kind: seed.kind, source: seed.source, dest: seed.dest } : null }
}

async function lifecycle(name, action) {
  const { client, target, workspace, workspaceScope } = await gateway()
  if (action === 'stop') await client.raw.stopSandbox({ name, workspaceScope, requestId: randomUUID() })
  else if (action === 'start') await client.raw.startSandbox({ name, workspaceScope, requestId: randomUUID() })
  else if (action === 'delete') {
    const sandbox = sandboxView((await client.raw.getSandbox({ name, workspaceScope })).sandbox)
    const result = await client.sandbox.delete(name, { workspace })
    // A later sandbox with this name must not inherit its group.
    await assignGroup([name], null, { forget: true })
    try { await forgetSandbox({ ...sandbox, gateway: target.endpoint }) } catch { /* the sandbox is deleted either way */ }
    return result
  }
  return { ok: true }
}

// ---- live stream ------------------------------------------------------------

// One upstream watch per sandbox, shared by every open browser tab. The list
// itself has no watch RPC, so it is re-read on a short timer and on any status
// snapshot from a watched sandbox.
export function createHub(store, { connect = gateway, list = listSandboxes, interval = 5000 } = {}) {
  const clients = new Set(), watches = new Map()
  let timer = null, healthTimer = null, lastList = '', stopped = false, refreshing = false
  const emit = (event, data) => {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    for (const res of clients) { if (res.destroyed) clients.delete(res); else if (!res.write(frame)) { clients.delete(res); res.destroy() } }
  }
  const health = () => { if (!clients.size || healthTimer || stopped) return; healthTimer = setTimeout(() => { healthTimer = null; if (!stopped) emit('collection', store.coverage()) }, 250) }
  const status = (id, patch) => { store.source(id, patch); health() }
  async function refresh() {
    if (refreshing || stopped) return
    refreshing = true
    try {
      const current = await connect()
      const { client, target, workspaceScope } = current
      const sandboxes = await list(current)
      if (stopped) return
      const serialized = JSON.stringify(sandboxes)
      if (serialized !== lastList) { lastList = serialized; emit('sandboxes', sandboxes) }
      const wanted = new Set(live(sandboxes).map((s) => `${target.endpoint}|${s.id || s.name}|${s.createdAt || ''}`))
      for (const old of store.coverage().sources) if (!wanted.has(old.id) && old.status !== 'inactive') store.source(old.id, { status: 'inactive', stoppedAt: new Date().toISOString() })
      for (const [id, controller] of watches) if (!wanted.has(id)) { controller.abort(); watches.delete(id); status(id, { status: 'inactive', stoppedAt: new Date().toISOString() }) }
      for (const sandbox of live(sandboxes)) {
        const id = `${target.endpoint}|${sandbox.id || sandbox.name}|${sandbox.createdAt || ''}`
        if (!watches.has(id)) watch(client, sandbox, id, workspaceScope).catch((error) => emit('gateway-error', { message: `Collection failed: ${error.message}` }))
      }
      emit('gateway-health', { status: 'connected' })
      health()
    } catch (error) { emit('gateway-error', { message: error.message }) }
    finally { refreshing = false }
  }
  async function watch(client, sandbox, id, workspaceScope) {
    const controller = new AbortController()
    watches.set(id, controller)
    const previous = store.getSource(id)
    status(id, { sandbox: sandbox.name, status: 'connecting', connectedAt: null, gapSince: previous?.gapSince || new Date().toISOString(), gapPossible: true })
    let cursor = previous?.cursor || ''
    const save = (line, sourceCursor) => {
      if (stopped) return
      const event = store.ingest({ ...logView(sandbox.name, line), ...(sourceCursor ? { sourceCursor } : {}) }, id)
      if (event) emit('log', event)
      if (event) store.source(id, { lastEventAt: event.at, lastReceivedAt: new Date().toISOString() })
    }
    // Subscribe first with bounded replay. A separate history read confirms source reachability.
    try {
      const stream = client.raw.watchSandbox({ sandbox: sandbox.name, workspaceScope, followStatus: true, followLogs: true, followEvents: true, logTailLines: 400, eventTail: 400, resumeAfterCursor: cursor }, { signal: controller.signal })
      const recovery = (async () => {
        try {
          const logs = await client.raw.getSandboxLogs({ sandbox: sandbox.name, lines: 400, workspaceScope }, { signal: controller.signal })
          if (stopped || controller.signal.aborted) return
          for (const line of logs.logs) save(line)
          status(id, { lastHistoryAt: new Date().toISOString(), historyError: null, replayLines: logs.logs.length, replayMayBeTruncated: logs.logs.length >= 400 })
        } catch (error) { if (!stopped && !controller.signal.aborted) status(id, { historyError: error.message }) }
      })()
      for await (const event of stream) {
        if (stopped || controller.signal.aborted) break
        store.source(id, { status: 'watching', error: null, lastContactAt: new Date().toISOString() })
        const payload = event.payload
        if (payload.case === 'log') save(payload.value, event.cursor)
        else if (payload.case === 'sandbox') refresh()
        else if (payload.case) {
          const original = JSON.parse(JSON.stringify(payload.value, (_, v) => typeof v === 'bigint' ? v.toString() : v))
          const saved = store.ingest({ ...(payload.case === 'warning' ? { id: randomUUID() } : {}), sandbox: sandbox.name, kind: 'event', category: 'EVENT', source: original.source || 'gateway-watch', action: payload.case === 'warning' ? 'STREAM_WARNING' : original.reason || payload.case, severity: original.type || (payload.case === 'warning' ? 'WARN' : null), original, message: original.message || JSON.stringify(original), at: iso(original.eventTime), sourceCursor: event.cursor || null }, id)
          if (payload.case === 'warning') status(id, { gapPossible: true, warning: original.message, gapSince: new Date().toISOString() })
          if (saved) emit('log', saved)
        }
        // Advance only after the corresponding evidence has been persisted.
        if (event.cursor && event.cursor > cursor) { cursor = event.cursor; store.source(id, { cursor }) }
      }
      await recovery
      if (!stopped && !controller.signal.aborted) status(id, { status: 'disconnected', gapSince: new Date().toISOString(), gapPossible: true })
    } catch (error) {
      if (!stopped && !controller.signal.aborted) {
        const code = error.connectCode ?? error.code ?? error.cause?.code
        const invalidCursor = Boolean(cursor) && [3, 11].includes(code)
        status(id, { status: 'disconnected', error: error.message, gapSince: new Date().toISOString(), gapPossible: true, ...(invalidCursor ? { cursor: '', warning: 'Saved cursor is no longer available. Falling back to bounded history replay.' } : {}) })
        const gap = store.ingest({ id: randomUUID(), sandbox: sandbox.name, at: new Date().toISOString(), kind: 'event', category: 'EVENT', action: 'COLLECTION_INTERRUPTED', severity: 'WARN', source: 'console-collector', message: error.message, reason: invalidCursor ? 'Resume cursor rejected; history may be incomplete' : 'Source stream interrupted; resume will be attempted' }, id)
        if (gap) emit('log', gap)
      }
    }
    if (watches.get(id) === controller) watches.delete(id)
  }
  return {
    start() {
      if (timer) return
      stopped = false
      for (const source of store.coverage().sources) store.source(source.id, { status: 'unverified', gapPossible: true })
      refresh(); timer = setInterval(refresh, interval)
    },
    stop() { stopped = true; clearInterval(timer); clearTimeout(healthTimer); timer = null; healthTimer = null; for (const controller of watches.values()) controller.abort(); watches.clear() },
    add(res) { clients.add(res); if (lastList) res.write(`event: sandboxes\ndata: ${lastList}\n\n`); res.write(`event: collection\ndata: ${JSON.stringify(store.coverage())}\n\n`) },
    remove(res) { clients.delete(res) },
    logsDeleted(result) { emit('activity-deleted', result); health() },
    contextChanged() { emit('context-changed', {}); for (const res of clients) res.end(); clients.clear() },
  }
}

// ---- router -----------------------------------------------------------------

export function openshellApi(security = createSecurity(releaseConfig()), token = createLaunchToken()) {
  const configure = (server) => {
    const logger = server.config.logger
    const api = createOpenShellApi({ httpServer: server.httpServer, logger, security, token })
    server.middlewares.use(api.middleware)
    if (security.config.mode !== 'local') return
    const link = () => { const { address, port } = server.httpServer.address(); return tokenUrl(address, port, token) }
    const printUrls = server.printUrls?.bind(server)
    if (printUrls) server.printUrls = () => { printUrls(); logger.info(`  ➜  Console: ${link()}  (open this link)`) }
    else server.httpServer?.once('listening', () => logger.info(`OpenRod console (open this link): ${link()}`))
  }
  return { name: 'openshell-console-api', configureServer: configure, configurePreviewServer: configure }
}

// Both Vite and the installed CLI use this exact HTTP/WebSocket lifecycle.
export function createOpenShellApi({ httpServer, logger = console, security = createSecurity(releaseConfig()), token = createLaunchToken() } = {}) {
  const gate = security.config.mode === 'local' ? createTokenGate(token, {
    onReuse: () => logger.warn('The link OpenRod opened in your browser was used a second time. If that wasn’t you, another program may have opened the console first: stop OpenRod with Ctrl+C and start it again.'),
  }) : null
  const runtimes = new Map(), streams = new Set(), sockets = new Set(), pending = new Set(), responses = new Set()
  const localCloud = security.config.mode === 'local' ? createLocalCloud({ native: createLocalCloudNative({ token }) }) : null
  const cloudOff = security.config.mode === 'local' && !cloudOrigin()
  const initialContext = contextSelection()
  const initialKey = contextKey(initialContext)
  let stopSweeper = null
  let active = null, closed = false, closing
  function runtimeFor(context) {
    return runWithContext(context, () => {
      const key = contextKey()
      if (!runtimes.has(key)) {
        const directory = scopedStateDirectory()
        const store = createActivityStore(path.join(directory, 'activity.sqlite'))
        let delivery
        try { delivery = createActivityDelivery(path.join(directory, 'activity-delivery.sqlite'), store) }
        catch (error) { store.close(); throw error }
        const hub = createHub(store, { connect: () => gateway(context) })
        delivery.start()
        // Reapplying organization policy is opt-in and stays on the startup
        // scope. Merely opening or switching consoles must not rewrite policy.
        const stopOrgSweeper = process.env.OPENSHELL_CONSOLE_SWEEP === '1' && key === initialKey
          ? startOrgSweeper((message) => logger.info(`[org] ${message}`)) : () => {}
        runtimes.set(key, { store, delivery, hub, context, stopOrgSweeper })
      }
      return runtimes.get(key)
    })
  }
  function activate(context) {
    if (closed) return
    stopSweeper ??= startSweeper((message) => logger.info(`[ingress] ${message}`))
    const next = runtimeFor(context)
    if (active !== next) {
      if (active) { active.hub.contextChanged(); active.hub.stop() }
      active = next
      if (httpServer?.listening) runWithContext(next.context, () => next.hub.start())
    }
    // Read-only warm-up; edits wait for a build or launch that needs them.
    void gatewayDocker?.status({ fresh: true }).catch(() => {})
    return next
  }
  const sshHosts = security.config.mode === 'local' ? createSshHostStore() : null
  const remoteConnections = security.config.mode === 'local' ? createRemoteConnections({
    onSelected: activate,
    onDeselected: () => {
      if (active) { active.hub.contextChanged(); active.hub.stop(); active = null }
    },
    logger,
  }) : null
  // The local gateway's VM driver must use the Docker that builds templates.
  const gatewayDocker = security.config.mode === 'local' ? createGatewayDocker({
    target: async () => {
      const local = (await remoteConnections.locationSnapshot()).returnContext
      return local ? listGateways().find((entry) => entry.name === local.gateway) ?? null : null
    },
    client: async (name) => (await gateway({ gateway: name, workspace: 'default' })).client,
    forget: forgetGatewayConnection,
    sandboxes: async (name) => {
      const { client } = await gateway({ gateway: name, workspace: 'default' })
      const all = []
      for (const { name: workspace } of await gatewayWorkspaces(name)) {
        let pageToken = ''
        do {
          const page = await client.raw.listSandboxes({ workspaceScope: workspaceScope(workspace), pageSize: 1000, pageToken })
          all.push(...page.sandboxes.map(sandboxView).map((s) => ({ name: s.name, workspace: s.workspace || workspace, phase: s.phase, image: s.image })))
          pageToken = page.nextPageToken
        } while (pageToken)
      }
      return all
    },
    localEngine: () => localEngine(), docker: runDocker, run: runCli,
    busy: () => remoteConnections.changing() ? 'connection' : savingTemplate() ? 'saving' : null,
    stateFile: path.join(stateDirectory(), 'gateway-docker.json'),
    onJob: (job) => { pending.add(job); job.then(() => pending.delete(job), () => pending.delete(job)) },
    logger,
  }) : null
  setGatewayDocker(gatewayDocker)
  const inventory = createLocationInventory({
    connections: remoteConnections, listSandboxes, listTemplates: listImageTemplates, logger,
    defaultLabel: security.config.mode === 'local' ? 'Local' : 'Cloud',
  })
  let ready = Promise.resolve()
  const start = () => { ready = begin(); return ready }
  const begin = async () => {
    if (closed) return
    if (security.config.mode === 'local' && !contextConfigured()) { await remoteConnections?.autoSelect(); return }
    if (remoteConnections && /^console-ssh-[a-f0-9]{24}$/.test(initialContext.gateway)) {
      const remote = (await remoteConnections.locationSnapshot()).remote
      if (remote?.gateway !== initialContext.gateway || remote.status !== 'connected') return
    }
    if (!closed) activate(initialContext)
  }
  const upgrade = async (req, socket, head) => {
    if (closed) { socket.destroy(); return }
    try {
      if (gate?.upgrade(req, socket)) return
      if (localCloud?.upgrade(req, socket, head)) return
      const pathname = requestPath(req)
      if (!['/api/os/terminal', '/api/os/ssh'].includes(pathname)) return
      const identity = await security.authenticate(req)
      if (socket.destroyed || closed) { socket.destroy(); return }
      if (identity) security.watch(req, socket, identity)
      const locations = remoteConnections ? await inventory.locations() : null
      if (socket.destroyed || closed) { socket.destroy(); return }
      const allowContext = plan => locations
        ? locations.some(location => location.connected && location.context === contextKey(plan))
        : contextKey(plan) === contextKey()
      const handled = pathname === '/api/os/ssh'
        ? cloudSshUpgrade(req, socket, head, security.isAllowed, identity, { allowContext })
        : terminalUpgrade(req, socket, head, security.isAllowed, identity?.uid, allowContext)
      if (handled) {
        sockets.add(socket)
        socket.once('close', () => sockets.delete(socket))
      }
    } catch (error) { socket.end(`HTTP/1.1 ${error.status === 400 ? '400 Bad Request' : '403 Forbidden'}\r\nConnection: close\r\n\r\n`) }
  }
  function close() {
    if (closed) return closing
    closed = true
    localCloud?.close()
    httpServer?.off('listening', start)
    httpServer?.off('upgrade', upgrade)
    httpServer?.off('close', close)
    for (const res of streams) res.end()
    for (const socket of sockets) socket.destroy()
    stopSweeper?.()
    for (const runtime of runtimes.values()) { runtime.hub.stop(); runtime.stopOrgSweeper() }
    const drain = [remoteConnections?.close(), ...pending, ...[...responses].filter((res) => !res.destroyed && !res.writableFinished)
      .map((res) => new Promise((resolve) => res.once('close', resolve)))]
    closing = Promise.allSettled(drain).then(() => {
      for (const runtime of runtimes.values()) { runtime.delivery.stop(); runtime.store.close() }
      streams.clear(); sockets.clear(); runtimes.clear()
    })
    return closing
  }
  httpServer?.on('upgrade', upgrade)
  httpServer?.once('close', close)
  if (httpServer?.listening) start()
  else httpServer?.once('listening', start)
  const route = (req, res, next = () => res.writeHead(404).end()) => {
    let pathname
    try { pathname = requestPath(req) } catch { res.writeHead(400).end(); return }
    if (pathname !== '/api/os' && !pathname.startsWith('/api/os/')) return next()
    if (!security.isAllowed(req)) { res.writeHead(403).end(); return }
    if (closed) { res.writeHead(503).end(); return }
    responses.add(res)
    res.once('close', () => responses.delete(res))
    const operation = runWithContext(contextSelection(), async () => {
        try {
          const url = new URL(req.url, 'http://local')
          const parts = url.pathname.slice('/api/os'.length).split('/').filter(Boolean)
          assertCloudOperation(parts)
          if (cloudOff && ['cloud-export', 'cloud-import', 'cloud-transfer'].includes(parts[0])) return send(res, 409, { error: CLOUD_SOON })
          if (security.config.mode !== 'local' && (parts[0] === 'connections' || parts[0] === 'gateway-docker' || (parts[0] === 'context' && req.method !== 'GET') || (parts[0] === 'sandboxes' && ['ssh', 'ssh-open', 'ssh-config'].includes(parts[2])))) throw fail('Host-local actions are unavailable in OpenRod Cloud.', 403)
          const requestedContext = req.headers['x-openshell-context'] ?? url.searchParams.get('context')
          let owner = contextSelection()
          const explicitLocation = req.headers['x-openshell-location'] === '1' || url.searchParams.get('location') === '1'
          if (explicitLocation && security.config.mode === 'local') owner = await inventory.resolve(requestedContext)
          else if (requestedContext != null && requestedContext !== contextKey() && !(req.method === 'GET' && parts[0] === 'connections')) return send(res, 409, { error: 'Console context changed. Reload before continuing.' })
          return await runWithContext(owner, async () => {
          if (req.method === 'GET' && parts.length === 1 && parts[0] === 'capabilities') return send(res, 200, consoleCapabilities(security.config.mode))
          if (parts.length === 2 && parts[0] === 'announcements' && parts[1] === 'cloud') {
            if (!isMutation(req, security)) return send(res, 403, { error: 'Request rejected' })
            await body(req)
            return send(res, 200, await claimCloudAnnouncement({ user: identityContext.getStore()?.uid ?? 'local', available: !cloudOff }))
          }
          // Connection discovery is available before any gateway is selected.
          // Job reads remain available after that job changes the context.
          if (parts[0] === 'connections') {
            if (req.method === 'GET' && parts.length === 1) {
              const overview = await remoteConnections.overview()
              const saved = new Map((await sshHosts.list()).map(host => [host.alias, host]))
              return send(res, 200, { ...overview, hosts: overview.hosts.map(host => saved.has(host.name) ? { ...host, managed: true, label: saved.get(host.name).name, address: `${saved.get(host.name).user ? saved.get(host.name).user + '@' : ''}${saved.get(host.name).host}${saved.get(host.name).port ? ':' + saved.get(host.name).port : ''}` } : host) })
            }
            if (req.method === 'GET' && parts.length === 3 && parts[1] === 'jobs') return send(res, 200, remoteConnections.job(parts[2]))
            if (req.method === 'POST' && parts.length === 4 && parts[1] === 'jobs' && parts[3] === 'package') {
              if (req.headers.origin !== security.originFor(req) || req.headers['content-type'] !== 'application/octet-stream' || req.headers['x-openshell-console'] !== '1') return send(res, 403, { error: 'Request rejected' })
              return send(res, 200, await remoteConnections.upload(parts[2], req))
            }
            if (!isMutation(req, security)) return send(res, 403, { error: 'Request rejected' })
            const input = await body(req)
            if (parts.length === 2 && parts[1] === 'connect') return send(res, 200, remoteConnections.begin(input))
            if (parts.length === 3 && parts[1] === 'hosts' && parts[2] === 'scan') return send(res, 200, await sshHosts.scan(input))
            if (parts.length === 2 && parts[1] === 'hosts') {
              const saved = await sshHosts.add(input.token)
              await remoteConnections.unforgetHost(saved.alias)
              return send(res, 201, saved)
            }
            if (parts.length === 3 && parts[1] === 'hosts' && parts[2] === 'restore') return send(res, 200, await remoteConnections.restoreHost(input.host))
            if (parts.length === 3 && parts[1] === 'hosts' && parts[2] === 'remove') {
              const current = (await remoteConnections.overview()).active
              if (current?.host === input.alias && ['connected', 'connecting'].includes(current.status)) throw fail('Disconnect from this machine before removing it.', 409)
              const removed = await sshHosts.remove(input.alias)
              await remoteConnections.unforgetHost(removed.alias)
              return send(res, 200, removed)
            }
            if (parts.length === 2 && parts[1] === 'disconnect') return send(res, 200, await remoteConnections.disconnect())
            if (parts.length === 2 && parts[1] === 'forget') {
              const result = await remoteConnections.forget()
              await inventory.forget()
              return send(res, 200, result)
            }
            if (parts.length === 4 && parts[1] === 'jobs' && parts[3] === 'docker') return send(res, 200, remoteConnections.installDocker(parts[2], input.approve))
            if (parts.length === 4 && parts[1] === 'jobs' && parts[3] === 'install') {
              if (input.method !== 'download') throw fail('Choose remote download or upload a runtime package.')
              return send(res, 200, remoteConnections.download(parts[2]))
            }
            return send(res, 404, { error: 'Not found' })
          }
          if (parts[0] === 'gateway-docker') {
            if (!gatewayDocker) return send(res, 404, { error: 'Not found' })
            if (req.method === 'GET' && parts.length === 1) return send(res, 200, await gatewayDocker.status({ fresh: url.searchParams.get('fresh') === '1' }))
            if (req.method !== 'POST' || parts.length !== 2 || !['connect', 'undo'].includes(parts[1])) return send(res, 404, { error: 'Not found' })
            if (!isMutation(req, security)) return send(res, 403, { error: 'Request rejected' })
            const input = await body(req)
            const seen = Array.isArray(input.seen) ? input.seen.slice(0, 500).map(String) : []
            return send(res, 200, await gatewayDocker[parts[1]]({ confirm: input.confirm === true, seen }))
          }
          if (req.method === 'GET' && parts.length === 1) {
            if (parts[0] === 'context') {
              const remote = remoteConnections ? (await remoteConnections.locationSnapshot()).remote : null
              const disconnected = remote?.gateway === contextSelection().gateway && remote.status !== 'connected'
              return send(res, 200, {
                ...await consoleContext({ probe: !disconnected }),
                ...(disconnected ? { workspaceError: remote.error || 'This SSH location is disconnected.' } : {}),
                ...(security.config.mode !== 'local' ? { configured: true } : {}),
              })
            }
          }
          if (req.method === 'GET' && parts.length === 1 && parts[0] === 'inventory') return send(res, 200, await inventory.refresh())
          if (isMutation(req, security)) {
            if (parts[0] === 'local-catalog' && parts.length === 1) {
              if (!remoteConnections) throw fail('Local catalogs are available only through a local SSH console.', 403)
              const snapshot = await remoteConnections.locationSnapshot()
              if (snapshot.remote?.status !== 'connected' || snapshot.remote.gateway !== owner.gateway) throw fail('Connect the SSH destination before loading local settings.', 409)
              const { syncLocalCatalog } = await import('./local-catalog.js')
              const architecture = remoteConnections.architecture()
              if (!architecture) throw fail('Reconnect the SSH destination before loading local settings.', 409)
              return send(res, 200, await syncLocalCatalog(snapshot.returnContext, { architecture: architecture === 'amd64' ? 'x64' : 'arm64' }))
            }
            if (parts[0] === 'context' && parts.length === 1) {
              if (remoteConnections.changing()) throw fail('Wait for the connection operation before changing workspace.', 409)
              const input = await body(req)
              const remote = (await remoteConnections.locationSnapshot()).remote
              if (remote?.gateway === (input.gateway ?? contextSelection().gateway)) await inventory.resolve(contextKey(remote))
              const result = await selectConsoleContext(input)
              await remoteConnections.locationSnapshot()
              activate({ gateway: result.gateway, workspace: result.workspace })
              return send(res, 200, result)
            }
          }
          if (security.config.mode === 'local' && !contextConfigured() && !explicitLocation) return send(res, 428, { error: 'Choose Local or an SSH host and connect before accessing sandboxes.', setupRequired: true })
          if (remoteConnections && !explicitLocation && !['context', 'connections'].includes(parts[0])) {
            const remote = (await remoteConnections.locationSnapshot()).remote
            if (remote?.gateway === contextSelection().gateway) await inventory.resolve(contextKey())
          }
          const { store, delivery, hub } = runtimeFor(contextSelection())
          const importOptions = {
            sourceKind: security.config.mode === 'local' ? undefined : 'cloud',
            activityStore: store,
            onEvent: ({ action, job }) => store.ingest({
              id: randomUUID(), sandbox: '', at: new Date().toISOString(), kind: 'event', category: 'EVENT',
              source: 'openrod-import', action, severity: job.status === 'failed' || job.status === 'partial' ? 'WARN' : 'INFO',
              outcome: job.status === 'completed' ? 'success' : job.status === 'failed' ? 'failure' : undefined,
              actor: identityContext.getStore()?.email ?? 'Local operator', correlationId: job.id,
              message: `${action}: ${job.counts.completed}/${job.counts.total} resources completed`,
              original: { jobId: job.id, source: job.source, destination: job.destination, counts: job.counts },
            }, contextKey()),
          }
          if (req.method === 'GET') {
            if (parts[0] === 'resource-imports') {
              const result = await resourceImportRoute('GET', parts, undefined, importOptions)
              return send(res, result === undefined ? 404 : 200, result ?? { error: 'Not found' })
            }
            if (parts[0] === 'stream') {
              res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' })
              res.write(': connected\n\n')
              const ping = setInterval(() => res.write(': ping\n\n'), 15000)
              streams.add(res)
              hub.add(res)
              res.on('close', () => { clearInterval(ping); streams.delete(res); hub.remove(res) })
              return
            }
            if (parts[0] === 'cloud-export') return send(res, 200, await exportTransfer({ name: url.searchParams.get('name') }))
            if (parts[0] === 'overview') return send(res, 200, await overview())
            if (parts[0] === 'sandboxes' && parts.length === 1) return send(res, 200, await listSandboxes())
            if (parts[0] === 'sandboxes' && parts.length === 2 && NAME.test(parts[1])) return send(res, 200, await sandboxDetail(parts[1]))
            if (parts[0] === 'activity-destinations' && parts.length === 1) return send(res, 200, delivery.list())
            if (parts[0] === 'activity' && (parts.length === 1 || (parts.length === 2 && parts[1] === 'export'))) {
              const only = url.searchParams.get('sandbox')
              if (only && !NAME.test(only)) throw fail('Unknown sandbox.')
              const options = JSON.parse(url.searchParams.get('query') || '{}')
              if (only) options.sandboxes = [only]
              if (parts[1] === 'export') {
                const format = url.searchParams.get('format') || 'json'
                if (!['json', 'ocsf'].includes(format)) throw fail('Unknown export format')
                const first = store.query({ ...options, limit: 500, offset: 0, snapshot: undefined })
                res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': `attachment; filename="openshell-activity${format === 'ocsf' ? '-ocsf' : ''}.json"`, 'Cache-Control': 'no-store' })
                function* chunks() {
                  yield format === 'ocsf' ? '[' : JSON.stringify({ exportedAt: new Date().toISOString(), query: options, coverage: first.coverage, total: first.total }).slice(0, -1) + ',"events":['
                  let page = first, comma = ''
                  while (true) {
                    for (const event of page.events) { yield comma + JSON.stringify(exportEvent(event, format, options.columns)); comma = ',' }
                    if (page.nextOffset === null) break
                    page = store.query({ ...options, limit: 500, snapshot: first.snapshot, offset: page.nextOffset, now: first.now })
                  }
                  yield format === 'ocsf' ? ']' : ']}'
                }
                const stream = Readable.from(chunks())
                stream.on('error', (error) => res.destroy(error))
                res.on('close', () => stream.destroy())
                stream.pipe(res)
                return
              }
              return send(res, 200, store.query(options))
            }
            if (parts[0] === 'downloads' && parts.length === 2) return serveDownload(res, parts[1])
            const routed = (await sshRoute('GET', parts)) ?? (await setupRoute('GET', parts)) ?? (await deploymentRoute('GET', parts)) ?? (await editorRoute('GET', parts)) ?? (await filesRoute('GET', parts, undefined, url)) ?? (await imageTemplateRoute('GET', parts)) ?? (await ingressRoute('GET', parts)) ?? (await orgRoute('GET', parts)) ?? (await policyRoute('GET', parts))
            if (routed !== undefined) return send(res, 200, routed)
            return send(res, 404, { error: 'Not found' })
          }
          // One dropped file per request, streamed to a staging folder.
          if (req.method === 'POST' && parts[0] === 'files' && parts[2] === 'uploads' && parts.length === 4 && NAME.test(parts[1])) {
            if (req.headers.origin !== security.originFor(req) || req.headers['content-type'] !== 'application/octet-stream' || req.headers['x-openshell-console'] !== '1') return send(res, 403, { error: 'Request rejected' })
            return send(res, 200, await receiveUpload(req, parts[1], parts[3], url.searchParams.get('path')))
          }
          if (!isMutation(req, security)) return send(res, 403, { error: 'Request rejected' })
          if (parts[0] === 'cloud-import' && ['worker', 'local'].includes(security.config.mode)) return send(res, 200, await importTransfer(req, { createSandbox: input => createSandbox(input, { sessionOverride: true }) }))
          const input = await body(req, parts[0] === 'resource-imports' ? 8 * 1024 * 1024 : ['image-templates', 'activity'].includes(parts[0]) ? 512 * 1024 : parts[0] === 'setups' ? 128 * 1024 : 65536)
          assertCloudOperation(parts, input)
          if (parts[0] === 'resource-imports') {
            const result = await resourceImportRoute('POST', parts, input, importOptions)
            return send(res, result === undefined ? 404 : 200, result ?? { error: 'Not found' })
          }
          if (parts[0] === 'cloud-transfer' && security.config.mode === 'local') return send(res, 200, await localTransfer(input))
          if (parts[0] === 'activity' && parts.length === 2) {
            if (parts[1] === 'delete-preview') return send(res, 200, store.previewDeletion(input))
            if (parts[1] === 'delete') {
              const result = store.deleteLogs(input.token)
              delivery.logsDeleted()
              hub.logsDeleted(result)
              return send(res, 200, result)
            }
          }
          if (parts[0] === 'activity-destinations') {
            if (parts.length === 1) return send(res, 200, delivery.create(input))
            if (parts.length === 3) return send(res, 200, parts[2] === 'test' ? await delivery.test(parts[1]) : delivery.change(parts[1], parts[2]))
          }
          if (parts[0] === 'sandboxes' && parts.length === 1) return send(res, 200, await createSandbox(input))
          if (parts[0] === 'sandboxes' && parts.length === 3 && NAME.test(parts[1]) && ['stop', 'start', 'delete'].includes(parts[2])) {
            return send(res, 200, await lifecycle(parts[1], parts[2]))
          }
          const routed = (await cloudSshRoute('POST',parts,input)) ?? (await sshRoute('POST', parts, input)) ?? (await setupRoute('POST', parts, input)) ?? (await deploymentRoute('POST', parts, input)) ?? (await editorRoute('POST', parts, input)) ?? (await terminalRoute('POST', parts, input)) ?? (await filesRoute('POST', parts, input)) ?? (await imageTemplateRoute('POST', parts, input)) ?? (await ingressRoute('POST', parts, input)) ?? (await orgRoute('POST', parts, input)) ?? (await policyRoute('POST', parts, input))
          if (routed !== undefined) return send(res, 200, routed)
          return send(res, 404, { error: 'Not found' })
          })
        } catch (error) {
          // Gateway errors carry a readable message; nothing here includes credentials.
          if (res.headersSent) res.destroy(error)
          else send(res, error.status ?? 502, { error: error.rawMessage ?? error.message ?? 'Gateway request failed', ...(error.code === 'TEMPLATE_IN_USE' || error.code === 'GATEWAY_DOCKER_MISMATCH' ? { code: error.code, sandboxes: error.sandboxes, fix: error.fix } : {}) })
        }
      })
    pending.add(operation)
    operation.then(() => pending.delete(operation), () => pending.delete(operation))
    return operation
  }
  const middleware = (req, res, next) => {
    if (closed) { res.writeHead(503).end(); return }
    if (gate?.http(req, res)) return
    const authenticate = () => security.middleware(req, res, () => route(req, res, next))
    return localCloud ? localCloud.middleware(req, res, authenticate) : authenticate()
  }
  return { middleware, close, token, launchCode: gate?.launchCode, ready: () => ready }
}
