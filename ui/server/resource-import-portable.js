import { createHash } from 'node:crypto'
import { newRecipe, recipeErrors } from '../src/lib/image-templates.js'
import { validateTemplate } from './policy.js'
import { normalizeMcp } from './setup-discovery.js'
import { validatePolicy } from './egress.js'

export const IMPORT_TYPES = ['policyTemplates', 'groups', 'network', 'setups', 'templates', 'activity']
export const IMPORT_BODY_LIMIT = 8 * 1024 * 1024
export const importFail = (message, status = 400) => Object.assign(new Error(message), { status })
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value
export const fingerprint = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
const sensitive = /(?:-----BEGIN [\w ]*PRIVATE KEY-----|\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})|(?:api[_-]?key|token|password|secret|authorization)["']?\s*[:=]\s*["']?(?!\$|<|\{|YOUR_|your_|example|placeholder|process\.env|os\.environ)[A-Za-z0-9_+/.=-]{16,})/i
const cleanText = (value, length = 400) => {
  if (typeof value !== 'string' || value.length > length || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value) || sensitive.test(value)) throw importFail('Resource contains unsupported text or possible credentials. Remove it before importing.')
  return value
}
const idPatterns = { policyTemplates: /^[a-z0-9][a-z0-9-]{0,47}$/, groups: /^[a-z0-9]([a-z0-9-]{0,46}[a-z0-9])?$/, network: /^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/, setups: /^[a-f0-9]{24}$/, templates: /^[a-z0-9]([a-z0-9-]{0,17}[a-z0-9])?$/, activity: /^history-[a-f0-9]{24}$/ }
export const validImportId = (type, id) => typeof id === 'string' && Boolean(idPatterns[type]?.test(id))

function setupItems(items, warnings) {
  if (!Array.isArray(items) || items.length > 500) throw importFail('Invalid setup items.')
  return items.map((item, index) => {
    const name = cleanText(item.name, 200)
    const id = fingerprint({ kind: item.kind, name, index }).slice(0, 24)
    if (item.kind === 'mcp') {
      const credentialFields = [...new Set([...(item.credentialFields || []), ...Object.keys(item.credentialRef?.aliases || {}), ...Object.keys(item.credentialBindings || {})])].filter(key => /^[A-Za-z_][A-Za-z0-9_]{0,100}$/.test(key))
      const raw = item.package ? { command: 'npx', args: [`${item.package.name}@${item.package.requested || item.package.version || 'latest'}`, ...(item.package.args || [])] } : { ...(item.config || {}) }
      // Environment/header values and source provider references never cross locations.
      if (Object.keys(raw.env || {}).length || Object.keys(raw.headers || {}).length || item.environment) warnings.push(`${name}: environment and HTTP header values are excluded; configure required values on the destination.`)
      delete raw.env; delete raw.headers; delete raw.http_headers
      const normalized = normalizeMcp(name, raw, 'import')
      delete normalized._sourceCredentials
      normalized.credentialFields = [...new Set([...normalized.credentialFields, ...credentialFields])]
      normalized.credentialBindings = Object.fromEntries(Object.entries(item.credentialBindings || {}).filter(([key, binding]) => normalized.credentialFields.includes(key) && /^[A-Za-z0-9_-]{1,80}$/.test(binding?.header || '') && ['', 'Bearer '].includes(binding.prefix || '')).map(([key, binding]) => [key, { header: binding.header, prefix: binding.prefix || '' }]))
      if (normalized.credentialFields.length) {
        normalized.issues = [...new Set([...normalized.issues, `Connect credentials (${normalized.credentialFields.join(', ')}) to use this MCP. They’re kept in the gateway, never in the setup.`])]
        warnings.push(`${name}: reconnect credentials on the destination.`)
      }
      if (item.auth?.mode === 'agent-session') { normalized.auth = { mode: 'agent-session', status: 'sign-in-required' }; warnings.push(`${name}: sign in again on the destination.`) }
      if (normalized.package) warnings.push(`${name}: download and prepare this package on the destination before use.`)
      return { ...normalized, id, ...(item.disabled ? { disabled: true } : {}) }
    }
    if (item.kind !== 'skill') throw importFail('Unsupported setup item.')
    if (!Array.isArray(item.files) || item.files.length > 200) throw importFail('Invalid skill files.')
    const files = [], seen = new Set()
    let bytes = 0
    for (const file of item.files) {
      if (typeof file.path !== 'string' || file.path.length > 200 || !/^[a-zA-Z0-9_ ./@+-]+$/.test(file.path) || file.path.split('/').some(part => !part || part === '.' || part === '..' || part.startsWith('.')) || seen.has(file.path)) throw importFail('Invalid or duplicate skill file path.')
      seen.add(file.path)
      if (file.encoding) { warnings.push(`${name}: binary/archive file ${file.path} is excluded; re-import it on the destination.`); continue }
      const content = cleanText(file.content, 512 * 1024)
      bytes += Buffer.byteLength(content)
      if (bytes > 4 * 1024 * 1024) throw importFail('Skill exceeds the 4 MiB limit.', 413)
      files.push({ path: file.path, content, executable: file.executable === true })
    }
    if (!files.some(file => file.path === 'SKILL.md')) throw importFail('Imported skills require SKILL.md.')
    return { id, kind: 'skill', name, sources: ['import'], files, bytes, digest: fingerprint(files), requirements: [], credentialFields: [], issues: [] }
  })
}

// Both exports and incoming bundles pass through the same allow-list. Never trust
// the browser to preserve redaction or source schemas.
export function portableResource(type, raw) {
  if (!IMPORT_TYPES.includes(type) || !raw || typeof raw !== 'object') throw importFail('Unsupported import resource.')
  const id = raw.id ?? raw.name
  if (!validImportId(type, id)) throw importFail(`Invalid ${type} resource identity.`)
  const warnings = [], dependencies = []
  let data
  if (type === 'policyTemplates') {
    if (raw.accessTemplates?.length) throw importFail('Base policy additions must be materialized before import.')
    const template = validateTemplate(raw)
    const select = (value, keys) => Object.fromEntries(keys.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]))
    const rules = template.rules.map(rule => ({
      name: rule.name, binaries: rule.binaries,
      endpoints: rule.endpoints.map(endpoint => ({
        ...select(endpoint, ['host', 'ports', 'protocol', 'access', 'enforcement', 'tlsSkip', 'allowedIps']),
        ...(endpoint.allow ? { allow: endpoint.allow.map(entry => select(entry, ['method', 'path'])) } : {}),
        ...(endpoint.deny ? { deny: endpoint.deny.map(entry => select(entry, ['method', 'path'])) } : {}),
      })),
    }))
    data = validateTemplate({ ...template, rules, accessTemplates: [] })
    cleanText(JSON.stringify(data), 256 * 1024)
    warnings.push('The source base policy and its access additions are copied into a separate destination policy; existing destination policies are unchanged.')
  } else if (type === 'groups') {
    const template = raw.template ? String(raw.template) : null
    if (template && !validImportId('policyTemplates', template)) throw importFail('Invalid group base policy.')
    if (template) dependencies.push(`policyTemplates:${template}`)
    data = { id, name: cleanText(raw.name || id, 80), description: cleanText(raw.description || ''), template, outside: 'block' }
  } else if (type === 'network') {
    data = validatePolicy(raw)
    if (data.appliesTo.everyone || data.appliesTo.sandboxes.length) throw importFail('Legacy global or sandbox-specific network rules require destination group selection before import.')
    data.name = cleanText(data.name, 80)
    cleanText(JSON.stringify(data), 128 * 1024)
    if (data.advanced?.privateIps.length) warnings.push('This rule includes private addresses. Verify that they refer to the intended cloud services.')
    dependencies.push(...data.appliesTo.groups.map(id => `groups:${id}`), ...data.appliesTo.setups.map(id => `setups:${id}`))
    if (data.setup) dependencies.push(`setups:${data.setup.id}`)
  } else if (type === 'setups') {
    data = { id, name: cleanText(raw.name, 80), items: setupItems(raw.items, warnings) }
  } else if (type === 'activity') {
    if (!Array.isArray(raw.events) || raw.events.length > 500) throw importFail('Activity imports support up to 500 events per batch.')
    const origin = { gateway: cleanText(raw.origin?.gateway || '', 160), workspace: cleanText(raw.origin?.workspace || '', 160) }
    const seen = new Set()
    const fields = ['sandbox', 'sandboxId', 'binary', 'category', 'severity', 'level', 'kind', 'direction', 'verdict', 'outcome', 'action', 'method', 'destination', 'policy', 'sessionId', 'correlationId', 'reason', 'message', 'detail']
    const events = raw.events.map(event => {
      if (!/^[a-f0-9]{64}$/.test(event.id || '') || seen.has(event.id)) throw importFail('Invalid or duplicate activity event identity.')
      if (!Number.isFinite(Date.parse(event.at || event.receivedAt))) throw importFail('Activity events require a valid original timestamp.')
      seen.add(event.id)
      const safe = { id: event.id, at: new Date(Date.parse(event.at || event.receivedAt)).toISOString() }
      if (event.receivedAt && Number.isFinite(Date.parse(event.receivedAt))) safe.receivedAt = new Date(Date.parse(event.receivedAt)).toISOString()
      for (const field of fields) if (typeof event[field] === 'string') {
        const text = event[field].slice(0, field === 'message' || field === 'detail' ? 4096 : 512)
        safe[field] = sensitive.test(text) || /(?:Bearer\s+|[?&](?:token|api[_-]?key|password|secret)=)/i.test(text) ? '[redacted]' : text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
      }
      safe.sandbox ||= 'imported-history'
      return safe
    })
    data = { id, name: cleanText(raw.name, 80), origin, events }
    warnings.push('Normalized event fields are copied with original timestamps and source identity. Raw event payloads are excluded and detected credential values are redacted.')
  } else {
    if (raw.status && raw.status !== 'ready') throw importFail('Wait for this template build to finish before exporting its recipe.')
    const rawRecipe = raw.recipe || raw
    const recipe = newRecipe(Object.fromEntries(Object.keys(newRecipe()).filter(key => key in rawRecipe).map(key => [key, rawRecipe[key]])))
    recipe.name = id
    if (recipe.environment.length) warnings.push('Template environment values are excluded. Re-enter required values on the destination.')
    recipe.environment = []
    recipe.setupRevisions = {}
    if (Object.keys(recipeErrors(recipe)).length) throw importFail(Object.values(recipeErrors(recipe))[0])
    cleanText(JSON.stringify(recipe), 16000)
    if (recipe.source === 'image') {
      if (recipe.image.startsWith('openshell-template/')) throw importFail('A local-only template image cannot be copied. Rebuild from its recipe on the destination.')
      warnings.push('The destination must be able to pull this image; registry credentials are not copied.')
    } else warnings.push('The template will be rebuilt on the destination; build commands may download dependencies.')
    dependencies.push(...recipe.setups.map(id => `setups:${id}`))
    data = { name: id, recipe }
  }
  return { key: `${type}:${id}`, type, id, name: type === 'templates' ? id : data.name, revision: fingerprint(data), data, dependencies: [...new Set(dependencies)], warnings: [...new Set(warnings)], ...(type === 'network' && raw.sourceOrganizationBlock === true && data.action === 'block' ? { requiredForGroups: [...data.appliesTo.groups] } : {}) }
}

export function validateImportBundle(bundle) {
  if (bundle?.version !== 1 || !Array.isArray(bundle.resources) || bundle.resources.length > 500 || Buffer.byteLength(JSON.stringify(bundle)) > IMPORT_BODY_LIMIT) throw importFail('Invalid or oversized configuration bundle.', 400)
  const seen = new Set()
  const resources = bundle.resources.map(resource => {
    const safe = portableResource(resource.type, resource.data)
    if (seen.has(safe.key)) throw importFail('Duplicate import resource.')
    seen.add(safe.key)
    if (resource.requiredForGroups !== undefined) {
      if (safe.type !== 'network' || safe.data.action !== 'block' || !Array.isArray(resource.requiredForGroups) || resource.requiredForGroups.some(id => !safe.data.appliesTo.groups.includes(id))) throw importFail('Invalid required organization restriction.')
      safe.requiredForGroups = [...new Set(resource.requiredForGroups)]
    }
    safe.warnings = [...new Set([...safe.warnings, ...(resource.warnings || []).slice(0, 50).map(warning => cleanText(warning, 500))])]
    return safe
  })
  const context = bundle.source?.context || {}
  return { version: 1, source: { kind: ['local', 'host', 'cloud'].includes(bundle.source?.kind) ? bundle.source.kind : 'host', label: cleanText(bundle.source?.label || 'Source', 160), context: { gateway: cleanText(context.gateway || '', 160), workspace: cleanText(context.workspace || '', 160) } }, resources }
}
