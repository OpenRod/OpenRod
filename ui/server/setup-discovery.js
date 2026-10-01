import fs from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { unzipSync } from 'fflate'
import { createHash, randomUUID } from 'node:crypto'
import { parse } from 'smol-toml'
import { packageLaunch, packageRuntimeRequirements } from './setup-packages.js'

export const SOURCES = ['codex', 'claude', 'cursor']
export const hash = (value) => createHash('sha256').update(value).digest('hex')
export const fail = (message, status = 400) => Object.assign(new Error(message), { status })
const MAX_FILE = 512 * 1024
const MAX_BUNDLE = 4 * 1024 * 1024
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,100}$/
const secret = /(?:-----BEGIN [\w ]*PRIVATE KEY-----|\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})|(?:api[_-]?key|token|password|secret|authorization)\s*[:=]\s*["']?(?!\$|<|\{|YOUR_|your_|example|placeholder|process\.env|os\.environ)[A-Za-z0-9_+/.=-]{16,})/i
const textExtensions = new Set(['.md', '.txt', '.json', '.yaml', '.yml', '.toml', '.py', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.sh', '.bash', '.css', '.html', '.csv', '.svg', '.xml'])
const inside = (root, file) => file === root || file.startsWith(root + path.sep)
const safeLabel = (value) => typeof value === 'string' && ID.test(value) ? value : 'Unrecognized item'

async function readBounded(file) {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size > MAX_FILE) throw fail('File is not a regular file or exceeds 512 KB.')
    const data = await handle.readFile()
    if (data.length > MAX_FILE) throw fail('File exceeds 512 KB.')
    return data
  } finally { await handle.close() }
}

// Never return values of env, headers, tokens or arbitrary configuration fields.
export function normalizeMcp(name, raw, source) {
  const item = { kind: 'mcp', name: safeLabel(name), sources: [source], transport: raw?.url ? 'http' : 'stdio', requirements: [], issues: [], credentialFields: [], credentialBindings: {}, config: null }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !ID.test(name)) { item.issues.push('Unsupported configuration or server name.'); return item }
  if (raw.enabled === false || raw.disabled === true) { item.disabled = true; item.issues.push('Disabled in the source harness. Enable it there before importing.') }
  const values = {}, environment = {}, ordinaryHeaders = {}
  for (const [key, value] of Object.entries(raw.env || {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,100}$/.test(key) || typeof value !== 'string') { item.issues.push('Unsupported environment setting.'); continue }
    if (/token|password|secret|api.?key|authorization|credential|session|cookie|bearer/i.test(key) || secret.test(value)) { item.credentialFields.push(key); if (!/^\$\{|^openshell:resolve:env:/.test(value)) values[key] = value }
    else if (/^(?:\/|~\/)|\/Users\/|\/Applications\//.test(value) || /(?:PATH|DIR|HOME|SOCKET|TRUSTED)/i.test(key)) item.issues.push(`Local setting ${key} needs a sandbox path; it was not copied.`)
    else if (value.length <= 2048 && !/[\x00-\x1f]/.test(value)) environment[key] = value
  }
  for (const [key, value] of Object.entries(raw.http_headers || raw.headers || {})) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(key)) { item.issues.push('Unsupported HTTP header.'); continue }
    if (/^(host|connection|content-length|transfer-encoding|proxy-authorization)$/i.test(key)) { item.issues.push('Unsupported transport-control header was not copied.'); continue }
    if (/^(accept|content-type|user-agent|x-api-version|mcp-protocol-version)$/i.test(key) && !secret.test(value) && !/[\r\n\x00]/.test(value) && value.length <= 512) { ordinaryHeaders[key] = value; continue }
    const field = key.replace(/-/g, '_').toUpperCase()
    item.credentialFields.push(field)
    const prefix = /^Bearer /i.test(value) ? 'Bearer ' : ''
    item.credentialBindings[field] = { header: key, prefix }; values[field] = prefix ? value.slice(7) : value
  }
  for (const [header, envName] of Object.entries(raw.env_http_headers || {})) {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(header) || typeof envName !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,100}$/.test(envName)) { item.issues.push('Unsupported credential mapping.'); continue }
    item.credentialFields.push(envName); item.credentialBindings[envName] = { header, prefix: '' }
    // Do not consult the console process environment or shell profiles.
  }
  if (raw.bearer_token_env_var) {
    const key = raw.bearer_token_env_var
    if (typeof key === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,100}$/.test(key)) { item.credentialFields.push(key); item.credentialBindings[key] = { header: 'Authorization', prefix: 'Bearer ' } }
  }
  if (raw.oauth || raw.bearer_token) item.auth = {mode:'agent-session',status:'sign-in-required'}
  item.credentialFields = [...new Set(item.credentialFields)]
  if (item.credentialFields.length) item.issues.push('Connect credentials in the next step. Values are never included in Setup files.')
  if (Object.keys(values).length) item._sourceCredentials = values
  if (raw.cwd || raw.envFile || raw.env_file) item.issues.push('Working directories and environment files need manual packaging. They were not imported.')
  if (raw.url) {
    try {
      const url = new URL(raw.url)
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || secret.test(raw.url) || !url.hostname.includes('.') || /^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(url.hostname)) throw Error()
      item.requirements.push({ phase: 'runtime', host: url.hostname, port: Number(url.port || 443), path: url.pathname, reason: 'MCP endpoint; account sign-in may require additional destinations.' })
      if (raw.type && !['http', 'streamable-http'].includes(raw.type)) item.issues.push('Only Streamable HTTP is supported for remote MCPs.')
      item.config = { url: url.href }
    } catch { item.issues.push('Endpoint needs review: use a public HTTPS URL without embedded credentials. Local and private services require a dedicated connection adapter.') }
  } else {
    const command = typeof raw.command === 'string' ? raw.command : ''
    const args = raw.args ?? []
    const dependency = packageLaunch(command, args)
    if (dependency) {
      item.package = dependency
      item.requirements.push(...packageRuntimeRequirements(dependency))
      item.requirements.push({ phase: 'build', host: 'registry.npmjs.org', port: 443, reason: 'Resolve and install pinned dependencies in an isolated builder; install scripts are disabled.' })
      item.issues.push('Prepare package dependencies in the next step.')
    } else if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,60}$/.test(command) || ['sh','bash','zsh','fish','cmd','powershell','node','python','python3','ruby','perl','npx','npm','uv','uvx','pip','docker','curl','wget'].includes(command)) {
      item.issues.push(command.includes('.app/') ? 'Computer-only integration: this launcher depends on the desktop application. It cannot run inside a Linux sandbox.' : 'Needs a supported Linux package or launcher adapter. Local executables and shell commands are not copied or run on this computer.')
    } else if (!Array.isArray(args) || args.length > 32 || args.some((arg) => typeof arg !== 'string' || !/^[a-zA-Z0-9_.=-]{1,128}$/.test(arg) || /token|password|secret|key|eval|exec/i.test(arg) || secret.test(arg))) item.issues.push('Arguments need manual review; values were not imported.')
    else item.config = { command, args }
  }
  if (item.config?.url && Object.keys(ordinaryHeaders).length) item.config.headers = ordinaryHeaders
  if (item.config && Object.keys(environment).length) item.config.env = environment
  else if (Object.keys(environment).length) item.environment = environment
  return item
}

// Inspect archive contents in memory; never extract or execute imported files.
// Keep the original bytes so scripts referencing the ZIP still work.
function inspectSkillZip(content, archivePath) {
  let expandedBytes = 0, entries = 0
  const names = new Set()
  let unpacked
  try {
    unpacked = unzipSync(content, { filter: ({ name, originalSize }) => {
      if (++entries > 200) throw fail(`ZIP ${archivePath} exceeds the 200 entry limit.`)
      const parts = name.replace(/\/$/, '').split('/')
      if (!name || name.startsWith('/') || name.includes('\\') || parts.some(p => !p || p === '..' || p === '.') || !/^[a-zA-Z0-9_ ./@+-]+$/.test(name) || name.length > 200 || names.has(name)) throw fail(`ZIP ${archivePath} contains an unsafe or duplicate path.`)
      names.add(name)
      expandedBytes += originalSize
      if (originalSize > MAX_FILE || expandedBytes > MAX_BUNDLE) throw fail(`ZIP ${archivePath} exceeds the 512 KB per file / 4 MB expanded limit.`)
      return true
    } })
  } catch (error) {
    if (error.status) throw error
    throw fail(`ZIP ${archivePath} could not be read. Use an unencrypted, valid ZIP.`)
  }
  const archiveEntries = []
  for (const [name, data] of Object.entries(unpacked)) {
    if (name.endsWith('/')) continue
    // Finder resource forks are packaging metadata, not skill source files.
    if (name.startsWith('__MACOSX/')) continue
    if (!textExtensions.has(path.extname(name).toLowerCase())) throw fail(`ZIP ${archivePath} contains an unsupported file: ${name}.`)
    const buffer = Buffer.from(data), text = buffer.toString('utf8')
    if (!buffer.equals(Buffer.from(text)) || buffer.includes(0) || secret.test(text)) throw fail(`Potential credentials or binary content in ZIP ${archivePath}. Nothing from this skill was imported.`)
    archiveEntries.push({ path: name, bytes: data.length })
  }
  return { archiveEntries, expandedBytes, entries }
}

export async function readSkill(root, home = os.homedir()) {
  const resolved = await fs.realpath(root)
  if (resolved !== root || !inside(await fs.realpath(home), resolved)) throw fail('Skill location changed. Discover it again.')
  const files = []; let bytes = 0, inspectedEntries = 0
  async function visit(dir, prefix = '') {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    if (entries.length > 200) throw fail('Skill has too many files.')
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.') || ['node_modules', '__pycache__'].includes(entry.name)) continue
      const relative = prefix + entry.name
      if (!/^[a-zA-Z0-9_ ./@+-]+$/.test(relative) || relative.length > 200) throw fail('Skill has an unsupported filename.')
      const file = path.join(dir, entry.name)
      const stat = await fs.lstat(file)
      if (stat.isSymbolicLink() || !inside(resolved, await fs.realpath(file))) throw fail('Skill contains a link outside its reviewed bundle. Links are not copied.')
      if (stat.isDirectory()) { if (prefix.split('/').length > 8) throw fail('Skill is nested too deeply.'); await visit(file, relative + '/'); continue }
      const isZip = path.extname(entry.name).toLowerCase() === '.zip'
      if (!isZip && !textExtensions.has(path.extname(entry.name).toLowerCase())) throw fail(`Unsupported skill file: ${relative}.`)
      const content = await readBounded(file)
      bytes += content.length
      if (bytes > MAX_BUNDLE || ++inspectedEntries > 200) throw fail('Skill exceeds the 4 MB / 200 file limit.')
      if (isZip) {
        const { archiveEntries, expandedBytes, entries } = inspectSkillZip(content, relative)
        bytes += expandedBytes; inspectedEntries += entries
        if (bytes > MAX_BUNDLE || inspectedEntries > 200) throw fail('Skill exceeds the 4 MB / 200 file limit including ZIP contents.')
        files.push({ path: relative, content: content.toString('base64'), encoding: 'base64', archiveEntries, executable: false })
        continue
      }
      const text = content.toString('utf8')
      if (!content.equals(Buffer.from(text)) || content.includes(0) || secret.test(text)) throw fail('Potential credentials or binary content found. Nothing from this skill was imported.')
      files.push({ path: relative, content: text, executable: Boolean(stat.mode & 0o111) })
    }
  }
  await visit(resolved)
  if (!files.some((f) => f.path === 'SKILL.md')) throw fail('SKILL.md is missing.')
  return { files, bytes, digest: hash(JSON.stringify(files)) }
}

// Discovery is opt-in and restricted to standard user-owned locations. No
// project recursion, plugin code, shell profiles, credentials stores or network.
export async function discover({ sources, home = os.homedir() }) {
  if (!Array.isArray(sources) || !sources.length || sources.some((s) => !SOURCES.includes(s))) throw fail('Select Codex, Claude Code or Cursor.')
  const items = [], warnings = [], seen = new Map()
  const configPaths = { codex: '.codex/config.toml', claude: '.claude.json', cursor: '.cursor/mcp.json' }
  for (const source of [...new Set(sources)]) {
    try {
      const file = path.join(home, configPaths[source])
      const resolved = await fs.realpath(file)
      if (!inside(await fs.realpath(home), resolved)) throw fail('Configuration links outside the home directory are not read.')
      const raw = await readBounded(resolved)
      const data = source === 'codex' ? parse(raw.toString()) : JSON.parse(raw)
      const entries = Object.entries(data[source === 'codex' ? 'mcp_servers' : 'mcpServers'] ?? {})
      if (entries.length > 200) throw fail('More than 200 MCP configurations; narrow the source first.')
      for (const [name, cfg] of entries) {
        const item = normalizeMcp(name, cfg, source)
        const digest = hash(JSON.stringify({ name: item.name, config: item.config, issues: item.issues, credentialFields: item.credentialFields, package: item.package, account: item.credentialFields.length ? source : undefined }))
        const existing = seen.get('mcp:' + digest)
        if (existing) { existing.sources.push(source); continue }
        const record = { ...item, id: randomUUID(), digest }
        seen.set('mcp:' + digest, record); items.push(record)
      }
    } catch (error) { warnings.push(`${source}: ${error.code === 'ENOENT' ? 'No user MCP configuration found.' : 'Configuration could not be safely parsed. No contents were returned.'}`) }
    const roots = [path.join(home, source === 'claude' ? '.claude/skills' : `.${source}/skills`), ...(source === 'codex' ? [path.join(home, '.agents/skills')] : [])]
    for (const root of roots) {
      const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => [])
      for (const entry of entries.slice(0, 500)) {
        if (entry.name.startsWith('.') || !ID.test(entry.name)) continue
        const dir = path.join(root, entry.name)
        let resolved
        try { resolved = await fs.realpath(dir); if (!inside(await fs.realpath(home), resolved)) continue; if (!(await fs.stat(path.join(resolved, 'SKILL.md'))).isFile()) continue } catch { continue }
        const key = 'skill:' + resolved
        if (seen.has(key)) { const item = seen.get(key); if (!item.sources.includes(source)) item.sources.push(source); continue }
        // Metadata only until selected for review. Do not read every script in
        // hundreds of skills just to render the selection list.
        const record = { id: randomUUID(), kind: 'skill', name: entry.name, sources: [source], root: resolved, issues: [], requirements: [], credentialFields: [] }
        seen.set(key, record); items.push(record)
      }
    }
  }
  return { items, warnings: [...warnings, 'User-level configuration only. Project and plugin-managed items are not included. Skill files are read only when selected for review.'] }
}

export function publicItem(item) {
  const { root, config, files, _sourceCredentials, ...rest } = item
  return { ...rest, sourceCredentialFields: item.sourceCredentialFields || Object.keys(_sourceCredentials || {}), ...(config ? { configuration: config.url ? { endpoint: config.url } : { command: config.command, args: config.args } } : {}), ...(files ? { files: files.map(({ path, content, encoding, archiveEntries }) => ({ path, bytes: Buffer.byteLength(content, encoding === 'base64' ? 'base64' : 'utf8'), ...(encoding ? { encoding, archiveEntries } : {}) })) } : {}) }
}
