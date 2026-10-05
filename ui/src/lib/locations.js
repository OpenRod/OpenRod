import { analytics, classifyAnalyticsError } from './analytics.js'

export const locationLabel = (location) => location?.label ?? (location?.target === 'cloud' ? 'Cloud' : location?.remote ? `SSH · ${location.host ?? location.gateway}` : 'Local')

// Gateway/workspace identity is part of every resource key: names and even ids
// can coincide on independent gateways.
export const resourceKey = (record) => JSON.stringify([[record.location?.target ?? 'local', record.location?.context ?? ''], record.id ?? record.name])

const connectionAttempts = new WeakMap()

// Selecting a local gateway is a job; reload only after it has switched the context.
export async function connectLocalGateway(api, name, interval = 1000) {
  const previous = connectionAttempts.get(api)
  const tracked = analytics.startFlow('gateway_connection', { location_type: 'local' }, previous?.outcome === 'failed' ? previous : null)
  connectionAttempts.set(api, tracked)
  try {
    let job = await api.connect({ localGateway: name })
    while (job.status === 'working') {
      await new Promise((resolve) => setTimeout(resolve, interval))
      job = await api.connectionJob(job.id)
    }
    if (job.status !== 'ready') throw new Error(job.error || `Couldn’t connect to ${name}.`)
    analytics.finishFlow(tracked, 'connected')
    return job
  } catch (error) { analytics.finishFlow(tracked, 'failed', classifyAnalyticsError(error)); throw error }
}
