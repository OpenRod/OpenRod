import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { NAME_PATTERN, RECIPE_ANNOTATION, newRecipe, recipeErrors, dockerfileFor, storedRecipe } from '../src/lib/image-templates.js'
import { IMAGE_TEMPLATE_NAME } from '../src/lib/sandbox-images.js'
import { resolveSetups, usableSetup } from './setups.js'
import { artifactFile } from './setup-packages.js'
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

function run(args, { job, engine, timeout = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    if (job?.cancelled) return reject(fail('Operation cancelled.'))
    const host = engine?.endpoint
    const env = { ...process.env }
    if (host) { delete env.DOCKER_CONTEXT; delete env.DOCKER_HOST }
    const child = spawn('docker', host ? ['--host', host, ...args] : args, { env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
    if (job) job.child = child
    let output = ''
    let timedOut = false
    const append = (chunk) => {
      const clean = chunk.toString().replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
      output = (output + clean).slice(-100_000)
      if (job) job.logs = (job.logs + clean).slice(-100_000)
    }
    child.stdout.on('data', append); child.stderr.on('data', append)
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, timeout)
    child.once('error', (e) => { clearTimeout(timer); reject(fail(e.code === 'ENOENT' ? 'Docker is not installed on this computer.' : e.message)) })
    child.once('close', (code) => {
      clearTimeout(timer)
      if (job) job.child = null
      if (job?.cancelled) reject(fail('Operation cancelled.'))
      else if (timedOut) reject(fail('Docker timed out. Check the engine and retry.'))
      else if (code) reject(fail(output.trim().slice(-1600) || `Docker exited with code ${code}.`))
      else resolve(output)
    })
  })
}
async function localEngine() {
  const target = resolveGateway()
  if (target.remote) throw fail('Image builds currently require a local gateway.')
  const context = JSON.parse(await run(['context', 'inspect']))[0]
  const endpoint = process.env.DOCKER_HOST || context?.Endpoints?.docker?.Host
  if (!endpoint?.startsWith('unix://')) throw fail('Select a local Docker context to build images.')
  const info = JSON.parse(await run(['info', '--format', '{{json .}}'], { engine: { endpoint } }))
  if (info.OSType !== 'linux') throw fail('Linux containers are required.')
  return { endpoint, architecture: info.Architecture === 'aarch64' ? 'arm64' : info.Architecture === 'x86_64' ? 'amd64' : info.Architecture }
}
async function inspect(reference, engine) {
  const image = JSON.parse(await run(['image', 'inspect', reference], { engine }))[0]
  if (image.Os !== 'linux') throw fail('Choose a Linux container image.')
  if (image.Architecture !== engine.architecture) throw fail(`This image is ${image.Architecture}; the local engine uses ${engine.architecture}. Choose a matching image.`)
}

export function buildImage(image, context, engine, job, execute = run, { networkNone = false } = {}) {
  // Match the engine that will run this image, even when the operator's shell
  // defaults Docker builds to a different platform or context.
  return execute(['build', ...(networkNone ? ['--network=none'] : []), '--platform', `linux/${engine.architecture}`, '--progress=plain', '--tag', image, context], { engine, job, timeout: 30 * 60_000 })
}

export function templateView(t) {
  const meta = t.metadata ?? {}
  const workload = t.spec?.workload ?? {}
  const environment = Object.entries(workload.environment ?? {}).map(([name, value]) => ({ name, value }))
  let stored = null
  try { stored = JSON.parse(meta.annotations?.[RECIPE_ANNOTATION] ?? 'null') } catch { /* edited outside the console */ }
  // Annotations can be written with the CLI, so a recipe counts only if it is valid.
  const recipe = stored && typeof stored === 'object' && !Array.isArray(stored) ? newRecipe({ ...stored, name: meta.name, environment }) : null
  const managed = Boolean(recipe && !Object.keys(recipeErrors(recipe)).length)
  return {
    name: meta.name,
    image: workload.image || null,
    createdAt: iso(meta.createdTime),
    managed,
    recipe: managed ? recipe : newRecipe({ source: 'image', image: workload.image || '', agents: [], command: '', name: meta.name, environment }),
    status: 'ready',
  }
}
const jobView = (job) => ({ name: job.name, image: null, recipe: job.recipe, status: job.status, logs: job.logs, error: job.error, startedAt: job.startedAt })

export async function listImageTemplates() {
  const { client, workspace } = await gateway()
  const templates = (await client.sandboxTemplates.listAll({ workspace })).map(templateView)
  const byName = new Map(templates.map((t) => [t.name, t]))
  // A rebuild in progress (or one that failed) shows on the template it replaces.
  for (const job of jobs.values()) if (job.scope === contextKey()) byName.set(job.name, { ...byName.get(job.name), ...jobView(job), exists: byName.has(job.name) })
  return [...byName.values()].sort((a, b) => (b.startedAt ?? b.createdAt ?? '').localeCompare(a.startedAt ?? a.createdAt ?? ''))
}

// What New sandbox needs: the template name plus how the sandbox starts.
export async function imageTemplateForLaunch(name) {
  const { client, workspace } = await gateway()
  let template
  try { template = templateView(await client.sandboxTemplates.get(checkName(name), { workspace })) } catch (e) { if (missing(e)) throw fail('Image template not found.', 404); throw e }
  if (template.image?.startsWith(BUILT_PREFIX)) {
    const engine = await localEngine()
    try { await inspect(template.image, engine) } catch { throw fail('This template’s image is no longer in local Docker. Rebuild the template before launching.') }
  }
  return template
}

async function inventory() {
  try {
    const engine = await localEngine()
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
  const { client, workspace } = await gateway()
  let previous = null
  try { previous = await client.sandboxTemplates.get(name, { workspace }) } catch (e) { if (!missing(e)) throw e }
  if (previous && !replace) throw fail('A template with this name already exists. Pick another name.', 409)
  if (previous && !templateView(previous).managed) throw fail('This template was created outside the console. Edit it with the openshell CLI.', 409)
  const engine = await localEngine()
  const job = { name, scope: contextKey(), recipe, status: 'building', logs: '', error: null, cancelled: false, child: null, startedAt: new Date().toISOString() }
  jobs.set(key, job)
  void (async () => {
    let temp
    try {
      let image = recipe.image
      if (recipe.source === 'build' || setups.length) {
        temp = await fs.mkdtemp(path.join(os.tmpdir(), 'openshell-image-'))
        await fs.writeFile(path.join(temp, 'Dockerfile'), recipe.source === 'build' ? dockerfileFor(recipe) : `FROM ${recipe.image}\nCOPY --chown=1000:1000 setup-bundles/ /sandbox/.openshell/bundles/\n`)
        if (setups.length) {
          await fs.mkdir(path.join(temp, 'setup-bundles'), { mode: 0o700 })
          for (const setup of setups) {
            await fs.writeFile(path.join(temp, 'setup-bundles', setup.id + '.json'), JSON.stringify(setup), { mode: 0o600 })
            for (const item of setup.items.filter(i => i.artifact)) { const { data } = await artifactFile(item.artifact); await fs.writeFile(path.join(temp, 'setup-bundles', item.artifact.digest + '.tar.gz'), data, { mode: 0o600 }) }
          }
        }
        await fs.writeFile(path.join(temp, 'setup.sh'), recipe.setup)
        image = `${BUILT_PREFIX}${name}:${randomUUID()}`
        await buildImage(image, temp, engine, job, run, { networkNone: recipe.source === 'image' })
      } else {
        // OpenShell resolves the reference itself; check it once so a typo or
        // the wrong CPU architecture fails here rather than at launch.
        try { await run(['image', 'inspect', image], { engine }) } catch { await run(['pull', image], { job, engine, timeout: 30 * 60_000 }) }
      }
      await inspect(image, engine)
      if (job.cancelled) throw fail('Operation cancelled.')
      job.saving = true
      try { await saveTemplate(client, workspace, recipe, image, previous) } catch (e) {
        // Nothing points at an image whose template was never saved.
        if (recipe.source === 'build' || setups.length) await run(['image', 'rm', image], { engine }).catch(() => {})
        throw e
      }
      jobs.delete(key)
      // Other workspaces or gateways may still reference the previous Docker image.
      // Keep published images; only the unpublished failed build above is disposable.
    } catch (e) {
      job.status = 'failed'; job.error = e.message; job.saving = false
    } finally {
      if (temp) await fs.rm(temp, { recursive: true, force: true }).catch(() => {})
    }
  })()
  return jobView(job)
}

// OpenShell has no template update: replace means delete and recreate under
// the same name. Sandboxes already created keep running unchanged.
async function saveTemplate(client, workspace, recipe, image, previous) {
  const template = {
    metadata: { name: recipe.name, labels: { [LABEL]: 'v1' }, annotations: { [RECIPE_ANNOTATION]: JSON.stringify(storedRecipe(recipe)) } },
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
