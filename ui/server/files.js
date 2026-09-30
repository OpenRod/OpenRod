import fs from 'node:fs/promises'
import { createReadStream, createWriteStream } from 'node:fs'
import { finished } from 'node:stream/promises'
import zlib from 'node:zlib'
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

// Uploads go through the `openshell` CLI: tar over the gateway's SSH relay,
// with its .gitignore filter. The SDK's exec takes at most 4 MiB of stdin, so
// it never carries an upload. Downloads stream out of exec instead (below):
// the CLI's download needs GNU `realpath -e` inside the sandbox, which the
// busybox images, OpenShell's default among them, do not have.
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
// /sandbox, the same check `openshell sandbox download` makes. Only what
// busybox has too: Alpine images (OpenShell's default) lack GNU's realpath -e,
// find -printf and head -z. The path is absolute, so no option can hide in it.
const RESOLVE = `[ -e "$1" ] || exit 3
r=$(realpath "$1" 2>/dev/null) || exit 3
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
const LIST_CAP = 1024 * 1024

// One stat call for the folder (batched by find), then one small loop for its
// symlinks. Names may hold anything but NUL and "/", so they come last on
// their line and a line that is not an entry continues the previous name.
const LIST = `[ -d "$r" ] || exit 5
printf '%s\\0' "$r"
${FREE}
find "$r" -mindepth 1 -maxdepth 1 -exec stat -c '%F|%s|%Y|%n' {} + 2>/dev/null | head -c ${LIST_CAP}
printf '\\0'
find "$r" -mindepth 1 -maxdepth 1 -type l -exec sh -c 'for f; do printf "%s\\0%s\\0%s\\0" "$f" "$(readlink "$f")" "$(stat -L -c %F "$f" 2>/dev/null || echo missing)"; done' sh {} + 2>/dev/null`
const kindOf = (text) => (text.startsWith('regular') ? 'file' : text === 'directory' ? 'dir' : text === 'symbolic link' ? 'link' : text === 'missing' ? 'missing' : 'other')
const ENTRY = /^(regular file|regular empty file|directory|symbolic link|character special file|block special file|fifo|socket)\|(\d+)\|(\d+)\|(.*)$/

// The fields inSandbox returns for LIST: the folder, its free KiB, the stat
// lines, then a (path, target, target kind) triple per symlink.
export function parseListing(fields) {
  const [resolved, free, stat = '', ...links] = fields
  const entries = []
  // stat ends its output with one newline, which is not part of the last name.
  for (const line of stat.replace(/\n$/, '').split('\n')) {
    const m = ENTRY.exec(line)
    if (m && m[4].startsWith(`${resolved}/`)) {
      const type = kindOf(m[1])
      entries.push({ name: m[4].slice(resolved.length + 1), type, target: null, targetType: null, size: type === 'file' ? Number(m[2]) : null, modifiedAt: new Date(Number(m[3]) * 1000).toISOString() })
    } else if (entries.length) entries.at(-1).name += `\n${line}`
  }
  for (let i = 0; i + 2 < links.length; i += 3) {
    const entry = entries.find((e) => e.type === 'link' && `${resolved}/${e.name}` === links[i])
    if (entry) { entry.target = links[i + 1]; entry.targetType = kindOf(links[i + 2]) }
  }
  const folder = (e) => e.type === 'dir' || e.targetType === 'dir'
  entries.sort((a, b) => Number(folder(b)) - Number(folder(a)) || a.name.localeCompare(b.name))
  return { path: resolved, free: Number(free) * 1024, truncated: entries.length > MAX_ENTRIES || stat.length >= LIST_CAP, entries: entries.slice(0, MAX_ENTRIES) }
}

async function list(name, input) {
  return parseListing(await inSandbox(name, LIST, sandboxPath(input)))
}

// ---- download -----------------------------------------------------------------

// Streams a command's stdout out of the sandbox into a local file, gzipped
// for a tar stream. Only what busybox has: `cat` for a file, `tar cf -` for
// a folder, whose symlinks travel as links.
async function pull(name, argv, file, { gzip = false } = {}) {
  const { client } = await gateway()
  const out = createWriteStream(file, { mode: 0o600 })
  const sink = gzip ? zlib.createGzip() : out
  if (gzip) sink.pipe(out)
  const write = (chunk) => new Promise((resolve, reject) => sink.write(chunk, (error) => (error ? reject(error) : resolve())))
  let stderr = ''
  let exit = null
  try {
    for await (const event of client.sandbox.execStream(name, argv, { noLoginShell: true, timeoutSecs: 900 })) {
      if (event.stream === 'stdout') await write(event.data)
      else if (event.stream === 'stderr') stderr = (stderr + event.data.toString()).slice(-400)
      else if (event.type === 'exit') exit = event.exitCode
    }
  } finally {
    sink.end()
    await finished(out).catch(() => {})
  }
  if (exit !== 0) throw fail(stderr.trim() || `The sandbox command exited with ${exit}.`, 502)
}

// The file or folder is staged in a temporary folder here; the browser then
// fetches it once by token, and the folder is removed.
async function prepareDownload(name, input) {
  const target = sandboxPath(input)
  const [resolved, kind, size] = await inSandbox(name, `printf '%s\\0' "$r"
if [ -d "$r" ]; then printf 'dir\\0'; else printf 'file\\0'; fi
printf '%s\\0' "$(du -sb "$r" | cut -f1)"`, target)
  if (Number(size) > TRANSFER_LIMIT) throw fail(`That is ${formatBytes(Number(size))}; the console moves up to ${formatBytes(TRANSFER_LIMIT)}. From a terminal: ${downloadCommand(name, target)}`, 413)
  // Named after what was clicked; a link is read through its real path.
  const base = target === SANDBOX_ROOT ? 'sandbox' : path.posix.basename(target)
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'openshell-download-'))
  try {
    const filename = kind === 'dir' ? `${base}.tar.gz` : base
    const file = path.join(temp, filename)
    if (kind === 'dir') {
      const entry = path.posix.basename(resolved)
      await pull(name, ['tar', 'cf', '-', '-C', path.posix.dirname(resolved), entry.startsWith('-') ? `./${entry}` : entry], file, { gzip: true })
    } else await pull(name, ['cat', resolved], file)
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
  createReadStream(item.file).once('error', () => res.destroy()).pipe(res)
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
  if (config && (config === real || config.startsWith(real + path.sep) || real.startsWith(config + path.sep))) throw fail('This folder holds the gateway certificate.')

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

function cloneError(stderr, exitCode) {
  const text = stderr.trim()
  if (exitCode === 127) return 'This image has no git. Pick an image with git installed, or upload a local folder instead.'
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
      if (result.exitCode !== 0) throw fail(cloneError(result.stderr.toString(), result.exitCode))
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
