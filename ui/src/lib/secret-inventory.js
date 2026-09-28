const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
export function indexSecrets(providers, profiles, now = Date.now()) {
  const byType = new Map(profiles.map((profile) => [profile.id, profile]))
  return providers.map((secret) => {
    const profile = byType.get(secret.type)
    const expiry = Object.values(secret.expires ?? {}).map(Date.parse).filter(Number.isFinite).sort((a, b) => a - b)[0] ?? null
    const status = expiry === null ? 'none' : expiry <= now ? 'expired' : expiry <= now + 7 * 86400000 ? 'expiring' : 'scheduled'
    const hosts = (profile?.endpoints ?? []).map((endpoint) => endpoint.host)
    return { secret, profile, expiry, status, service: profile?.name ?? secret.type, hosts,
      search: [secret.name, secret.type, profile?.name, ...secret.credentialKeys, ...secret.attachedTo, ...hosts].join(' ').toLowerCase() }
  })
}
export function filterSecrets(rows, { query, scope, service, expiry, sort }) {
  const q = query.trim().toLowerCase()
  return rows.filter((row) => (!q || row.search.includes(q))
    && (scope === 'all' || (scope === 'attached' ? row.secret.attachedTo.length > 0 : row.secret.attachedTo.length === 0))
    && (!service || row.secret.type === service) && (!expiry || row.status === expiry))
    .sort((a, b) => {
      const value = (row) => ({ name: row.secret.name, service: row.service, credentials: row.secret.credentialKeys.length, attached: row.secret.attachedTo.length, expiry: row.expiry })[sort.key]
      const av = value(a), bv = value(b)
      if (av === null) return bv === null ? collator.compare(a.secret.name, b.secret.name) : 1
      if (bv === null) return -1
      const delta = typeof av === 'number' ? av - bv : collator.compare(av, bv)
      return (sort.direction === 'asc' ? delta : -delta) || collator.compare(a.secret.name, b.secret.name)
    })
}
