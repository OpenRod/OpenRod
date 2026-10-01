import {createLocalCloudNative} from './local-cloud-native.js'
import {cloudSshRoute,cloudSshUpgrade} from './cloud-ssh.js'
import {createLocalCloud} from './local-cloud.js'
import { setupTargetsFor, validateSetupTargets } from '../shared/setup-targets.js'
import { localTransfer, importTransfer, exportTransfer } from './cloud-transfer.js'
import path from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { createActivityStore } from './activity-store.js'
import { createActivityDelivery } from './activity-delivery.js'
import { exportEvent } from '../src/lib/activity-export.js'
import { agentInventory } from './agent-inventory.js'
import { randomUUID } from 'node:crypto'
import { IMAGE_TEMPLATE_NAME, nameSandboxImages } from '../src/lib/sandbox-images.js'
import { PROJECT_LABEL, templateSession, isSession, sessionLaunch } from '../src/lib/sandbox-session.js'
import { sandboxIdentityLabels } from './sandbox-identity.js'
import { WORKSPACE, gateway, iso, logView, policyView, providerView, sandboxView } from './gateway.js'
import { policyRoute } from './policy.js'
import { GROUP_LABEL, orgRoute, planSandbox, enforcePolicyOnly, startOrgSweeper, assignGroup } from './org.js'
import { expose, ingressRoute, startSweeper } from './ingress.js'
import { imageTemplateRoute, imageTemplateForLaunch, listImageTemplates } from './image-templates.js'
import { editorRoute } from './editor.js'
import { terminalRoute, terminalUpgrade } from './terminal.js'
import { assertPackagesPrepared } from '../shared/setup-launch.js'
import { setupRoute, resolveSetups } from './setups.js'
import { deploymentRoute, startSetupInstall, launchSetupAccess, setupJobsForSandbox } from './setup-deployment.js'
import { sshRoute } from './ssh.js'
import { agentAccessRules } from '../shared/agent-access.js'
import { filesRoute, planSeed, receiveUpload, serveDownload, startSeed } from './files.js'

// These routes act with the operator's gateway certificate. A loopback Host
// header alone is not proof of a local caller when Vite is bound to a LAN
// address, so check the socket, the Host and the browser's own origin claims.
export { isLocalApiRequest } from './security.js'
import { createSecurity, cloudConfig, assertCloudOperation, requestPath } from './security.js'

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

async function body(req, limit = 65536) {
  let raw = ''
  for await (const chunk of req) {
    raw += chunk
    if (Buffer.byteLength(raw) > limit) throw Object.assign(new Error('Request too large'), { status: 413 })
  }
  return raw ? JSON.parse(raw) : {}
}

function send(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(payload))
}

const fail = (message, status = 400) => Object.assign(new Error(message), { status })

// ---- reads ------------------------------------------------------------------

async function listSandboxes() {
  const { client } = await gateway()
  const response = await client.raw.listSandboxes({ workspaceScope: WORKSPACE })
  return nameSandboxImages(response.sandboxes.map(sandboxView), await listImageTemplates().catch(() => [])).sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))
}

// Deleted sandboxes have no draft or log buffer worth asking for.
const live = (sandboxes) => sandboxes.filter((s) => s.phase !== 'deleting')

async function overview() {
  const { client, target } = await gateway()
  const [health, info, providers, sandboxes] = await Promise.all([
    client.health(),
    client.raw.getGatewayInfo({}),
    client.raw.listProviders({ workspaceScope: WORKSPACE }),
    listSandboxes(),
  ])
  return {
    gateway: {
      name: target.name,
      endpoint: target.endpoint,
      authMode: target.authMode,
      remote: target.remote,
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
  const { client, target } = await gateway()
  const [sandbox, config] = await Promise.all([
    client.raw.getSandbox({ name, workspaceScope: WORKSPACE }),
    client.sandbox.getConfig(name).catch(() => null),
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
  const { client } = await gateway()
  // An image template is an OpenShell sandbox template: the gateway supplies
  // its image and environment; the console adds how the sandbox starts.
  const saved = input.imageTemplate ? await imageTemplateForLaunch(String(input.imageTemplate)) : null
  const imageLabels = saved ? { [IMAGE_TEMPLATE_NAME]: saved.name } : {}
  // A built template's agents get their sign-in and model destinations from
  // the reviewed table in shared/agent-access.js, never from the recipe.
  let agentRules = []
  if (saved?.managed) { try { agentRules = agentAccessRules(saved.recipe) } catch (error) { throw fail(error.message) } }
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
  // Files, Landlock and process identity are fixed at creation, and so is the
  // group label. The whole policy (template + organization + group rules) is
  // resolved here from stored policy, never accepted raw from the browser.
  const plan = await planSandbox({ name: String(input.name ?? ''), group: input.group ? String(input.group) : null, template: input.template ? String(input.template) : null, agentRules })
  // A folder or repository to start from is checked before anything is created.
  const seed = await planSeed({ folder: input.folder ? String(input.folder) : null, repository: input.repository ? String(input.repository) : null })
  const template = plan.template
  const labels = { ...plan.labels, ...launch.labels, ...imageLabels, ...sandboxIdentityLabels(), ...(seed?.project ? { [PROJECT_LABEL]: seed.project } : {}) }
  await enforcePolicyOnly(client)
  const spec = {
    policy: plan.policy,
    labels,
    name,
    providers,
    command: launch.command,
    // Interactive sessions run through exec, independently of the main process.
    tty: launch.tty,
  }
  const ref = saved
    ? await client.sandbox.createFromTemplate({ ...spec, workloadTemplate: saved.name })
    : await client.sandbox.create({ ...spec, ...(image ? { image } : {}) })
  // A new sandbox starts in the group it was created in, even if an older
  // sandbox of the same name was moved elsewhere.
  const group = plan.labels[GROUP_LABEL] ?? null
  await assignGroup([ref.name], group, { forget: !group })
  // Services a template opens at start go through the same path as opening
  // one by hand, so they get the same auto-close deadline.
  const opened = []
  for (const door of template?.ingress ?? []) {
    try { opened.push({ ...door, ...(await expose({ sandbox: ref.name, name: door.name, port: door.port, closeAfterMinutes: door.closeAfterMinutes ?? null })) }) } catch { /* a door that failed to open is simply missing from `opened` */ }
  }
  // Files arrive once the sandbox is ready, as with `sandbox create --upload`.
  // Console sessions start through exec, so an agent opened later finds them.
  if (seed) startSeed(ref.name, seed)
  if (setupIds.length) await startSetupInstall(ref.name, setupIds, setupTargets, ref.id, approvedSetupRevisions)
  return { name: ref.name, phase: ref.phase, opened, labels, setups: setupIds, seed: seed ? { kind: seed.kind, source: seed.source, dest: seed.dest } : null }
}

async function lifecycle(name, action) {
  const { client } = await gateway()
  if (action === 'stop') await client.raw.stopSandbox({ name, workspaceScope: WORKSPACE, requestId: randomUUID() })
  else if (action === 'start') await client.raw.startSandbox({ name, workspaceScope: WORKSPACE, requestId: randomUUID() })
  else if (action === 'delete') {
    const result = await client.sandbox.delete(name)
    // A later sandbox with this name must not inherit its group.
    await assignGroup([name], null, { forget: true })
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
      const { client, target } = await connect()
      const sandboxes = await list()
      if (stopped) return
      const serialized = JSON.stringify(sandboxes)
      if (serialized !== lastList) { lastList = serialized; emit('sandboxes', sandboxes) }
      const wanted = new Set(live(sandboxes).map((s) => `${target.endpoint}|${s.id || s.name}|${s.createdAt || ''}`))
      for (const old of store.coverage().sources) if (!wanted.has(old.id) && old.status !== 'inactive') store.source(old.id, { status: 'inactive', stoppedAt: new Date().toISOString() })
      for (const [id, controller] of watches) if (!wanted.has(id)) { controller.abort(); watches.delete(id); status(id, { status: 'inactive', stoppedAt: new Date().toISOString() }) }
      for (const sandbox of live(sandboxes)) {
        const id = `${target.endpoint}|${sandbox.id || sandbox.name}|${sandbox.createdAt || ''}`
        if (!watches.has(id)) watch(client, sandbox, id).catch((error) => emit('gateway-error', { message: `Collection failed: ${error.message}` }))
      }
      emit('gateway-health', { status: 'connected' })
      health()
    } catch (error) { emit('gateway-error', { message: error.message }) }
    finally { refreshing = false }
  }
  async function watch(client, sandbox, id) {
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
      const stream = client.raw.watchSandbox({ sandbox: sandbox.name, workspaceScope: WORKSPACE, followStatus: true, followLogs: true, followEvents: true, logTailLines: 400, eventTail: 400, resumeAfterCursor: cursor }, { signal: controller.signal })
      const recovery = (async () => {
        try {
          const logs = await client.raw.getSandboxLogs({ sandbox: sandbox.name, lines: 400, workspaceScope: WORKSPACE }, { signal: controller.signal })
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
      for (const source of store.coverage().sources) store.source(source.id, { status: 'unverified', gapPossible: true })
      refresh(); timer = setInterval(refresh, interval)
    },
    stop() { stopped = true; clearInterval(timer); clearTimeout(healthTimer); for (const controller of watches.values()) controller.abort(); watches.clear() },
    add(res) { clients.add(res); if (lastList) res.write(`event: sandboxes\ndata: ${lastList}\n\n`); res.write(`event: collection\ndata: ${JSON.stringify(store.coverage())}\n\n`) },
    remove(res) { clients.delete(res) },
    logsDeleted(result) { emit('activity-deleted', result); health() },
  }
}

// ---- router -----------------------------------------------------------------

export function openshellApi(security = createSecurity(cloudConfig())) {
  return {
    name: 'openshell-console-api',
    configureServer(server) {
      if(security.config.mode==='local'){
        const localCloud=createLocalCloud({native:createLocalCloudNative()})
        server.middlewares.use(localCloud.middleware)
        server.httpServer?.on('upgrade',(req,socket,head)=>localCloud.upgrade(req,socket,head))
        server.httpServer?.once('close',localCloud.close)
      }
      server.middlewares.use(security.middleware)
      const store = createActivityStore(path.join(path.dirname(fileURLToPath(import.meta.url)), '../.state/activity.sqlite'))
      const delivery = createActivityDelivery(path.join(path.dirname(fileURLToPath(import.meta.url)), '../.state/activity-delivery.sqlite'), store)
      delivery.start()
      const hub = createHub(store)
      if (server.httpServer?.listening) hub.start()
      else server.httpServer?.once('listening', () => hub.start())
      server.httpServer?.once('close', () => { hub.stop(); delivery.stop(); store.close() })
      const stopSweeper = startSweeper((message) => server.config.logger.info(`[ingress] ${message}`))
      // Several consoles can share one gateway during development. Each one's
      // organization pass re-applies its own stored policy to every sandbox, so
      // only one of them may run it. Ingress deadlines are per console and stay on.
      const stopOrgSweeper = process.env.OPENSHELL_CONSOLE_SWEEP === '0' ? () => {} : startOrgSweeper((message) => server.config.logger.info(`[org] ${message}`))
      server.httpServer?.once('close', () => { stopSweeper(); stopOrgSweeper() })
      // Browser terminals arrive as WebSocket upgrades, which skip the middleware.
      server.httpServer?.on('upgrade', async (req, socket, head) => {
        try {
          if (!['/api/os/terminal','/api/os/ssh'].includes(requestPath(req))) return
          const identity = await security.authenticate(req)
          if (socket.destroyed) return
          if (identity) security.watch(req, socket, identity)
          if(requestPath(req)==='/api/os/ssh')cloudSshUpgrade(req,socket,head,security.isAllowed,identity)
          else terminalUpgrade(req, socket, head, security.isAllowed, identity?.uid)
        } catch (error) { socket.end(`HTTP/1.1 ${error.status === 400 ? '400 Bad Request' : '403 Forbidden'}\r\nConnection: close\r\n\r\n`) }
      })
      server.middlewares.use('/api/os', async (req, res) => {
        if (!security.isAllowed(req)) { res.writeHead(403).end(); return }
        const url = new URL(req.url, 'http://local')
        const parts = url.pathname.split('/').filter(Boolean)
        try {
          assertCloudOperation(parts)
          if (req.method === 'GET') {
            if (parts[0] === 'stream') {
              res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' })
              res.write(': connected\n\n')
              const ping = setInterval(() => res.write(': ping\n\n'), 15000)
              hub.add(res)
              req.on('close', () => { clearInterval(ping); hub.remove(res) })
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
          const input = await body(req, ['image-templates', 'activity'].includes(parts[0]) ? 512 * 1024 : parts[0] === 'setups' ? 128 * 1024 : 65536)
          assertCloudOperation(parts, input)
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
        } catch (error) {
          // Gateway errors carry a readable message; nothing here includes credentials.
          send(res, error.status ?? 502, { error: error.rawMessage ?? error.message ?? 'Gateway request failed' })
        }
      })
    },
  }
}
