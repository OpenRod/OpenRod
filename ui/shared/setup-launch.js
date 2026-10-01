// Shared presentation/eligibility rules; the server still checks policy and pins.
export function packageRuntimeRequirements(plan) {
  const host = new Map([['shadcn', 'ui.shadcn.com'], ['@magicuidesign/mcp', 'magicui.design']]).get(plan?.name)
  return host ? [{ phase: 'runtime', host, port: 443, reason: 'Package adapter: default component registry. Custom registries require separate review.' }] : []
}
export function canPrepareAtLaunch(item) {
  const retryable = new Set(item.preparationIssues || [])
  return Boolean(!item.disabled && item.package && !item.artifact && !item.credentialFields?.length && item.issues.every(issue => issue.startsWith('Prepare package') || retryable.has(issue)))
}
export function launchableItem(item) {
  return !item.disabled && (!item.issues.length || canPrepareAtLaunch(item))
}
export function launchRequirements(item) {
  const requirements = item.requirements || []
  return [...requirements, ...packageRuntimeRequirements(item.package).filter(r => !requirements.some(old => old.host === r.host && old.phase === r.phase))]
}

export function assertPackagesPrepared(setups) {
  const pending = setups.flatMap(setup => setup.items.filter(canPrepareAtLaunch).map(item => item.name))
  if (pending.length) throw Object.assign(new Error(`MCP packages are not prepared: ${pending.join(', ')}. Retry creation with automatic preparation, or rebuild the selected image template. No sandbox was created.`), { status: 409 })
}
