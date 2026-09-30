import fs from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import { parse } from 'smol-toml'

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
  const item = { kind: 'mcp', name: safeLabel(name), sources: [source], transport: raw?.url ? 'http' : 'stdio', requirements: [], issues: [], credentialFields: [], config: null }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !ID.test(name)) { item.issues.push('Unsupported configuration or server name.'); return item }
  if (raw.enabled === false || raw.disabled === true) item.issues.push('Disabled in the source harness.')
  for (const field of ['env', 'headers', 'http_headers', 'env_http_headers']) {
    if (raw[field] && typeof raw[field] === 'object') item.credentialFields.push(...Object.keys(raw[field]).map(safeLabel))
  }
  if (Object.keys(raw).some((key) => /auth|token|password|secret/i.test(key)) || ['env', 'headers', 'http_headers', 'env_http_headers'].some((key) => raw[key] && typeof raw[key] !== 'object')) item.credentialFields.push('Authentication')
  if (item.credentialFields.length) item.issues.push('Environment or authentication values were excluded. Reconnect credentials before enabling this item.')
  if (raw.cwd || raw.envFile || raw.env_file) item.issues.push('Working directories and environment files need manual packaging. They were not imported.')
  if (raw.url) {
    try {
      const url = new URL(raw.url)
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || secret.test(raw.url) || !url.hostname.includes('.') || /^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(url.hostname)) throw Error()
      item.requirements.push({ phase: 'runtime', host: url.hostname, port: Number(url.port || 443), path: url.pathname, reason: 'MCP connection; OAuth destinations may be additional.' })
      if (raw.type && !['http', 'streamable-http'].includes(raw.type)) item.issues.push('Only Streamable HTTP is supported for remote MCPs.')
      item.config = { url: url.href }
    } catch { item.issues.push('Endpoint needs review: only public HTTPS URLs without embedded credentials, query strings or local addresses are portable.') }
  } else {
    const command = typeof raw.command === 'string' ? raw.command : ''
    const args = raw.args ?? []
    // Import only direct launches. Shell snippets, inline code and installer
    // commands are not converted into an executable sandbox configuration.
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,60}$/.test(command) || ['sh', 'bash', 'zsh', 'fish', 'cmd', 'powershell', 'node', 'python', 'python3', 'ruby', 'perl', 'npx', 'npm', 'uv', 'uvx', 'pip', 'docker', 'curl', 'wget'].includes(command)) {
      item.issues.push('Needs a packaged Linux executable. Local paths, interpreters and package runners are not executed during import.')
      if (['npx', 'npm'].includes(path.basename(command))) item.requirements.push({ phase: 'build', host: 'registry.npmjs.org', port: 443, reason: 'Potential npm dependency; not an approved or complete download list.' })
    } else if (!Array.isArray(args) || args.length > 32 || args.some((arg) => typeof arg !== 'string' || !/^[a-zA-Z0-9_.=-]{1,128}$/.test(arg) || /token|password|secret|key|eval|exec/i.test(arg) || secret.test(arg))) {
      item.issues.push('Arguments need manual review; values were not imported.')
    } else item.config = { command, args }
  }
  return item
}

export async function readSkill(root, home = os.homedir()) {
  const resolved = await fs.realpath(root)
  if (resolved !== root || !inside(await fs.realpath(home), resolved)) throw fail('Skill location changed. Discover it again.')
  const files = []; let bytes = 0
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
      if (!textExtensions.has(path.extname(entry.name).toLowerCase())) throw fail('Skill contains binary or unsupported files. Review and package these separately.')
      const content = await readBounded(file)
      bytes += content.length
      if (bytes > MAX_BUNDLE || files.length >= 200) throw fail('Skill exceeds the 4 MB / 200 file limit.')
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
        const digest = hash(JSON.stringify({ name: item.name, config: item.config, issues: item.issues, credentialFields: item.credentialFields }))
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
  const { root, config, files, ...rest } = item
  return { ...rest, ...(config ? { configuration: config.url ? { endpoint: config.url } : { command: config.command, args: config.args } } : {}), ...(files ? { files: files.map(({ path, content }) => ({ path, bytes: Buffer.byteLength(content) })) } : {}) }
}
