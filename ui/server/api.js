import { agentInventory } from './agent-inventory.js'
import { randomUUID } from 'node:crypto'
import { IMAGE_TEMPLATE_ID, IMAGE_TEMPLATE_NAME, nameSandboxImages } from '../src/lib/sandbox-images.js'
import { sessionLaunch } from '../src/lib/sandbox-session.js'
import { sandboxIdentityLabels } from './sandbox-identity.js'
import { WORKSPACE, gateway, logView, policyView, providerView, sandboxView } from './gateway.js'
import { policyRoute } from './policy.js'
import { orgRoute, planSandbox, enforcePolicyOnly, startOrgSweeper } from './org.js'
import { expose, ingressRoute, startSweeper } from './ingress.js'
import { imageTemplateRoute, importImageArchive, imageTemplateForLaunch, listImageTemplates } from './image-templates.js'

// These routes act with the operator's gateway certificate. A loopback Host
// header alone is not proof of a local caller when Vite is bound to a LAN
// address, so check the socket, the Host and the browser's own origin claims.
export function isLocalApiRequest(req) {
  const host = req.headers.host ?? ''
  const peer = req.socket?.remoteAddress
  const origin = req.headers.origin
  const site = req.headers['sec-fetch-site']
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(peer)
    && /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host)
    && (origin === undefined || origin === `http://${host}`)
    && (site === undefined || site === 'same-origin' || site === 'none')
}

// A mutation must also carry a JSON body and a custom header, which a
// cross-site form or image tag cannot send without a CORS preflight we never grant.
function isMutation(req) {
  return req.method === 'POST'
    && req.headers.origin === `http://${req.headers.host}`
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
  const [view] = nameSandboxImages([sandboxView(sandbox.sandbox)], await listImageTemplates().catch(() => []))
  return {
    ...view,
    agentInventory: await agentInventory(client, view, target.endpoint),
    policy: policyView(config?.policy),
    policySource: config?.policySource ?? null,
    policyHash: config?.policyHash ?? null,
    policyVersionNumber: config?.version ?? null,
  }
}

async function activity(only) {
  const { client } = await gateway()
  const sandboxes = live(await listSandboxes()).filter((s) => !only || s.name === only)
  const all = await Promise.all(sandboxes.map(async (s) => {
    try {
      const logs = await client.raw.getSandboxLogs({ sandbox: s.name, lines: 400, workspaceScope: WORKSPACE })
      return logs.logs.map((line) => logView(s.name, line))
    } catch { return [] }
  }))
  return all.flat().sort((a, b) => (b.at ?? '').localeCompare(a.at ?? '')).slice(0, 800)
}

// ---- writes -----------------------------------------------------------------

async function createSandbox(input) {
  const { client } = await gateway()
  let imageLabels = {}
  if (input.imageTemplate) {
    const saved = await imageTemplateForLaunch(String(input.imageTemplate))
    imageLabels = { [IMAGE_TEMPLATE_ID]: saved.id, [IMAGE_TEMPLATE_NAME]: saved.recipe.name }
    // A content-addressed image cannot silently drift when a tag is rebuilt.
    input = { ...input, image: saved.inspection.imageId, session: saved.recipe.command?.trim() === 'claude' ? 'claude' : !saved.recipe.command?.trim() ? 'shell' : null, command: saved.recipe.command ? ['/bin/bash', '-lc', saved.recipe.command] : [], environment: Object.fromEntries(saved.recipe.environment.map((e) => [e.name, e.value])) }
  }
  const name = String(input.name ?? '').trim()
  const image = String(input.image ?? '').trim()
  const providers = Array.isArray(input.providers) ? input.providers.map(String) : []
  const command = Array.isArray(input.command) ? input.command.map(String).filter(Boolean) : []
  const session = input.session ?? (command.length === 1 && command[0] === 'claude' ? 'claude' : command.length === 0 ? 'shell' : null)
  if (session != null && !['claude', 'shell'].includes(session)) throw fail('Unknown session type.')
  const launch = sessionLaunch(session, command)
  if (!NAME.test(name)) throw fail('Use lowercase letters, digits and dashes for the name.')
  if (image && !IMAGE.test(image)) throw fail('That image reference is not valid.')
  if (!providers.every((p) => NAME.test(p))) throw fail('Unknown provider name.')
  if (command.length > 32 || command.some((part) => part.length > 512)) throw fail('Command is too long.')
  // Files, Landlock and process identity are fixed at creation, and so is the
  // group label. The whole policy (template + organization + group rules) is
  // resolved here from stored policy, never accepted raw from the browser.
  const plan = await planSandbox({ group: input.group ? String(input.group) : null, template: input.template ? String(input.template) : null })
  const template = plan.template
  const labels = { ...plan.labels, ...launch.labels, ...imageLabels, ...sandboxIdentityLabels() }
  await enforcePolicyOnly(client)
  const ref = await client.sandbox.create({
    policy: plan.policy,
    labels,
    name,
    ...(image ? { image } : {}),
    providers,
    command: launch.command,
    ...(input.imageTemplate ? { environment: input.environment } : {}),
    // Interactive sessions run through exec, independently of the main process.
    tty: launch.tty,
  })
  // Services a template opens at start go through the same path as opening
  // one by hand, so they get the same auto-close deadline.
  const opened = []
  for (const door of template?.ingress ?? []) {
    try { opened.push({ ...door, ...(await expose({ sandbox: ref.name, name: door.name, port: door.port, closeAfterMinutes: door.closeAfterMinutes ?? null })) }) } catch { /* a door that failed to open is simply missing from `opened` */ }
  }
  return { name: ref.name, phase: ref.phase, opened, labels }
}

async function lifecycle(name, action) {
  const { client } = await gateway()
  if (action === 'stop') await client.raw.stopSandbox({ name, workspaceScope: WORKSPACE, requestId: randomUUID() })
  else if (action === 'start') await client.raw.startSandbox({ name, workspaceScope: WORKSPACE, requestId: randomUUID() })
  else if (action === 'delete') return client.sandbox.delete(name)
  return { ok: true }
}

// ---- live stream ------------------------------------------------------------

// One upstream watch per sandbox, shared by every open browser tab. The list
// itself has no watch RPC, so it is re-read on a short timer and on any status
// snapshot from a watched sandbox.
function createHub() {
  const clients = new Set()
  const watches = new Map()
  let timer = null
  let lastList = ''

  const emit = (event, data) => {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    for (const res of clients) res.write(frame)
  }

  async function refresh() {
    let sandboxes
    try { sandboxes = await listSandboxes() } catch (error) { emit('gateway-error', { message: error.message }); return }
    const serialized = JSON.stringify(sandboxes)
    if (serialized !== lastList) { lastList = serialized; emit('sandboxes', sandboxes) }
    const wanted = new Set(live(sandboxes).map((s) => s.name))
    for (const [name, controller] of watches) if (!wanted.has(name)) { controller.abort(); watches.delete(name) }
    for (const name of wanted) if (!watches.has(name)) watch(name)
  }

  async function watch(name) {
    const controller = new AbortController()
    watches.set(name, controller)
    try {
      const { client } = await gateway()
      const stream = client.raw.watchSandbox({
        sandbox: name, workspaceScope: WORKSPACE,
        followStatus: true, followLogs: true, followEvents: true,
        logTailLines: 0, eventTail: 0,
      }, { signal: controller.signal })
      for await (const event of stream) {
        const payload = event.payload
        if (payload.case === 'log') emit('log', logView(name, payload.value))
        else if (payload.case === 'sandbox') refresh()
      }
    } catch { /* Stream ended or sandbox went away; the next refresh decides. */ }
    if (watches.get(name) === controller) watches.delete(name)
  }

  return {
    add(res) {
      clients.add(res)
      if (!timer) { refresh(); timer = setInterval(refresh, 3000) }
      else if (lastList) res.write(`event: sandboxes\ndata: ${lastList}\n\n`)
    },
    remove(res) {
      clients.delete(res)
      if (clients.size) return
      clearInterval(timer); timer = null; lastList = ''
      for (const controller of watches.values()) controller.abort()
      watches.clear()
    },
  }
}

// ---- router -----------------------------------------------------------------

export function openshellApi() {
  const hub = createHub()
  return {
    name: 'openshell-console-api',
    configureServer(server) {
      const stopSweeper = startSweeper((message) => server.config.logger.info(`[ingress] ${message}`))
      const stopOrgSweeper = startOrgSweeper((message) => server.config.logger.info(`[org] ${message}`))
      server.httpServer?.once('close', () => { stopSweeper(); stopOrgSweeper() })
      server.middlewares.use('/api/os', async (req, res) => {
        if (!isLocalApiRequest(req)) { res.writeHead(403).end(); return }
        const url = new URL(req.url, 'http://local')
        const parts = url.pathname.split('/').filter(Boolean)
        try {
          if (req.method === 'GET') {
            if (parts[0] === 'stream') {
              res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' })
              res.write(': connected\n\n')
              const ping = setInterval(() => res.write(': ping\n\n'), 15000)
              hub.add(res)
              req.on('close', () => { clearInterval(ping); hub.remove(res) })
              return
            }
            if (parts[0] === 'overview') return send(res, 200, await overview())
            if (parts[0] === 'sandboxes' && parts.length === 1) return send(res, 200, await listSandboxes())
            if (parts[0] === 'sandboxes' && parts.length === 2 && NAME.test(parts[1])) return send(res, 200, await sandboxDetail(parts[1]))
            if (parts[0] === 'activity') {
              const only = url.searchParams.get('sandbox')
              if (only && !NAME.test(only)) throw fail('Unknown sandbox.')
              return send(res, 200, await activity(only))
            }
            const routed = (await imageTemplateRoute('GET', parts)) ?? (await ingressRoute('GET', parts)) ?? (await orgRoute('GET', parts)) ?? (await policyRoute('GET', parts))
            if (routed !== undefined) return send(res, 200, routed)
            return send(res, 404, { error: 'Not found' })
          }
          if (req.method === 'POST' && parts[0] === 'image-templates' && parts.length === 3 && parts[2] === 'archive') {
            if (req.headers.origin !== `http://${req.headers.host}` || req.headers['content-type'] !== 'application/octet-stream' || req.headers['x-openshell-console'] !== '1') return send(res, 403, { error: 'Request rejected' })
            return send(res, 200, await importImageArchive(req, parts[1]))
          }
          if (!isMutation(req)) return send(res, 403, { error: 'Request rejected' })
          const input = await body(req, parts[0] === 'image-templates' ? 512 * 1024 : 65536)
          if (parts[0] === 'sandboxes' && parts.length === 1) return send(res, 200, await createSandbox(input))
          if (parts[0] === 'sandboxes' && parts.length === 3 && NAME.test(parts[1]) && ['stop', 'start', 'delete'].includes(parts[2])) {
            return send(res, 200, await lifecycle(parts[1], parts[2]))
          }
          const routed = (await imageTemplateRoute('POST', parts, input)) ?? (await ingressRoute('POST', parts, input)) ?? (await orgRoute('POST', parts, input)) ?? (await policyRoute('POST', parts, input))
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
