import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { newRecipe, recipeErrors, dockerfileFor } from '../src/lib/image-templates.js'
import { resolveGateway } from './gateway.js'

const ROOT = process.env.OPENSHELL_IMAGE_TEMPLATE_DIR || path.resolve(import.meta.dirname, '../.state/image-templates')
// Vite reloads server modules during development. Jobs must survive a module
// reload; only a real process restart makes an on-disk operation interrupted.
const stateKey = Symbol.for('openshell.console.image-template-jobs')
const processState = globalThis[stateKey] ??= { active: new Map(), locks: new Set() }
const { active, locks } = processState
const validId = (id) => /^[a-f0-9-]{36}$/.test(id)
const fail = (message, status = 400) => Object.assign(new Error(message), { status })
async function locked(id, task) {
  if (locks.has(id)) throw fail('An operation is already starting for this template.', 409)
  locks.add(id)
  try { return await task() } finally { locks.delete(id) }
}
const fileFor = (id) => { if (!validId(id)) throw fail('Unknown image template.', 404); return path.join(ROOT, `${id}.json`) }
async function save(record) {
  await fs.mkdir(ROOT, { recursive: true })
  const file = fileFor(record.id)
  const temp = `${file}.${randomUUID()}.tmp`
  await fs.writeFile(temp, JSON.stringify(record, null, 2), { mode: 0o600 })
  await fs.rename(temp, file)
  return record
}
export async function readImageTemplate(id) {
  let record
  try { record = JSON.parse(await fs.readFile(fileFor(id), 'utf8')) } catch (e) { if (e.code === 'ENOENT') throw fail('Image template not found.', 404); throw e }
  if (active.has(id)) return active.get(id).record
  if (['building', 'importing'].includes(record.status)) return { ...record, status: 'failed', error: 'The server stopped before this operation finished. Retry to continue.' }
  return record
}
export async function listImageTemplates() {
  let files
  try { files = await fs.readdir(ROOT) } catch (e) { if (e.code === 'ENOENT') return []; throw e }
  const records = await Promise.all(files.filter((f) => f.endsWith('.json')).map((f) => readImageTemplate(f.slice(0, -5))))
  return records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}
function run(args, { job, cwd, engine, timeout = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    if (job?.cancelled) return reject(fail('Operation cancelled.'))
    const host = engine?.endpoint || job?.engine?.endpoint
    const env = { ...process.env }
    if (host) { delete env.DOCKER_CONTEXT; delete env.DOCKER_HOST }
    const child = spawn('docker', host ? ['--host', host, ...args] : args, { cwd, env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
    if (job) job.child = child
    let output = ''
    let timedOut = false
    const append = (chunk) => {
      const clean = chunk.toString().replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
      output = (output + clean).slice(-100_000)
      if (job) job.record.logs = (job.record.logs + clean).slice(-100_000)
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
  if (target.remote) throw fail('Image builds and imports currently require a local gateway.')
  const context = JSON.parse(await run(['context', 'inspect']))[0]
  const endpoint = process.env.DOCKER_HOST || context?.Endpoints?.docker?.Host
  if (!endpoint?.startsWith('unix://')) throw fail('Select a local Docker context to build or import images.')
  const info = JSON.parse(await run(['info', '--format', '{{json .}}'], { engine: { endpoint } }))
  if (info.OSType !== 'linux') throw fail('Linux containers are required.')
  return { context: context.Name, endpoint, architecture: info.Architecture === 'aarch64' ? 'arm64' : info.Architecture === 'x86_64' ? 'amd64' : info.Architecture }
}
async function inspect(reference, engine) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]{0,255}$/.test(reference)) throw fail('Invalid image reference.')
  const image = JSON.parse(await run(['image', 'inspect', reference], { engine }))[0]
  if (image.Os !== 'linux') throw fail('Choose a Linux container image.')
  if (image.Architecture !== engine.architecture) throw fail(`This image is ${image.Architecture}; the local engine uses ${engine.architecture}. Import a matching image.`)
  return { imageId: image.Id, architecture: image.Architecture, size: image.Size, user: image.Config?.User || 'root', workdir: image.Config?.WorkingDir || '/', checkedAt: new Date().toISOString(), context: engine.context }
}
export async function imageTemplateForLaunch(id) {
  const record = await readImageTemplate(id)
  if (record.status !== 'available' || !record.inspection?.imageId) throw fail('Build or import this image template before launching.')
  const engine = await localEngine()
  if (record.inspection.context !== engine.context) throw fail('This image was saved in a different Docker context. Import it in the current context before launching.')
  await inspect(record.inspection.imageId, engine)
  const errors = recipeErrors(record.recipe)
  if (Object.keys(errors).length) throw fail('This recipe is invalid. Edit it before launching.')
  return record
}
async function inventory() {
  try {
    const engine = await localEngine()
    const result = await run(['image', 'ls', '--format', '{{json .}}'], { engine })
    const images = result.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)).filter((i) => i.Repository !== '<none>' && i.Tag !== '<none>').map((i) => ({ reference: `${i.Repository}:${i.Tag}`, size: i.Size, id: i.ID }))
    return { context: engine.context, architecture: engine.architecture, images }
  } catch (e) { return { error: e.message, images: [] } }
}
async function saveDraft(input) {
  if (!input?.recipe || typeof input.recipe !== 'object' || Array.isArray(input.recipe)) throw fail('An image recipe is required.')
  if (input.id && active.has(input.id)) throw fail('Wait for the current operation to finish.', 409)
  const recipe = newRecipe(Object.fromEntries(Object.keys(newRecipe()).filter((key) => key in input.recipe).map((key) => [key, input.recipe[key]])))
  for (const key of ['name', 'description', 'source', 'base', 'image', 'repository', 'setup', 'command']) if (typeof recipe[key] !== 'string') throw fail(`Invalid ${key}.`)
  for (const key of ['packages', 'runtimes', 'agents', 'npm', 'pip']) if (!Array.isArray(recipe[key]) || recipe[key].length > 80 || recipe[key].some((v) => typeof v !== 'string' || v.length > 200)) throw fail(`Invalid ${key}.`)
  if (!Array.isArray(recipe.files) || recipe.files.length > 20 || recipe.files.some((f) => !f || typeof f.path !== 'string' || typeof f.content !== 'string' || f.path.length > 200 || f.content.length > 16000)) throw fail('Invalid starting files.')
  if (!Array.isArray(recipe.environment) || recipe.environment.length > 40 || recipe.environment.some((e) => !e || typeof e.name !== 'string' || typeof e.value !== 'string' || e.name.length > 128 || e.value.length > 1000)) throw fail('Invalid environment variables.')
  if (recipe.description.length > 400 || recipe.setup.length > 12000 || recipe.command.length > 512 || recipe.repository.length > 2048 || recipe.image.length > 256) throw fail('One or more recipe fields are too long.')
  if (recipe.environment.some((e) => /secret|token|password|api_?key|credential|auth/i.test(e.name))) throw fail('Keep credentials in Secrets. Image templates accept non-secret variables only.')
  // Drafts may be incomplete; full validation runs before a build or import.
  if (typeof recipe.name !== 'string' || recipe.name.length > 80) throw fail('Template names are limited to 80 characters.')
  const previous = input.id ? await readImageTemplate(input.id) : null
  const record = { id: previous?.id || randomUUID(), recipe, status: 'draft', updatedAt: new Date().toISOString(), logs: '', image: null, inspection: null }
  return save(record)
}
async function start(id, archivePath) {
  if (active.has(id)) throw fail('An operation is already running for this template.', 409)
  if (active.size >= 2) throw fail('Two image operations are already running. Wait for one to finish.', 409)
  const record = await readImageTemplate(id)
  const errors = recipeErrors(record.recipe)
  if (Object.keys(errors).length) throw fail(Object.values(errors)[0])
  if (record.recipe.source === 'archive' && !archivePath) throw fail('Choose the image archive again to import it.')
  const engine = await localEngine()
  if (active.size >= 2) throw fail('Two image operations are already running. Wait for one to finish.', 409)
  record.status = record.recipe.source === 'wizard' ? 'building' : 'importing'
  record.logs = ''; record.error = null; record.image = null; record.inspection = null
  const job = { record, engine, cancelled: false, child: null }
  active.set(id, job)
  try { await save(record) } catch (e) { active.delete(id); throw e }
  void (async () => {
    let temp
    try {
      const recipe = record.recipe
      let image = recipe.image
      if (recipe.source === 'wizard') {
        temp = await fs.mkdtemp(path.join(os.tmpdir(), 'openshell-image-'))
        await fs.mkdir(path.join(temp, 'files'))
        await fs.writeFile(path.join(temp, 'Dockerfile'), dockerfileFor(recipe))
        await fs.writeFile(path.join(temp, 'setup.sh'), recipe.setup)
        await Promise.all(recipe.files.map((f, i) => fs.writeFile(path.join(temp, 'files', String(i)), f.content)))
        image = `openshell-template:${id}`
        await run(['build', '--progress=plain', '--tag', image, temp], { job, timeout: 30 * 60_000 })
      } else if (recipe.source === 'registry') {
        await run(['pull', image], { job, timeout: 30 * 60_000 })
      } else if (recipe.source === 'archive') {
        const output = await run(['image', 'load', '--input', archivePath], { job, timeout: 30 * 60_000 })
        const refs = [...output.matchAll(/^Loaded image(?: ID)?: (.+)$/gm)].map((m) => m[1].trim())
        if (refs.length !== 1) throw fail('The archive was loaded, but contains multiple images or no identifiable image. Choose the image from “Local image” to save a template.')
        image = refs[0]
      }
      record.inspection = await inspect(image, engine)
      if (job.cancelled) throw fail('Operation cancelled.')
      record.image = image
      record.status = 'available'
      record.logs += '\nImage available locally. Linux and architecture checked; sandbox runtime has not been tested.\n'
    } catch (e) { record.status = 'failed'; record.error = e.message }
    finally {
      record.updatedAt = new Date().toISOString()
      try { await save(record) } catch (e) { record.status = 'failed'; record.error = `Could not save the result: ${e.message}` }
      if (temp) await fs.rm(temp, { recursive: true, force: true }).catch(() => {})
      if (archivePath) await fs.rm(path.dirname(archivePath), { recursive: true, force: true }).catch(() => {})
      active.delete(id)
    }
  })()
  return record
}

// Stream archives to disk; never buffer multi-GB uploads in the JSON parser.
export async function importImageArchive(req, id) {
  return locked(id, () => receiveImageArchive(req, id))
}
async function receiveImageArchive(req, id) {
  if (Number(req.headers['content-length']) > 4 * 1024 ** 3) throw fail('Image archives must be smaller than 4 GB.', 413)
  const record = await readImageTemplate(id)
  if (record.recipe.source !== 'archive') throw fail('This template is not an archive import.')
  if (active.has(id)) throw fail('This template already has an operation running.', 409)
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'openshell-upload-'))
  const archive = path.join(temp, 'image.tar')
  let handle
  try {
    handle = await fs.open(archive, 'wx', 0o600)
    let size = 0
    for await (const chunk of req) {
      size += chunk.length
      if (size > 4 * 1024 ** 3) throw fail('Image archives must be smaller than 4 GB.', 413)
      await handle.writeFile(chunk)
    }
    await handle.close(); handle = null
    if (!size) throw fail('The image archive is empty.')
    return await start(id, archive)
  } catch (e) {
    await handle?.close().catch(() => {})
    await fs.rm(temp, { recursive: true, force: true })
    throw e
  }
}

export async function imageTemplateRoute(method, parts, input) {
  const [area, id, action] = parts
  if (area !== 'image-templates') return undefined
  if (method === 'GET') {
    if (!id) return listImageTemplates()
    if (id === 'local-images') return inventory()
    return readImageTemplate(id)
  }
  if (!id) return locked(input?.id || randomUUID(), () => saveDraft(input))
  if (action === 'build') return locked(id, () => start(id))
  if (action === 'cancel') {
    const job = active.get(id)
    if (job) { job.cancelled = true; job.child?.kill('SIGKILL') }
    return { ok: true }
  }
  if (action === 'delete') {
    return locked(id, async () => {
      if (active.has(id)) throw fail('Cancel the operation before removing this template.', 409)
      await fs.rm(fileFor(id), { force: true })
      // Removing a recipe never deletes a Docker image or a running sandbox.
      return { ok: true }
    })
  }
  throw fail('Unknown image template operation.', 404)
}
