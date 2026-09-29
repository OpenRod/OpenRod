import fs from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { CONFIG_DIR, gateway } from './gateway.js'
import { SANDBOX_ROOT, TRANSFER_LIMIT, downloadCommand, formatBytes } from '../src/lib/files.js'

const fail = (message, status = 400) => Object.assign(new Error(message), { status })
const NAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/
const ID = /^[a-f0-9-]{36}$/
// Gateway label values: the folder name becomes one when it fits.
const LABEL_VALUE = /^[A-Za-z0-9]([A-Za-z0-9._-]{0,61}[A-Za-z0-9])?$/
const MAX_FILES = 50_000
const MAX_ENTRIES = 2000
const HOME = os.homedir()

// Vite reloads server modules during development; transfers in flight must survive that.
const state = globalThis[Symbol.for('openshell.console.files')] ??= { seeds: new Map(), batches: new Map(), downloads: new Map() }

// ---- processes --------------------------------------------------------------

function run(command, args, { cwd, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
    const out = []
    let err = ''
    child.stdout.on('data', (chunk) => out.push(chunk))
    child.stderr.on('data', (chunk) => { err = (err + chunk).slice(-4000) })
    child.once('error', reject)
    child.once('close', (code) => (code === 0 ? resolve(Buffer.concat(out).toString('utf8')) : reject(fail(err.trim() || `${command} exited with ${code}.`, 500))))
  })
}

// miette prints "Error:   × message" and wraps the rest onto "│ …" lines.
export function cliError(output) {
  const lines = output.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').split('\n')
  const start = lines.findIndex((line) => line.includes('×'))
  if (start < 0) return lines.map((line) => line.trim()).filter(Boolean).slice(-3).join(' ') || 'The openshell CLI failed.'
  const message = [lines[start].slice(lines[start].indexOf('×') + 1)]
  for (const line of lines.slice(start + 1)) {
    const more = /^\s*│(.*)$/.exec(line)
    if (!more) break
    message.push(more[1])
  }
  return message.map((part) => part.trim()).filter(Boolean).join(' ')
}

// Transfers go through the `openshell` CLI: tar over the gateway's SSH relay,
// with its .gitignore filter and its guards (only /sandbox; symlinks travel as
// links; a link that leaves /sandbox is refused). The SDK's exec takes at most
// 4 MiB of stdin, so exec is used only to look at folders.
async function openshell(args, { cwd, timeout = 15 * 60_000 } = {}) {
  const { target } = await gateway()
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.OPENSHELL_BIN || 'openshell', ['--gateway', target.name, ...args], {
      cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NO_COLOR: '1' },
    })
    let output = ''
    const append = (chunk) => { output = (output + chunk).slice(-20_000) }
    child.stdout.on('data', append)
    child.stderr.on('data', append)
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout)
    child.once('error', (error) => { clearTimeout(timer); reject(fail(error.code === 'ENOENT' ? 'The openshell CLI is not installed on this computer.' : error.message, 500)) })
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      if (code === 0) resolve(output)
      else reject(fail(signal ? 'The transfer timed out.' : cliError(output), 502))
    })
  })
}

// ---- inside the sandbox -------------------------------------------------------

export function sandboxPath(input) {
  const raw = typeof input === 'string' && input ? input : SANDBOX_ROOT
  if (!raw.startsWith('/') || raw.length > 4096 || raw.includes('\0')) throw fail('Use an absolute path under /sandbox.')
  const clean = path.posix.normalize(raw).replace(/(.)\/+$/, '$1')
  if (clean !== SANDBOX_ROOT && !clean.startsWith(`${SANDBOX_ROOT}/`)) throw fail('Only /sandbox is available here.')
  return clean
}

// Follow symlinks inside the sandbox and refuse anything that lands outside
// /sandbox, the same check `openshell sandbox download` makes.
const RESOLVE = `r=$(realpath -e -- "$1" 2>/dev/null) || exit 3
case "$r" in /sandbox|/sandbox/*) ;; *) exit 4 ;; esac`
const EXITS = { 3: ['That path does not exist.', 404], 4: ['That path leads outside /sandbox.', 403], 5: ['That is not a folder.', 400] }

async function inSandbox(name, script, arg) {
  const { client } = await gateway()
  const result = await client.sandbox.exec(name, ['/bin/sh', '-c', `${RESOLVE}\n${script}`, 'sh', arg], { noLoginShell: true, timeoutSecs: 30 })
  if (EXITS[result.exitCode]) throw fail(...EXITS[result.exitCode])
  if (result.exitCode !== 0) throw fail(result.stderr.toString().trim().slice(-400) || `The sandbox command exited with ${result.exitCode}.`, 502)
  return result.stdout.toString('utf8').split('\0').slice(0, -1)
}

// Free space in KiB; awk would print large byte counts in exponent form.
const FREE = `printf '%s\\0' "$(df -Pk "$r" | awk 'NR == 2 { print $4 }')"`
const TYPES = { f: 'file', d: 'dir', l: 'link' }

async function list(name, input) {
  const [resolved, free, ...fields] = await inSandbox(name, `[ -d "$r" ] || exit 5
printf '%s\\0' "$r"
${FREE}
find "$r" -mindepth 1 -maxdepth 1 -printf '%y\\0%Y\\0%s\\0%T@\\0%l\\0%f\\0' | head -z -n ${(MAX_ENTRIES + 1) * 6}`, sandboxPath(input))
  const entries = []
  for (let i = 0; i + 5 < fields.length; i += 6) {
    const [type, targetType, size, modified, target, entry] = fields.slice(i, i + 6)
    entries.push({
      name: entry,
      type: TYPES[type] ?? 'other',
      // What a symlink points at, and whether that is a folder (N: missing, L: loop).
      target: type === 'l' ? target : null,
      targetType: type === 'l' ? (TYPES[targetType] ?? (targetType === 'N' ? 'missing' : 'other')) : null,
      size: type === 'f' ? Number(size) : null,
      modifiedAt: new Date(Number(modified) * 1000).toISOString(),
    })
  }
  const folder = (e) => e.type === 'dir' || e.targetType === 'dir'
  entries.sort((a, b) => Number(folder(b)) - Number(folder(a)) || a.name.localeCompare(b.name))
  return { path: resolved, free: Number(free) * 1024, truncated: entries.length > MAX_ENTRIES, entries: entries.slice(0, MAX_ENTRIES) }
}

// ---- download -----------------------------------------------------------------

// The CLI copies into a temporary folder here; the browser then fetches the
// result once by token, and the folder is removed.
async function prepareDownload(name, input) {
  const target = sandboxPath(input)
  const [kind, size] = await inSandbox(name, `if [ -d "$r" ]; then printf 'dir\\0'; else printf 'file\\0'; fi
printf '%s\\0' "$(du -sb -- "$r" | cut -f1)"`, target)
  if (Number(size) > TRANSFER_LIMIT) throw fail(`That is ${formatBytes(Number(size))}; the console moves up to ${formatBytes(TRANSFER_LIMIT)}. From a terminal: ${downloadCommand(name, target)}`, 413)
  const base = target === SANDBOX_ROOT ? 'sandbox' : path.posix.basename(target)
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'openshell-download-'))
  try {
    const local = path.join(temp, base)
    await openshell(['sandbox', 'download', name, target, local])
    let file = local
    let filename = base
    if (kind === 'dir') {
      filename = `${base}.tar.gz`
      file = path.join(temp, filename)
      await run('tar', ['-czf', file, '-C', temp, base])
    }
    const { size: bytes } = await fs.stat(file)
    const token = randomUUID()
    const timer = setTimeout(() => discardDownload(token), 10 * 60_000)
    timer.unref?.()
    state.downloads.set(token, { file, filename, temp, bytes, timer })
    return { token, filename, bytes }
  } catch (error) {
    await fs.rm(temp, { recursive: true, force: true })
    throw error
  }
}

function discardDownload(token) {
  const item = state.downloads.get(token)
  if (!item) return
  state.downloads.delete(token)
  clearTimeout(item.timer)
  fs.rm(item.temp, { recursive: true, force: true }).catch(() => {})
}

const disposition = (filename) => `attachment; filename="${filename.replace(/[^\x20-\x7e]|["\\]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(filename)}`

export function serveDownload(res, token) {
  const item = ID.test(token ?? '') ? state.downloads.get(token) : null
  if (!item) {
    res.writeHead(404, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' })
    res.end('This download has expired. Start it again from the Files tab.')
    return
  }
  state.downloads.delete(token)
  clearTimeout(item.timer)
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': item.bytes,
    'Content-Disposition': disposition(item.filename),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  createReadStream(item.file).pipe(res)
  res.once('close', () => fs.rm(item.temp, { recursive: true, force: true }).catch(() => {}))
}

// ---- upload from the browser ----------------------------------------------------

// Dropped files are staged one request per file, then sent with one CLI call.
async function startUpload(name) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'openshell-upload-'))
  // Uploading "." extracts the staged entries flat into the target folder,
  // and the archive's "./" entry carries this folder's mode, so keep it 755.
  const root = path.join(temp, 'files')
  await fs.mkdir(root)
  await fs.chmod(root, 0o755)
  const id = randomUUID()
  state.batches.set(id, { sandbox: name, temp, root, files: 0, bytes: 0, touched: Date.now(), committing: false })
  return { id }
}

function batchFor(name, id) {
  const batch = ID.test(id ?? '') ? state.batches.get(id) : null
  if (!batch || batch.sandbox !== name) throw fail('That upload has expired. Drop the files again.', 404)
  if (batch.committing) throw fail('That upload is already being sent.', 409)
  batch.touched = Date.now()
  return batch
}

function relativeParts(value) {
  const parts = String(value ?? '').split('/')
  if (!value || value.length > 1024 || parts.length > 64 || parts.some((p) => !p || p === '.' || p === '..' || p.length > 255 || p.includes('\0'))) throw fail('Invalid file name.')
  return parts
}

export async function receiveUpload(req, name, id, relative) {
  const batch = batchFor(name, id)
  const parts = relativeParts(relative)
  if (batch.files >= MAX_FILES) throw fail(`Upload up to ${MAX_FILES.toLocaleString()} files at a time.`, 413)
  if (batch.bytes + (Number(req.headers['content-length']) || 0) > TRANSFER_LIMIT) throw fail(`The console uploads up to ${formatBytes(TRANSFER_LIMIT)} at a time. Use the terminal command for more.`, 413)
  const file = path.join(batch.root, ...parts)
  await fs.mkdir(path.dirname(file), { recursive: true })
  let handle
  try {
    handle = await fs.open(file, 'wx', 0o644)
    batch.files += 1
    for await (const chunk of req) {
      batch.bytes += chunk.length
      if (batch.bytes > TRANSFER_LIMIT) throw fail(`The console uploads up to ${formatBytes(TRANSFER_LIMIT)} at a time. Use the terminal command for more.`, 413)
      await handle.write(chunk)
    }
  } catch (error) {
    if (error.code === 'EEXIST') throw fail(`${relative} was dropped twice.`, 409)
    throw error
  } finally {
    await handle?.close()
  }
  return { ok: true }
}

async function commitUpload(name, id, input) {
  const batch = batchFor(name, id)
  if (!batch.files) throw fail('Nothing was uploaded.')
  batch.committing = true
  try {
    // Upload into the real folder, never through a link that leaves /sandbox.
    const [dest, free] = await inSandbox(name, `[ -d "$r" ] || exit 5
printf '%s\\0' "$r"
${FREE}`, sandboxPath(input?.dir))
    if (batch.bytes > Number(free) * 1024) throw fail(`The sandbox has ${formatBytes(Number(free) * 1024)} free; this upload is ${formatBytes(batch.bytes)}.`, 413)
    await openshell(['sandbox', 'upload', '--no-git-ignore', name, '.', dest], { cwd: batch.root })
    return { files: batch.files, bytes: batch.bytes, dest }
  } finally {
    discardBatch(id)
  }
}

function discardBatch(id) {
  const batch = state.batches.get(id)
  if (!batch) return
  state.batches.delete(id)
  fs.rm(batch.temp, { recursive: true, force: true }).catch(() => {})
}

// Abandoned uploads (a closed tab mid-drop) are cleared after an hour.
if (!state.sweeper) {
  state.sweeper = setInterval(() => {
    for (const [id, batch] of state.batches) if (!batch.committing && Date.now() - batch.touched > 60 * 60_000) discardBatch(id)
  }, 10 * 60_000)
  state.sweeper.unref?.()
}

// ---- a local folder, for New sandbox -------------------------------------------

// Files the agent can read once uploaded; worth a second look before sending.
const SECRETISH = /^(\.env(\.(?!example$|sample$|template$)[\w.-]+)?|id_(rsa|dsa|ecdsa|ed25519)|\.npmrc|\.pypirc|\.netrc|credentials(\.json)?|.+\.(pem|key|p12|pfx|jks|keystore|tfstate))$/i
const gitEnv = () => Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')))

// Counts what the CLI will send, without following symlinks. Stops early once
// a limit is passed; `over` then says the total is at least that much.
async function measure(base, relatives, totals) {
  for (let i = 0; i < relatives.length && !totals.over; i += 256) {
    const stats = await Promise.all(relatives.slice(i, i + 256).map((rel) => fs.lstat(path.join(base, rel)).then((stat) => [rel, stat], () => null)))
    for (const [rel, stat] of stats.filter(Boolean)) {
      if (stat.isDirectory()) {
        const children = (await fs.readdir(path.join(base, rel))).map((child) => path.join(rel, child))
        await measure(base, children, totals)
      } else {
        totals.files += 1
        if (stat.isSymbolicLink()) totals.links += 1
        else totals.bytes += stat.size
        if (totals.secrets.length < 50 && SECRETISH.test(path.basename(rel))) totals.secrets.push(rel)
      }
      if (totals.bytes > TRANSFER_LIMIT || totals.files > MAX_FILES) { totals.over = true; return totals }
    }
  }
  return totals
}

export async function localFolder(input) {
  let raw = typeof input === 'string' ? input.trim() : ''
  if (!raw) throw fail('Enter a folder path.')
  if (raw === '~' || raw.startsWith('~/')) raw = path.join(HOME, raw.slice(1))
  if (!path.isAbsolute(raw)) throw fail('Use a full path, or one starting with ~/.')
  let real
  try { real = await fs.realpath(raw) } catch { throw fail('That folder does not exist on this computer.') }
  if (!(await fs.stat(real)).isDirectory()) throw fail('Choose a folder, not a file.')
  const home = await fs.realpath(HOME)
  const relative = path.relative(home, real)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw fail('Choose a folder inside your home folder.')
  // Keys and tokens live in hidden folders (~/.ssh, ~/.aws, ~/.config holds
  // this gateway's certificate) and, on a Mac, in ~/Library.
  const parts = relative.split(path.sep)
  if (parts.some((part) => part.startsWith('.')) || (process.platform === 'darwin' && parts[0] === 'Library')) throw fail('Hidden folders (such as ~/.ssh or ~/.config) and ~/Library are never uploaded.')
  const config = await fs.realpath(CONFIG_DIR).catch(() => null)
  if (config && (config === real || config.startsWith(real + path.sep))) throw fail('This folder holds the gateway certificate.')

  // Mirror the CLI: inside a git work tree it sends `git ls-files -co
  // --exclude-standard` (tracked plus untracked, minus ignored); elsewhere, everything.
  const totals = { files: 0, bytes: 0, links: 0, secrets: [], over: false }
  let filter = 'none'
  let git = 'none'
  let gitBytes = 0
  const root = await run('git', ['-C', real, 'rev-parse', '--show-toplevel'], { env: gitEnv() }).then((out) => out.trim(), () => null)
  if (root) {
    const repo = await fs.realpath(root)
    const inRepo = path.relative(repo, real)
    const listed = (await run('git', ['ls-files', '-co', '--exclude-standard', '-z', ...(inRepo ? ['--', inRepo] : [])], { cwd: repo, env: gitEnv() }))
      .split('\0').filter(Boolean).map((file) => (inRepo ? path.relative(inRepo, file) : file)).filter(Boolean)
    filter = listed.length ? 'gitignore' : 'gitignore-empty'
    await measure(real, listed.length ? listed : await fs.readdir(real), totals)
    // The filter never lists .git itself, so history is sent separately.
    const dotGit = inRepo ? null : await fs.lstat(path.join(real, '.git')).catch(() => null)
    git = inRepo ? 'subfolder' : dotGit?.isDirectory() ? 'included' : 'worktree'
    if (git === 'included' && !totals.over) {
      const history = await measure(real, ['.git'], { files: 0, bytes: 0, links: 0, secrets: [], over: false })
      gitBytes = history.bytes
      totals.over = history.over || totals.bytes + gitBytes > TRANSFER_LIMIT
    }
  } else {
    await measure(real, await fs.readdir(real), totals)
  }

  const name = path.basename(real)
  return {
    path: real,
    display: `~/${relative}`,
    name,
    dest: `${SANDBOX_ROOT}/${name}`,
    // The folder a session opens in, when its name can be a gateway label.
    project: LABEL_VALUE.test(name) ? name : null,
    files: totals.files,
    bytes: totals.bytes,
    links: totals.links,
    filter,
    git,
    gitBytes,
    secrets: totals.secrets.slice(0, 5),
    secretCount: totals.secrets.length,
    over: totals.over,
    limit: TRANSFER_LIMIT,
  }
}

function repository(input) {
  let url
  try { url = new URL(String(input ?? '').trim()) } catch { throw fail('Enter an https:// git URL.') }
  if (url.protocol !== 'https:' || !url.hostname) throw fail('Enter an https:// git URL.')
  if (url.username || url.password) throw fail('Keep credentials out of the URL. Only public repositories can be cloned for now.')
  if (url.search || url.hash) throw fail('Remove the ? or # part of the URL.')
  const segment = url.pathname.split('/').filter(Boolean).pop()?.replace(/\.git$/, '') ?? ''
  if (!segment) throw fail('That URL has no repository name.')
  const name = LABEL_VALUE.test(segment) ? segment : 'repo'
  return { url: url.href, name, project: name, dest: `${SANDBOX_ROOT}/${name}` }
}

// ---- starting a sandbox with files ----------------------------------------------

// Checked before the sandbox is created, so a bad path never leaves a sandbox behind.
export async function planSeed(input) {
  if (input.folder && input.repository) throw fail('Choose a folder or a repository, not both.')
  if (input.folder) {
    const plan = await localFolder(input.folder)
    if (plan.over) throw fail(`${plan.display} is over ${formatBytes(TRANSFER_LIMIT)}. Add a .gitignore, or upload it from a terminal.`, 413)
    return { kind: 'folder', source: plan.display, dest: plan.dest, project: plan.project, folder: plan }
  }
  if (input.repository) {
    const repo = repository(input.repository)
    return { kind: 'repository', source: repo.url, dest: repo.dest, project: repo.project, repo }
  }
  return null
}

function cloneError(stderr) {
  const text = stderr.trim()
  if (/could not read Username|Authentication failed|terminal prompts disabled/i.test(text)) return 'The repository asks for credentials. Only public repositories can be cloned for now.'
  if (/\b403\b|CONNECT tunnel failed|Failed to connect|Could not resolve (host|proxy)|Connection refused|Proxy/i.test(text)) {
    return 'The network policy blocked the clone. Allow git to reach the host in Egress (cloning also needs POST to /git-upload-pack), then retry.'
  }
  return text.split('\n').slice(-3).join(' ') || 'git clone failed.'
}

async function runSeed(name, seed) {
  const job = { kind: seed.kind, source: seed.source, dest: seed.dest, state: 'waiting', error: null, startedAt: new Date().toISOString(), finishedAt: null, seed }
  state.seeds.set(name, job)
  try {
    const { client } = await gateway()
    await client.sandbox.waitReady(name, 600)
    if (seed.kind === 'folder') {
      job.state = 'uploading'
      // Re-read the folder: a retry may come long after the first attempt.
      const plan = seed.folder = await localFolder(seed.folder.path)
      if (plan.over) throw fail(`${plan.display} is now over ${formatBytes(TRANSFER_LIMIT)}.`, 413)
      await openshell(['sandbox', 'upload', name, plan.path, SANDBOX_ROOT])
      if (plan.git === 'included') await openshell(['sandbox', 'upload', '--no-git-ignore', name, path.join(plan.path, '.git'), `${plan.dest}/`])
      job.files = plan.files
      job.bytes = plan.bytes + plan.gitBytes
    } else {
      job.state = 'cloning'
      const result = await client.sandbox.exec(name, ['git', 'clone', '--', seed.repo.url, seed.repo.dest], { timeoutSecs: 900, environment: { GIT_TERMINAL_PROMPT: '0' } })
      if (result.exitCode !== 0) throw fail(cloneError(result.stderr.toString()))
    }
    job.state = 'done'
  } catch (error) {
    job.state = 'failed'
    job.error = error.rawMessage ?? error.message
  }
  job.finishedAt = new Date().toISOString()
}

export function startSeed(name, seed) {
  runSeed(name, seed)
}

const seedView = ({ seed, ...job }) => job

// ---- routes -----------------------------------------------------------------------

export async function filesRoute(method, parts, input, url) {
  if (method === 'POST' && parts[0] === 'local-folder' && parts.length === 1) {
    return localFolder(input?.path)
  }
  if (parts[0] !== 'files' || !NAME.test(parts[1] ?? '')) return undefined
  const [, name, area, id, action] = parts
  if (method === 'GET') {
    if (!area) return list(name, url.searchParams.get('path'))
    if (area === 'seed' && !id) { const job = state.seeds.get(name); return job ? seedView(job) : null }
    return undefined
  }
  if (area === 'download' && !id) return prepareDownload(name, input?.path)
  if (area === 'uploads' && !id) return startUpload(name)
  if (area === 'uploads' && action === 'commit') return commitUpload(name, id, input)
  if (area === 'uploads' && action === 'cancel') { batchFor(name, id); discardBatch(id); return { ok: true } }
  if (area === 'seed' && id === 'retry') {
    const job = state.seeds.get(name)
    if (!job) throw fail('This sandbox was not started with files by this console.', 404)
    if (job.state !== 'failed') throw fail('Only a failed start can be retried.', 409)
    runSeed(name, job.seed)
    return seedView(state.seeds.get(name))
  }
  return undefined
}
