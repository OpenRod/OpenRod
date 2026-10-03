import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { NAME_PATTERN, RECIPE_ANNOTATION, newRecipe, recipeErrors, dockerfileFor, storedRecipe, buildFingerprint } from '../src/lib/image-templates.js'
import { IMAGE_TEMPLATE_NAME } from '../src/lib/sandbox-images.js'
import { resolveSetups, usableSetup } from './setups.js'
import { artifactFile } from './setup-packages.js'
import { remoteImageEngine } from './remote-image-engine.js'
import { gateway, resolveGateway, iso, contextKey, contextSelection, runWithContext, workspaceName, workspaceScope, listGateways, gatewayWorkspaces } from './gateway.js'

// Image templates are OpenShell sandbox templates (`openshell sandbox template
// create`): the gateway stores the name, image and environment, and the recipe
// rides along as an annotation so the console can edit and rebuild it. Only a
// running or failed build lives here, in memory.
const BUILT_PREFIX = 'openshell-template/'
const LABEL = 'openshell.console/image-template'
// Vite reloads server modules during development; jobs must survive that.
const stateKey = Symbol.for('openshell.console.image-template-jobs.v2')
const processState = globalThis[stateKey] ??= { jobs: new Map(), locks: new Set() }
const { jobs, locks } = processState
const fail = (message, status = 400) => Object.assign(new Error(message), { status })
const running = (job) => job?.status === 'building'
const jobKey = (name) => JSON.stringify([contextKey(), name])
async function locked(name, task) {
  name = jobKey(name)
  if (locks.has(name)) throw fail('An operation is already starting for this template.', 409)
  locks.add(name)
  try { return await task() } finally { locks.delete(name) }
}
const checkName = (name) => { if (!NAME_PATTERN.test(name || '')) throw fail('Unknown image template.', 404); return name }
const missing = (e) => e?.code === 'not_found'
export { run as runDocker }
export const savingTemplate = () => [...jobs.values()].some((j) => j.saving && running(j))
// Connects the local gateway's VM driver to the build engine (gateway-docker.js); set by api.js in local mode.
let gatewayDocker = null
export const setGatewayDocker = (value) => { gatewayDocker = value }

function run(args, { job, engine, timeout = 30_000, spawnProcess = spawn } = {}) {
  return new Promise((resolve, reject) => {
    if (job?.cancelled) return reject(fail('Operation cancelled.'))
    const host = engine?.endpoint
    const env = { ...process.env }
    if (host) { delete env.DOCKER_CONTEXT; delete env.DOCKER_HOST }
    const detached = process.platform !== 'win32'
    const child = spawnProcess('docker', host ? ['--host', host, ...args] : args, { env, detached, shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
    // Buildx and credential helpers can inherit these pipes. Stop the isolated
    // process group so cancellation/timeout cannot wait forever for a helper.
    const kill = (signal) => {
      if (detached && child.pid) try { process.kill(-child.pid, signal); return true } catch { /* parent already exited or group unavailable */ }
      return child.kill(signal)
    }
    if (job) job.child = { kill }
    let output = '', stdout = '', stderr = ''
    let timedOut = false
    const append = (chunk) => {
      const clean = chunk.toString().replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
      output = (output + clean).slice(-100_000)
      if (job) job.logs = (job.logs + clean).slice(-100_000)
      return clean
    }
    child.stdout.on('data', chunk => { stdout = (stdout + chunk.toString()).slice(-100_000); append(chunk) }); child.stderr.on('data', chunk => { stderr = (stderr + append(chunk)).slice(-100_000) })
    const timer = setTimeout(() => { timedOut = true; kill('SIGKILL') }, timeout)
    child.once('error', (e) => { clearTimeout(timer); reject(Object.assign(fail(e.code === 'ENOENT' ? 'Docker is not installed on this computer.' : e.message), { code: e.code })) })
    child.once('close', (code) => {
      clearTimeout(timer)
      if (job) job.child = null
      if (job?.cancelled) reject(fail('Operation cancelled.'))
      else if (timedOut) reject(fail('Docker timed out. Check the engine and retry.'))
      // `docker info` prints a JSON dump on stdout even when it fails; the reason is on stderr.
      else if (code) reject(fail((stderr.trim() || output.trim()).slice(-1600) || `Docker exited with code ${code}.`))
      else resolve(stdout)
    })
  })
}
export async function localEngine({ execute = run } = {}) {
  try {
    const endpoint = process.env.DOCKER_HOST || JSON.parse(await execute(['context', 'inspect']))[0]?.Endpoints?.docker?.Host
    if (!endpoint?.startsWith('unix://')) throw fail('Select a local Docker context with a Unix socket, then retry.')
    const info = JSON.parse(await execute(['info', '--format', '{{json .}}'], { engine: { endpoint } }))
    if (info.ServerErrors?.length) throw fail(`Docker is unavailable. Start Docker Desktop and retry. ${info.ServerErrors.join(' ')}`, 503)
    if (info.OSType !== 'linux') throw fail('Switch local Docker to Linux containers, then retry.')
    return { endpoint, architecture: info.Architecture === 'aarch64' ? 'arm64' : info.Architecture === 'x86_64' ? 'amd64' : info.Architecture, engineId: info.ID, desktop: info.OperatingSystem === 'Docker Desktop' }
  } catch (e) {
    if (e.code === 'ENOENT') throw fail('Docker isn’t installed. Install Docker Desktop (macOS: brew install --cask docker-desktop) or Docker Engine (Linux), start it, then try again.')
    if (/failed to connect to the docker API|Cannot connect to the Docker daemon|connection refused/i.test(e.message)) throw fail('Docker isn’t running. Start Docker Desktop (or the Docker service), then try again.', 503)
    throw fail(`Local Docker is required to build images. ${e.message}`, e.status ?? 400)
  }
}
async function deploymentEngine(target) {
  return target.remote ? remoteImageEngine(target, { execute: run }) : localEngine()
}
async function inspect(reference, engine, { execute = run, job, architecture = engine.architecture } = {}) {
  const image = JSON.parse(await execute(['image', 'inspect', reference], { engine, job }))[0]
  if (image.Os !== 'linux') throw fail('Choose a Linux container image.')
  if (image.Architecture !== architecture) throw fail(`This image is ${image.Architecture}; the deployment engine uses ${architecture}. Choose a matching image.`)
  return image
}
async function ensureImage(reference, engine, { execute, job }) {
  try { return await inspect(reference, engine, { execute, job }) } catch (e) {
    if (job.cancelled) throw fail('Operation cancelled.')
    if (!/No such image:/i.test(e.message)) throw e
    await execute(['pull', '--platform', `linux/${engine.architecture}`, reference], { engine, job, timeout: 30 * 60_000 })
    return inspect(reference, engine, { execute, job })
  }
}

export function buildImage(image, context, engine, job, execute = run, { networkNone = false, architecture = engine.architecture } = {}) {
  // Build locally for the deployment engine, regardless of shell defaults.
  return execute(['build', ...(networkNone ? ['--network=none'] : []), '--platform', `linux/${architecture}`, '--progress=plain', '--tag', image, context], { engine, job, timeout: 30 * 60_000 })
}

export function templateView(t) {
  const meta = t.metadata ?? {}
  const workload = t.spec?.workload ?? {}
  const environment = Object.entries(workload.environment ?? {}).map(([name, value]) => ({ name, value }))
  let stored = null
  try { stored = JSON.parse(meta.annotations?.[RECIPE_ANNOTATION] ?? 'null') } catch { /* edited outside the console */ }
  // Annotations can be written with the CLI, so a recipe counts only if it is valid.
  const { build = null, ...fields } = stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {}
  const recipe = stored && typeof stored === 'object' && !Array.isArray(stored) ? newRecipe({ ...fields, name: meta.name, environment }) : null
  const managed = Boolean(recipe && !Object.keys(recipeErrors(recipe)).length)
  return {
    name: meta.name,
    image: workload.image || null,
    createdAt: iso(meta.createdTime),
    managed,
    recipe: managed ? recipe : newRecipe({ source: 'image', image: workload.image || '', agents: [], command: '', name: meta.name, environment }),
    build: managed && typeof build === 'string' ? build : null,
    status: 'ready',
  }
}
const jobView = (job) => ({ name: job.name, image: null, recipe: job.recipe, status: job.status, logs: job.logs, error: job.error, startedAt: job.startedAt })

export async function listImageTemplates({ connect = gateway, check = gatewayDocker, resolve = resolveGateway } = {}) {
  // Wait out a local gateway restart (gateway-docker.js), as the save does.
  if (check && !resolve().remote) await check.settle()
  const { client, workspace } = await connect()
  const templates = (await client.sandboxTemplates.listAll({ workspace })).map(templateView)
  const byName = new Map(templates.map((t) => [t.name, t]))
  // A rebuild in progress (or one that failed) shows on the template it replaces.
  for (const job of jobs.values()) if (job.scope === contextKey()) byName.set(job.name, { ...byName.get(job.name), ...jobView(job), exists: byName.has(job.name) })
  return [...byName.values()].sort((a, b) => (b.startedAt ?? b.createdAt ?? '').localeCompare(a.startedAt ?? a.createdAt ?? ''))
}

// What New sandbox needs: the template name plus how the sandbox starts.
export async function imageTemplateForLaunch(name, { connect = gateway, engineFor = deploymentEngine, check = gatewayDocker, execute = run } = {}) {
  const { client, target, workspace } = await connect()
  let template
  try { template = templateView(await client.sandboxTemplates.get(checkName(name), { workspace })) } catch (e) { if (missing(e)) throw fail('Image template not found.', 404); throw e }
  const built = Boolean(template.image?.startsWith(BUILT_PREFIX))
  if (built) {
    const engine = await engineFor(target)
    try { await inspect(template.image, engine, { execute }) } catch { throw fail('This template’s image is unavailable or incompatible on the selected compute. Rebuild the template before launching.') }
  }
  // The local VM driver must reach the engine holding built or never-pushed images.
  if (!target.remote && check && template.image) {
    const localOnly = async () => {
      try { return !JSON.parse(await execute(['image', 'inspect', template.image], { engine: await engineFor(target) }))[0]?.RepoDigests?.length } catch { return false }
    }
    await check.assertLaunch({ built, localOnly })
  }
  return template
}

async function inventory() {
  try {
    const engine = await deploymentEngine(resolveGateway())
    const result = await run(['image', 'ls', '--format', '{{json .}}'], { engine })
    const images = result.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)).filter((i) => i.Repository !== '<none>' && i.Tag !== '<none>' && !i.Repository.startsWith(BUILT_PREFIX)).map((i) => ({ reference: `${i.Repository}:${i.Tag}`, size: i.Size }))
    return { images }
  } catch (e) { return { error: e.message, images: [] } }
}

function clean(input) {
  const raw = input?.recipe
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw fail('An image recipe is required.')
  // Only known recipe fields survive; policy or credentials never ride along.
  const recipe = newRecipe(Object.fromEntries(Object.keys(newRecipe()).filter((key) => key in raw).map((key) => [key, raw[key]])))
  const errors = recipeErrors(recipe)
  if (Object.keys(errors).length) throw fail(Object.values(errors)[0])
  return recipe
}

async function start(input) {
  const recipe = clean(input)
  const setups = (await resolveSetups(recipe.setups)).map(usableSetup)
  if (setups.some(s => recipe.setupRevisions?.[s.id] && recipe.setupRevisions[s.id] !== s.revision)) throw fail('A selected Setup changed. Review it before building the image.',409)
  recipe.setupRevisions = Object.fromEntries(setups.map(s => [s.id, s.revision]))
  const pinnedErrors = recipeErrors(recipe)
  if (Object.keys(pinnedErrors).length) throw fail(Object.values(pinnedErrors)[0])
  if (setups.some((s) => !s.items.length)) throw fail('A selected Setup has unresolved import requirements. Resolve or re-import those items before building.')
  const { name } = recipe
  const key = jobKey(name)
  const replace = input.replace === true
  if (running(jobs.get(key))) throw fail('This template is already building.', 409)
  if ([...jobs.values()].filter(running).length >= 2) throw fail('Two image builds are already running. Wait for one to finish.', 409)
  const { client, target, workspace } = await gateway()
  let previous = null
  try { previous = await client.sandboxTemplates.get(name, { workspace }) } catch (e) { if (!missing(e)) throw e }
  if (previous && !replace) throw fail('A template with this name already exists. Pick another name.', 409)
  if (previous && !templateView(previous).managed) throw fail('This template was created outside the console. Edit it with the openshell CLI.', 409)
  const engine = await deploymentEngine(target)
  const buildEngine = target.remote && (recipe.source === 'build' || setups.length) ? await localEngine() : engine
  const job = { name, scope: contextKey(), recipe, status: 'building', logs: '', error: null, cancelled: false, child: null, startedAt: new Date().toISOString() }
  jobs.set(key, job)
  // A long build hides the gateway restart that lets its VM driver see local images.
  if (!target.remote) void gatewayDocker?.ensure()
  const hooks = target.remote ? {} : {
    gatewayReady: () => gatewayDocker?.settle(),
    refreshClient: async () => (await gateway({ gateway: target.name, workspace })).client,
  }
  void (async () => {
    try {
      await publishImageTemplate({ recipe, setups, client, workspace, previous, target, engine, buildEngine, job, ...hooks })
      jobs.delete(key)
      // Other workspaces or gateways may still reference the previous Docker image.
      // Keep published images; removing a record must not remove a shared image.
    } catch (e) {
      job.status = 'failed'; job.error = e.message; job.saving = false
    }
  })()
  return jobView(job)
}

export async function publishImageTemplate({ recipe, setups = [], client, workspace, previous, target, engine, buildEngine = engine, job, gatewayReady, refreshClient }, { execute = run } = {}) {
  let temp
  let baseTag
  const generated = recipe.source === 'build' || setups.length > 0
  const active = () => { if (job.cancelled) throw fail('Operation cancelled.') }
  try {
    active()
    let image = recipe.image
    if (generated) {
      if (target.remote && (buildEngine.endpoint === engine.endpoint || (engine.engineId && buildEngine.engineId === engine.engineId))) throw fail('The selected Docker context points at the SSH host. Select a local Docker context to build this image, then retry.')
      temp = await fs.mkdtemp(path.join(os.tmpdir(), 'openshell-image-'))
      let baseImage = recipe.image
      if (target.remote && recipe.source === 'image') {
        const base = await ensureImage(recipe.image, engine, { execute, job })
        if (!base.Id) throw fail('Docker did not report the base image ID. Select the image again before rebuilding.')
        const baseArchive = path.join(temp, 'base.tar')
        active()
        // Saving by ID omits user tags, so loading cannot overwrite a different
        // local image with the same name as the selected remote image.
        await execute(['save', '--output', baseArchive, base.Id], { engine, job, timeout: 30 * 60_000 })
        active()
        await execute(['load', '--input', baseArchive], { engine: buildEngine, job, timeout: 30 * 60_000 })
        active()
        const loaded = await inspect(base.Id, buildEngine, { execute, job, architecture: engine.architecture })
        if (loaded.Id !== base.Id) throw fail('The base image loaded locally does not match the selected SSH host image. Retry the build.')
        active()
        baseTag = `${BUILT_PREFIX}${recipe.name}:base-${randomUUID()}`
        await execute(['tag', base.Id, baseTag], { engine: buildEngine, job })
        baseImage = baseTag
        // The base archive must not become part of the Docker build context.
        await fs.rm(baseArchive)
      }
      await fs.writeFile(path.join(temp, 'Dockerfile'), recipe.source === 'build' ? dockerfileFor(recipe) : `FROM ${baseImage}\nCOPY --chown=1000:1000 setup-bundles/ /sandbox/.openshell/bundles/\n`)
      if (setups.length) {
        await fs.mkdir(path.join(temp, 'setup-bundles'), { mode: 0o700 })
        for (const setup of setups) {
          await fs.writeFile(path.join(temp, 'setup-bundles', setup.id + '.json'), JSON.stringify(setup), { mode: 0o600 })
          for (const item of setup.items.filter(i => i.artifact)) { const { data } = await artifactFile(item.artifact); await fs.writeFile(path.join(temp, 'setup-bundles', item.artifact.digest + '.tar.gz'), data, { mode: 0o600 }) }
        }
      }
      await fs.writeFile(path.join(temp, 'setup.sh'), recipe.setup)
      image = `${BUILT_PREFIX}${recipe.name}:${randomUUID()}`
      active()
      await buildImage(image, temp, buildEngine, job, execute, { networkNone: recipe.source === 'image', architecture: engine.architecture })
      active()
      const built = await inspect(image, buildEngine, { execute, job, architecture: engine.architecture })
      if (target.remote) {
        if (!built.Id) throw fail('Docker did not report the built image ID. Rebuild the template before transferring it.')
        const archive = path.join(temp, 'image.tar')
        active()
        await execute(['save', '--output', archive, image], { engine: buildEngine, job, timeout: 30 * 60_000 })
        active()
        const info = JSON.parse(await execute(['info', '--format', '{{json .}}'], { engine, job }))
        if (info.ID !== engine.engineId) throw fail('The SSH host’s Docker engine changed during the build. Reconnect the selected SSH host and retry.')
        active()
        await execute(['load', '--input', archive], { engine, job, timeout: 30 * 60_000 })
        active()
        const loaded = await inspect(image, engine, { execute, job })
        if (loaded.Id !== built.Id) throw fail('The image loaded on the selected SSH host does not match the local build. Rebuild and transfer it again.')
      }
    } else {
      // References are resolved on the deployment engine, not on local Docker.
      await ensureImage(image, engine, { execute, job })
    }
    // Saving deletes and recreates the template, so it waits out a gateway restart.
    active(); if (gatewayReady) { await gatewayReady(); active() }
    job.saving = true
    try {
      if (refreshClient) client = await refreshClient()
      await saveTemplate(client, workspace, recipe, image, previous)
    } catch (e) {
      // Only this build's unpublished local tag is disposable. Remote images
      // may be shared with another gateway or workspace and are retained.
      if (generated) await execute(['image', 'rm', '--', image], { engine: buildEngine }).catch(() => {})
      throw e
    }
    return image
  } finally {
    if (baseTag) await execute(['image', 'rm', '--', baseTag], { engine: buildEngine }).catch(() => {})
    if (temp) await fs.rm(temp, { recursive: true, force: true }).catch(() => {})
  }
}

// OpenShell has no template update: replace means delete and recreate under
// the same name. Sandboxes already created keep running unchanged.
async function saveTemplate(client, workspace, recipe, image, previous) {
  const template = {
    metadata: { name: recipe.name, labels: { [LABEL]: 'v1' }, annotations: { [RECIPE_ANNOTATION]: JSON.stringify({ ...storedRecipe(recipe), build: buildFingerprint(recipe) }) } },
    spec: { workload: { image, environment: Object.fromEntries(recipe.environment.map((e) => [e.name, e.value])) } },
  }
  if (previous) await client.sandboxTemplates.delete(recipe.name, { workspace, allowMissing: true })
  try { await client.sandboxTemplates.create(template, { workspace }) } catch (e) {
    if (previous) await client.sandboxTemplates.create({ metadata: { name: previous.metadata.name, labels: previous.metadata.labels, annotations: previous.metadata.annotations }, spec: previous.spec }, { workspace }).catch(() => {})
    throw e
  }
}

// Read every page before allowing deletion; unavailable usage must fail closed.
export async function imageTemplateUsage(client, name, image, { workspace = workspaceName() } = {}) {
  const sandboxes = []
  let imageInUse = false, pageToken = ''
  do {
    const page = await client.raw.listSandboxes({ workspaceScope: workspaceScope(workspace), pageSize: 1000, pageToken })
    for (const sandbox of page.sandboxes) {
      const sameImage = Boolean(image && sandbox.spec?.template?.image === image)
      imageInUse ||= sameImage
      const source = sandbox.createdFromWorkloadTemplate?.name || sandbox.metadata?.labels?.[IMAGE_TEMPLATE_NAME]
      if (source ? source === name : sameImage) sandboxes.push({ name: sandbox.metadata?.name })
    }
    pageToken = page.nextPageToken
  } while (pageToken)
  return { sandboxes, imageInUse }
}

// Remove the exact image reference, never force removal or prune unrelated data.
// Keep the template on Docker failure so the same action can be retried.
export async function deleteImageTemplate(client, name, { workspace = workspaceName(), retainImageReason, getEngine = localEngine, docker = run } = {}) {
  let template
  try { template = await client.sandboxTemplates.get(name, { workspace }) } catch (e) { if (!missing(e)) throw e }
  const image = template?.spec?.workload?.image
  const removeRecord = async (cleanup) => {
    await client.sandboxTemplates.delete(name, { workspace, allowMissing: true })
    return { ok: true, imageCleanup: cleanup }
  }
  return locked(`image:${image || name}`, async () => {
    const usage = await imageTemplateUsage(client, name, image, { workspace })
    if (usage.sandboxes.length) {
      throw Object.assign(fail('This template cannot be deleted while sandboxes use it. Delete the sandboxes first.', 409), {
        code: 'TEMPLATE_IN_USE', sandboxes: usage.sandboxes,
      })
    }
    if (!image) return removeRecord({ status: 'absent' })
    if (retainImageReason) return removeRecord({ status: 'retained', image, reason: retainImageReason })
    if (usage.imageInUse) return removeRecord({ status: 'retained', image, reason: 'Docker image kept because an existing sandbox still uses it.' })
    const templates = await client.sandboxTemplates.listAll({ workspace })
    if (templates.some((t) => t.metadata?.name !== name && t.spec?.workload?.image === image)) {
      return removeRecord({ status: 'retained', image, reason: 'Docker image kept because another template still uses it.' })
    }
    const engine = await getEngine()
    try {
      await docker(['image', 'rm', '--', image], { engine })
    } catch (e) {
      if (!/No such image:/i.test(e.message)) throw fail(`Could not delete the Docker image. The template was kept so you can retry. ${e.message}`, 409)
      return removeRecord({ status: 'absent', image })
    }
    return removeRecord({ status: 'removed', image })
  })
}

export async function imageTemplateRoute(method, parts, input) {
  const [area, name, action] = parts
  if (area !== 'image-templates') return undefined
  if (method === 'GET') {
    if (!name) return listImageTemplates()
    if (name === 'local-images') return inventory()
    if (action === 'usage') {
      checkName(name)
      const { client, workspace } = await gateway()
      let template
      try { template = await client.sandboxTemplates.get(name, { workspace }) } catch (e) { if (!missing(e)) throw e }
      return imageTemplateUsage(client, name, template?.spec?.workload?.image, { workspace })
    }
    return undefined
  }
  if (!name) return runWithContext(contextSelection(), () => locked(String(input?.recipe?.name ?? ''), () => start(input)))
  checkName(name)
  const key = jobKey(name)
  if (action === 'cancel') {
    const job = jobs.get(key)
    if (job?.saving) throw fail('The build finished and the template is being saved. It can no longer be cancelled.', 409)
    if (running(job)) { job.cancelled = true; job.child?.kill('SIGKILL') }
    return { ok: true }
  }
  if (action === 'dismiss') {
    if (!running(jobs.get(key))) jobs.delete(key)
    return { ok: true }
  }
  if (action === 'delete') {
    return locked(name, async () => {
      if (running(jobs.get(key))) throw fail('Cancel the build before removing this template.', 409)
      const { client, target, workspace } = await gateway()
      // A local engine can serve several contexts. Without exclusive ownership,
      // removing this context's record must not destroy another context's image.
      const retainImageReason = target.remote
        ? 'Docker image kept because it belongs to a remote gateway.'
        : listGateways().some((entry) => entry.name !== target.name) || (await gatewayWorkspaces(target.name)).some((entry) => entry.name !== workspace)
          ? 'Docker image kept because another gateway or workspace may still use it.'
          : null
      const result = await deleteImageTemplate(client, name, { workspace, retainImageReason })
      jobs.delete(key)
      return result
    })
  }
  throw fail('Unknown image template operation.', 404)
}
