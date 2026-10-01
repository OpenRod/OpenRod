import { BUILTIN_TEMPLATES } from '../../shared/policy-templates.js'

export const FILESYSTEM_CHOICES = [
  { id: 'standard', name: 'Standard', description: 'Agents can work in /sandbox and use temporary files. System folders are read-only.' },
  { id: 'read-only', name: 'Read-only workspace', description: 'Agents can inspect /sandbox but cannot change it. Temporary files stay writable. Some agents need workspace writes to operate.' },
  { id: 'custom', name: 'Custom folders', description: 'Choose which folders can be read or changed.' },
]
export const COMMON_FOLDERS = [
  ['/sandbox', 'Workspace'], ['/tmp', 'Temporary files'], ['/workspace', 'Mounted workspace'],
  ['/data', 'Data'], ['/opt', 'Optional software'], ['/usr', 'System software'], ['/etc', 'System configuration'],
]
export function filesystemPreset(id) {
  const fs = structuredClone(BUILTIN_TEMPLATES[0].filesystem)
  if (id === 'read-only') { fs.workdir = false; fs.readOnly.push('/sandbox') }
  return fs
}
export function filesystemChoice(fs) {
  const samePaths = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort())
  for (const id of ['standard', 'read-only']) {
    const preset = filesystemPreset(id)
    if (fs.workdir === preset.workdir && samePaths(fs.readOnly, preset.readOnly) && samePaths(fs.readWrite, preset.readWrite)) return id
  }
  return 'custom'
}
export function availablePolicyId(name, templates) {
  const stem = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 43).replace(/-$/, '') || 'policy'
  const taken = new Set([...BUILTIN_TEMPLATES.map(template => template.id), 'claude-subscription', 'claude-github-readonly', ...templates.map(template => template.id)])
  let id = stem, suffix = 2
  while (taken.has(id)) id = `${stem}-${suffix++}`
  return id
}
export const DESTINATION_PROGRAMS = [
  { id: 'curl', name: 'Web requests (curl)', binaries: ['/usr/bin/curl', '/usr/local/bin/curl'] },
  { id: 'node', name: 'Node.js programs', binaries: ['/usr/bin/node', '/usr/local/bin/node'] },
  { id: 'python', name: 'Python programs', binaries: ['/usr/bin/python3*', '/usr/local/bin/python3*', '/usr/local/venv/bin/python*'] },
]
export function destinationRule({ host, access, program }, rules = []) {
  host = host.trim().toLowerCase()
  if (!/^(\*\*?\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(host)) throw new Error('Enter a hostname, such as docs.example.com, without https:// or a path.')
  if (!['read-only', 'read-write'].includes(access)) throw new Error('Choose read or read and write access.')
  const programs = DESTINATION_PROGRAMS.find(item => item.id === program)
  if (!programs) throw new Error('Choose which programs can connect.')
  const name = availablePolicyId(`destination-${host}`, rules.map(rule => ({ id: rule.name })))
  return { name, binaries: [...programs.binaries], endpoints: [{ host, ports: [443], protocol: 'rest', access, enforcement: 'enforce' }] }
}

// Landlock permissions are additive: a writable ancestor also makes children writable.
export function folderAccess(filesystem, path) {
  const covers = parent => parent === path || parent === '/' || path.startsWith(`${parent.replace(/\/$/, '')}/`)
  if ((path === '/sandbox' && filesystem.workdir) || filesystem.readWrite.some(covers)) return 'readWrite'
  return filesystem.readOnly.some(covers) ? 'readOnly' : 'none'
}
export function setFolderAccess(filesystem, path, access) {
  const next = { ...filesystem, readOnly: filesystem.readOnly.filter(item => item !== path), readWrite: filesystem.readWrite.filter(item => item !== path) }
  if (path === '/sandbox') next.workdir = access === 'readWrite'
  if (access !== 'none' && !(path === '/sandbox' && access === 'readWrite')) next[access].push(path)
  return next
}
