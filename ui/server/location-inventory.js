import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { contextKey, defaultContextSelection, runWithContext } from './gateway.js'
import { stateDirectory } from './paths.js'

const fail = message => Object.assign(new Error(message), { status: 409 })
const locationOf = (context, remote = false, host = null, connected = true, error = null) => ({
  id: contextKey(context), context: contextKey(context), gateway: context.gateway, workspace: context.workspace,
  label: remote ? `SSH · ${host}` : 'Local', remote, ...(remote && host ? { host } : {}), connected, ...(error ? { error } : {}),
})

export function createLocationInventory({ connections, listSandboxes, listTemplates, logger = console, directory = stateDirectory(), defaultLabel = 'Local' }) {
  const file = path.join(directory, 'remote-gateways', 'last-inventory.json')
  let cached = null, ready = null, writes = Promise.resolve(), refreshing = null
  const availability = new Map()
  const load = () => ready ??= (async () => {
    if (!connections) return
    try {
      const value = JSON.parse(await fs.readFile(file, 'utf8'))
      if (value.location?.remote && typeof value.location.context === 'string' && Array.isArray(value.sandboxes) && Array.isArray(value.templates)) cached = value
    } catch (error) { if (error.code !== 'ENOENT') logger.warn(`Remote inventory cache unavailable: ${error.message}`) }
  })()
  const save = value => {
    const data = JSON.stringify(value)
    writes = writes.catch(() => {}).then(async () => {
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
      const temporary = `${file}.${randomUUID()}.tmp`
      await fs.writeFile(temporary, data, { mode: 0o600 })
      await fs.rename(temporary, file)
    })
    return writes.catch(error => logger.warn(`Remote inventory cache could not be saved: ${error.message}`))
  }
  async function locations(includeAvailability = true) {
    if (!connections) return [{ ...locationOf(defaultContextSelection()), label: defaultLabel }]
    const { returnContext, remote } = await connections.locationSnapshot()
    return [
      ...(returnContext && returnContext.gateway !== 'aws-eks' ? [locationOf(returnContext)] : []),
      ...(remote ? [locationOf(remote, true, remote.host,
        remote.status === 'connected' && (!includeAvailability || availability.get(contextKey(remote))?.connected !== false),
        remote.error || (includeAvailability ? availability.get(contextKey(remote))?.error : null))] : []),
    ]
  }
  async function resolve(context) {
    const owner = (await locations()).find(location => location.context === context)
    if (!owner) throw fail('This location is no longer available. Refresh before continuing.')
    if (!owner.connected) throw fail('This SSH location is disconnected. Reconnect before continuing.')
    return { gateway: owner.gateway, workspace: owner.workspace }
  }
  async function collect() {
    await load()
    const sources = await locations(false)
    const inventories = await Promise.all(sources.map(async location => {
      const previous = location.remote && cached?.location.context === location.context ? cached : null
      if (!location.connected) return { location, sandboxes: previous?.sandboxes ?? [], templates: previous?.templates ?? [] }
      const result = await runWithContext(location, () => Promise.allSettled([listSandboxes(), listTemplates()]))
      const errors = result.filter(item => item.status === 'rejected').map(item => item.reason.rawMessage ?? item.reason.message ?? 'Inventory request failed')
      const entry = {
        location: { ...location, ...(errors.length ? { error: [...new Set(errors)].join('; ') } : {}) },
        sandboxes: result[0].status === 'fulfilled' ? result[0].value : previous?.sandboxes ?? [],
        templates: result[1].status === 'fulfilled' ? result[1].value : previous?.templates ?? [],
      }
      // A disconnect can race a response. Keep the rows, but never advertise
      // the stopped gateway as usable or let a response replace a newer host.
      if (location.remote) {
        const current = (await locations(false)).find(item => item.context === location.context)
        const connected = Boolean(current?.connected) && errors.length === 0
        entry.location = { ...entry.location, connected, ...(current?.error ? { error: current.error } : {}) }
        availability.set(location.context, { connected, error: entry.location.error ?? null })
        if (current && result.some(item => item.status === 'fulfilled')) {
          cached = entry
          await save(entry)
        }
      }
      return entry
    }))
    return {
      locations: inventories.map(entry => entry.location),
      sandboxes: inventories.flatMap(entry => entry.sandboxes.map(record => ({ ...record, location: entry.location }))),
      templates: inventories.flatMap(entry => entry.templates.map(record => ({ ...record, location: entry.location }))),
    }
  }
  return {
    locations, resolve,
    // Drops the cached remote reading so a forgotten host leaves nothing behind.
    async forget() {
      await load()
      cached = null
      await writes.catch(() => {})
      await fs.rm(file, { force: true })
    },
    refresh: () => refreshing ??= collect().finally(() => { refreshing = null }),
  }
}
