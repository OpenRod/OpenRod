import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { gateway, contextSelection, runWithContext, sandboxView } from './gateway.js'
import { imageTemplateRoute, listImageTemplates, templateView } from './image-templates.js'
import { newRecipe, recipeErrors, NAME_PATTERN } from '../src/lib/image-templates.js'
import { defaultSession, isSession } from '../src/lib/sandbox-session.js'
import { IMAGE_TEMPLATE_NAME } from '../src/lib/sandbox-images.js'
import { groupIds } from '../shared/group-membership.js'
import { assertSandboxGroup } from '../shared/group-network.js'
import { cloudOrigin, cloudUnavailable } from './cloud-origin.js'
import { agentAccessRules } from '../shared/agent-access.js'
import { listGroups, planSandbox } from './org.js'
import { listPolicies } from './egress.js'

export const CLOUD_TRANSFER_LIMIT = 25 * 1024 * 1024
export const CLOUD_TRANSFER_BODY_LIMIT = 36 * 1024 * 1024
const MAX_FILES = 2000
const fail = (message, status = 400) => Object.assign(new Error(message), { status })
const excludedDirectories = ['.git', '.openshell', 'node_modules', '.cache', '__pycache__', '.venv', 'venv', '.ssh', '.aws', '.azure', '.config', '.local', '.npm', '.npm-global', '.claude', '.codex', '.cursor', '.opencode', '.kiro', '.docker', '.gnupg', '.kube', '.terraform', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.turbo']
const excluded = new Set(excludedDirectories)
const secretName = /^(?:\.env(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|\.npmrc|\.pypirc|\.netrc|credentials(?:\..*)?|secrets?(?:\..*)?|auth\.json|\.claude\.json|\.git-credentials|\.(?:bash|zsh|python|sqlite)_history|.+\.(?:pem|key|p12|pfx|jks|keystore|tfstate)(?:\.backup)?)$/i
const privateKey = /-----BEGIN (?:[A-Z ]*PRIVATE KEY|OPENSSH PRIVATE KEY)-----/

export function transferPathAllowed(value) {
  if (typeof value !== 'string' || !value || value.length > 1024 || /[\\\0\x01-\x1f\x7f]/.test(value)) return false
  const parts = value.split('/')
  if (parts.length > 64 || parts.some((part) => !part || part === '.' || part === '..' || Buffer.byteLength(part) > 255 || excluded.has(part.toLowerCase()))) return false
  return parts.every((part) => !secretName.test(part) || /^\.env\.(?:example|sample|template)$/i.test(part))
}

export function validateTransfer(value) {
  if (!value || value.version !== 1 || !Array.isArray(value.files) || value.files.length > MAX_FILES) throw fail('Invalid cloud transfer bundle.')
  const launch = value.launch
  if (!launch || Object.keys(launch).some((key) => !['name', 'image', 'session'].includes(key)) || !NAME_PATTERN.test(launch.name ?? '') || typeof launch.image !== 'string' || !/^[\w./:@-]{1,256}$/.test(launch.image) || !isSession(launch.session)) throw fail('Invalid cloud launch settings.')
  let recipe
  if (value.recipe !== undefined) {
    if (!value.recipe || typeof value.recipe !== 'object' || !Array.isArray(value.recipe.environment) || value.recipe.environment.length) throw fail('Template environment is never transferred.')
    recipe = newRecipe(Object.fromEntries(Object.keys(newRecipe()).filter((key) => key in value.recipe).map((key) => [key, value.recipe[key]])))
    if (recipe.source !== 'build' || Object.keys(recipeErrors(recipe)).length || privateKey.test(JSON.stringify(recipe))) throw fail('Invalid cloud rebuild recipe.')
  }
  const seen = new Set()
  let bytes = 0
  const files = value.files.map((file) => {
    if (!file || !transferPathAllowed(file.path)) throw fail('Invalid or sensitive transfer path.')
    if (seen.has(file.path)) throw fail('Duplicate transfer path.')
    seen.add(file.path)
    if (typeof file.data !== 'string' || /[^A-Za-z0-9+/=]/.test(file.data) || file.data.length % 4 !== 0) throw fail('Invalid file encoding.')
    // Check length before allocating the decoded buffer.
    bytes += Buffer.byteLength(file.data, 'base64')
    if (bytes > CLOUD_TRANSFER_LIMIT) throw fail('Cloud transfer supports up to 25 MiB of workspace files.', 413)
    const content = Buffer.from(file.data, 'base64')
    if (content.toString('base64') !== file.data || privateKey.test(content.toString('utf8'))) throw fail('A file contains a private key or invalid encoding.')
    return { path: file.path, content, executable: file.executable === true }
  })
  // A file cannot also be a parent directory of another file.
  for (const name of seen) { const parts = name.split('/'); parts.pop(); while (parts.length) { if (seen.has(parts.join('/'))) throw fail('Conflicting transfer paths.'); parts.pop() } }
  return { launch: { ...launch }, recipe, files, bytes }
}

async function collect(client, workspace, name, script, limit) {
  const chunks = []
  let bytes = 0, exit = null
  const controller = new AbortController()
  try {
    for await (const event of client.sandbox.execStream(name, ['/bin/sh', '-c', script], { workspace, noLoginShell: true, timeoutSecs: 300, signal: controller.signal })) {
      if (event.stream === 'stdout') {
        bytes += event.data.length
        if (bytes > limit) throw fail('Cloud transfer supports up to 25 MiB and 2,000 files.', 413)
        chunks.push(Buffer.from(event.data))
      } else if (event.type === 'exit') exit = event.exitCode
    }
  } catch (error) { controller.abort(); throw error }
  if (exit !== 0) throw fail('Could not read workspace files safely. Retry after file writes finish.', 502)
  return Buffer.concat(chunks).toString('utf8')
}
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'"

// A source's memberships have no authority on another destination. Reuse the
// destination's sole eligible group, or require a deliberate choice when its
// policies offer multiple groups. Creation validates the policy again atomically.
export async function resolveDestinationGroups({ destinationGroups, name, recipe }, dependencies = {}) {
  const [groups, policies] = await Promise.all([(dependencies.listGroups ?? listGroups)(), (dependencies.listPolicies ?? listPolicies)()])
  let selected
  if (destinationGroups !== undefined) {
    try { selected = groupIds(destinationGroups) } catch (error) { throw fail(error.message) }
  } else {
    const eligible = groups.filter(group => {
      try { assertSandboxGroup([group.id], groups, policies); return true } catch { return false }
    })
    if (!eligible.length) throw fail('Add a network rule to a destination group before importing this workspace.', 409)
    if (eligible.length !== 1) throw fail('Choose a destination group before importing this workspace.', 409)
    selected = [eligible[0].id]
  }
  try { assertSandboxGroup(selected, groups, policies) } catch (error) { throw fail(error.message) }
  const plan = await (dependencies.planSandbox ?? planSandbox)({ name, groups: selected, requireGroup: true, agentRules: recipe ? agentAccessRules(recipe) : [] })
  return plan.groups
}

export async function exportTransfer(input, options = {}) {
  if (!NAME_PATTERN.test(input?.name ?? '')) throw fail('Invalid workspace transfer request.')
  const { client, workspace, workspaceScope } = await (options.connect ?? gateway)()
  const sandbox = sandboxView((await client.raw.getSandbox({ name: input.name, workspaceScope })).sandbox)
  if (sandbox.phase !== 'ready') throw fail('Start this sandbox before transferring its workspace.', 409)
  const listed = await collect(client, workspace, input.name, `[ "$(realpath /sandbox)" = /sandbox ] || exit 1\nfind /sandbox \\( -type d \\( ${excludedDirectories.map((name) => '-iname ' + quote(name)).join(' -o ')} \\) -prune \\) -o \\( -type f -print0 \\)`, 512 * 1024)
  const paths = listed.split('\0').filter(Boolean).filter((value) => value.startsWith('/sandbox/') && transferPathAllowed(value.slice(9)))
  if (paths.length > MAX_FILES) throw fail('Cloud transfer supports up to 2,000 files.', 413)
  // Recheck every path immediately before reading. find never follows links;
  // realpath equality also refuses a parent replaced with a symlink.
  const script = paths.length ? `set -eu\nfor f in ${paths.map(quote).join(' ')}; do\n[ -f "$f" ] && [ ! -L "$f" ] && [ "$(realpath "$f")" = "$f" ] || exit 1\nprintf '%s\\0' "\${f#/sandbox/}"\nbase64 < "$f"\nprintf '\\0'\nif [ -x "$f" ]; then printf 'true\\0'; else printf 'false\\0'; fi\ndone` : 'true'
  const fields = (await collect(client, workspace, input.name, script, CLOUD_TRANSFER_BODY_LIMIT)).split('\0')
  const files = []
  for (let i = 0; i + 2 < fields.length; i += 3) files.push({ path: fields[i], data: fields[i + 1].replace(/\s/g, ''), executable: fields[i + 2] === 'true' })
  if (fields.length !== files.length * 3 + 1 || fields.at(-1) !== '') throw fail('Incomplete workspace transfer.', 502)
  let recipe, warning
  const templateName = sandbox.workloadTemplate || sandbox.labels?.[IMAGE_TEMPLATE_NAME]
  if (templateName) {
    let template
    try { template = templateView(await client.sandboxTemplates.get(templateName, { workspace })) } catch (error) { if (error.code !== 'not_found') throw error }
    if (template?.managed && template.recipe.source === 'build') {
      recipe = { ...template.recipe, environment: [], command: isSession(template.recipe.command) ? template.recipe.command : '', setups: [], setupRevisions: {} }
      if (template.recipe.setups?.length) warning = 'Workspace and image recipe copied. Reconnect saved MCP and skill Setups, and agent credentials on the destination.'
    }
    else warning = 'Files copied into a fresh Ubuntu shell. Reinstall your custom image tools and reconnect credentials at the destination.'
  }
  const localImage = !sandbox.image || sandbox.image.startsWith('openshell-template/') || !sandbox.image.includes('/') && !/^(ubuntu|debian|alpine|node|python|busybox)(:|$)/.test(sandbox.image)
  if (!recipe && localImage) warning ??= 'Files copied into a fresh Ubuntu shell. Rebuild your custom image and reconnect credentials at the destination.'
  const value = { version: 1, launch: { name: sandbox.name, image: recipe || warning ? 'ubuntu:24.04' : sandbox.image, session: warning && !recipe ? 'shell' : defaultSession(sandbox) }, files, ...(recipe ? { recipe } : {}) }
  validateTransfer(value)
  return { bundle: value, ...(warning ? { warning } : {}) }
}

export async function localTransfer(input, options = {}) {
  const origin = options.origin ?? cloudOrigin()
  if (!origin) throw cloudUnavailable()
  if (typeof input?.ticket !== 'string' || !/^openrod-user-[a-f0-9]{24}\.[a-f0-9]{64}$/.test(input.ticket)) throw fail('Invalid cloud transfer request.')
  const { bundle, warning } = await exportTransfer(input, options)
  if (input.destinationGroups !== undefined) {
    try { bundle.destinationGroups = groupIds(input.destinationGroups) } catch (error) { throw fail(error.message) }
  }
  const response = await (options.fetch ?? fetch)(`${origin}/api/cloud/import`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${input.ticket}` }, body: JSON.stringify(bundle), redirect: 'error', signal: AbortSignal.timeout(35 * 60_000),
  })
  const result = await response.json().catch(() => ({}))
  if (!response.ok) throw fail(result.error || 'Cloud import failed. Your local workspace is unchanged.', response.status)
  return { ...result, ...(warning ? { warning } : {}) }
}

async function rebuild(recipe) {
  const name = `handoff-${randomBytes(5).toString('hex')}`
  await imageTemplateRoute('POST', ['image-templates'], { recipe: { ...recipe, name, environment: [] } })
  const deadline = Date.now() + 20 * 60_000
  while (Date.now() < deadline) {
    const template = (await listImageTemplates()).find((item) => item.name === name)
    if (template?.status === 'ready') return name
    if (template?.status === 'failed') throw fail(`Image rebuild failed. Open Templates on the destination and inspect ${name}.`, 502)
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  await imageTemplateRoute('POST', ['image-templates', name, 'cancel'], {}).catch(() => {})
  throw fail('Image rebuild timed out. Check Docker on the destination and retry.', 504)
}

async function waitReady(name) {
  const { client, workspaceScope } = await gateway()
  const deadline = Date.now() + 180_000
  while (Date.now() < deadline) {
    const sandbox = sandboxView((await client.raw.getSandbox({ name, workspaceScope })).sandbox)
    if (sandbox.phase === 'ready') return
    if (['error', 'deleting', 'completed'].includes(sandbox.phase)) throw fail(`Sandbox ${name} did not start. Review its status on the destination.`, 502)
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  throw fail(`Sandbox ${name} startup timed out. Review its status on the destination.`, 504)
}

async function upload(name, root) {
  const { target, client, workspace } = await gateway()
  const relatives = []
  const walk = async (folder, prefix = '') => { for (const entry of await fs.readdir(folder, { withFileTypes: true })) { const relative = prefix + entry.name; relatives.push('/sandbox/' + relative); if (entry.isDirectory()) await walk(path.join(folder, entry.name), relative + '/') } }
  await walk(root)
  const check = await client.sandbox.exec(name, ['/bin/sh', '-c', `set -eu\n[ \"$(realpath /sandbox)\" = /sandbox ] || exit 1\nfor p in ${relatives.map(quote).join(' ')}; do [ ! -L \"$p\" ] || exit 1; done`], { workspace, noLoginShell: true, timeoutSecs: 30 })
  if (check.exitCode !== 0) throw fail('The destination contains a symlink. Review the template before transferring.', 409)
  await new Promise((resolve, reject) => {
    const child = spawn(process.env.OPENSHELL_BIN || 'openshell', ['--gateway', target.name, '--workspace', workspace, 'sandbox', 'upload', '--no-git-ignore', name, '.', '/sandbox'], { cwd: root, shell: false, stdio: ['ignore', 'ignore', 'ignore'] })
    const timer = setTimeout(() => child.kill('SIGKILL'), 10 * 60_000)
    child.once('error', () => { clearTimeout(timer); reject(fail('The workspace upload could not start on the destination.', 502)) })
    child.once('close', (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(fail('Workspace upload failed. Your source workspace is unchanged.', 502)) })
  })
}

// createSandbox is injected by the router to avoid a circular API dependency.
export async function importTransfer(req, options) {
  return runWithContext(contextSelection(), async () => {
    const chunks = []
    let bytes = 0
    for await (const chunk of req) { bytes += Buffer.byteLength(chunk); if (bytes > CLOUD_TRANSFER_BODY_LIMIT) throw fail('Cloud transfer request too large.', 413); chunks.push(Buffer.from(chunk)) }
    let value
    try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw fail('Invalid cloud transfer JSON.') }
    const transfer = validateTransfer(value)
    const name = `${transfer.launch.name.slice(0, 10).replace(/-+$/, '')}-${randomBytes(4).toString('hex')}`
    const groups = await (options.resolveGroups ?? resolveDestinationGroups)({ destinationGroups: value.destinationGroups, name, recipe: transfer.recipe })
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'openrod-cloud-transfer-'))
    try {
      const root = path.join(temp, 'workspace')
      await fs.mkdir(root, { mode: 0o755 })
      for (const file of transfer.files) {
        const target = path.join(root, ...file.path.split('/'))
        await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o755 })
        await fs.writeFile(target, file.content, { flag: 'wx', mode: file.executable ? 0o755 : 0o644 })
      }
      const template = transfer.recipe ? await (options.rebuild ?? rebuild)(transfer.recipe) : null
      // Each handoff creates a separate copy, including a return to the computer
      // where the original workspace still exists. Never replace that sandbox.
      const sandbox = await options.createSandbox(template ? { name, imageTemplate: template, session: transfer.launch.session, groups } : { ...transfer.launch, name, groups })
      await (options.waitReady ?? waitReady)(sandbox.name)
      if (transfer.files.length) await (options.upload ?? upload)(sandbox.name, root)
      return { name: sandbox.name, files: transfer.files.length, bytes: transfer.bytes, reconnectCredentials: true }
    } finally { await fs.rm(temp, { recursive: true, force: true }) }
  })
}
