// Opening a specific connection must never redirect the user to another host.
export function connectionHost(connections, initialHost, chosenHost) {
  const pending = connections.job && ['working', 'needs-install', 'needs-docker'].includes(connections.job.status) ? connections.job : null
  const host = chosenHost ?? initialHost ?? pending?.host ?? connections.active?.host ?? connections.hosts[0]?.name ?? ''
  return { host, job: pending?.host === host ? pending : null }
}
