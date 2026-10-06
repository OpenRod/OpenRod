export const locationLabel = (location) => location?.label ?? (location?.target === 'cloud' ? 'Cloud' : location?.remote ? `SSH · ${location.host ?? location.gateway}` : 'Local')

// Gateway/workspace identity is part of every resource key: names and even ids
// can coincide on independent gateways.
export const resourceKey = (record) => JSON.stringify([[record.location?.target ?? 'local', record.location?.context ?? ''], record.id ?? record.name])

// Selecting a local gateway is a job; continue only after the context switches.
export async function connectLocalGateway(api, name, interval = 1000) {
  let job = await api.connect({ localGateway: name })
  while (job.status === 'working') {
    await new Promise((resolve) => setTimeout(resolve, interval))
    job = await api.connectionJob(job.id)
  }
  if (job.status !== 'ready') throw new Error(job.error || `Couldn’t connect to ${name}.`)
  return job
}
