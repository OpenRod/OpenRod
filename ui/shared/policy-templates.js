// Network additions share the Restricted filesystem baseline. Agent and secret
// connections are composed separately at launch, regardless of these choices.
const filesystem = {
  workdir: true,
  readOnly: ['/bin', '/usr', '/lib', '/proc', '/dev/urandom', '/etc', '/var/log'],
  readWrite: ['/tmp', '/dev/null'],
}
const https = (host, access = 'read-only') => ({ host, ports: [443], protocol: 'rest', access, enforcement: 'enforce' })
const gitPrograms = [
  '/usr/lib/git-core/git-remote-http', '/usr/lib/git-core/git-remote-https',
  '/usr/libexec/git-core/git-remote-http', '/usr/libexec/git-core/git-remote-https',
  '/usr/bin/gh', '/usr/local/bin/gh', '/usr/bin/curl', '/usr/local/bin/curl',
]
const preset = (id, name, description, rules, kind = 'access') => ({
  id, name, description, kind, builtin: true, filesystem, landlock: 'best_effort', rules,
})

export const BUILTIN_TEMPLATES = [
  // Keep the persisted ID so existing group and API references still resolve.
  preset('locked-down', 'Restricted',
    'Workspace and temporary files are writable; system folders are read-only. Includes selected agent connections and attached-secret access. Additional network access must be explicitly allowed.', [], 'baseline'),
  preset('github-read', 'GitHub - Read',
    'Clone and fetch repositories, read GitHub API data, and download repository files over HTTPS using Git, gh, or curl. Private repositories require credentials. This addition grants no push or API-write access.', [
      { name: 'github-access', binaries: gitPrograms, endpoints: [
        { host: 'github.com', ports: [443], protocol: 'rest', enforcement: 'enforce',
          allow: [{ method: 'GET', path: '/**' }, { method: 'HEAD', path: '/**' }, { method: 'OPTIONS', path: '/**' }, { method: 'POST', path: '/*/*/git-upload-pack' }],
          deny: [{ method: '*', path: '/*/*/git-receive-pack' }] },
        https('api.github.com'), https('codeload.github.com'), https('raw.githubusercontent.com'),
      ] },
    ]),
  preset('github-write', 'GitHub - Read & Write',
    'Read and push repositories and write GitHub API data, including pull requests, issues, and comments, over HTTPS using Git, gh, or curl. Credentials determine which repositories and actions are available.', [
      { name: 'github-access', binaries: gitPrograms, endpoints: [
        https('github.com', 'read-write'), https('api.github.com', 'read-write'),
        https('codeload.github.com'), https('raw.githubusercontent.com'),
      ] },
    ]),
  preset('python-packages', 'Python - Packages',
    'Download packages from PyPI and files.pythonhosted.org using Python. No publishing access is added. Other sources and destinations used by install scripts require separate rules.', [
      { name: 'pypi', binaries: ['/usr/bin/python3*', '/usr/local/bin/python3*', '/usr/local/venv/bin/python*', '/opt/aider/bin/python*'],
        endpoints: [https('pypi.org'), https('files.pythonhosted.org')] },
    ]),
  preset('node-packages', 'Node.js - Packages',
    'Download packages from registry.npmjs.org using Node.js. No publishing access is added. Git dependencies and destinations used by install scripts require separate rules.', [
      { name: 'npm', binaries: ['/usr/bin/node', '/usr/local/bin/node'], endpoints: [https('registry.npmjs.org')] },
    ]),
]

export const ACCESS_TEMPLATES = BUILTIN_TEMPLATES.filter((template) => template.kind === 'access')

export function normalizeAccessTemplates(ids = [], catalog = BUILTIN_TEMPLATES) {
  if (!Array.isArray(ids) || ids.length > 16 || ids.some((id) => !catalog.some((template) => template.kind === 'access' && template.id === id))) {
    throw new Error('Choose valid additional access templates.')
  }
  // Write includes read. Never retain the read rule's push denial alongside it.
  return [...new Set(ids)].filter((id) => id !== 'github-read' || !ids.includes('github-write'))
}

export function toggleAccessTemplate(ids, id, catalog = BUILTIN_TEMPLATES) {
  if (ids.includes(id)) return ids.filter((value) => value !== id)
  const other = id === 'github-read' ? 'github-write' : id === 'github-write' ? 'github-read' : null
  return normalizeAccessTemplates([...ids.filter((value) => value !== other), id], catalog)
}

export function composeTemplate(template, additional = [], catalog = BUILTIN_TEMPLATES) {
  const ids = normalizeAccessTemplates([
    ...normalizeAccessTemplates(template.accessTemplates, catalog),
    ...normalizeAccessTemplates(additional, catalog),
    ...(template.kind === 'access' ? [template.id] : []),
  ], catalog)
  const rules = new Map((template.kind === 'access' ? [] : template.rules).map((rule) => [rule.name, rule]))
  for (const id of ids) {
    for (const rule of catalog.find((item) => item.id === id).rules) {
      if (rules.has(rule.name)) throw new Error(`Additional access conflicts with rule "${rule.name}". Edit the saved policy or choose another addition.`)
      rules.set(rule.name, rule)
    }
  }
  return { ...template, rules: [...rules.values()], accessTemplates: ids }
}
