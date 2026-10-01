export const locationLabel = (location) => location?.label ?? (location?.remote ? `SSH · ${location.host ?? location.gateway}` : 'Local')

// Gateway/workspace identity is part of every resource key: names and even ids
// can coincide on independent gateways.
export const resourceKey = (record) => JSON.stringify([record.location?.context ?? '', record.id ?? record.name])
