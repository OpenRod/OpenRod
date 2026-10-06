#!/usr/bin/env node
import { createServer } from 'node:http'
import fs from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import { parseArgs } from 'node:util'

const HELP = `Usage: openrod [--host 127.0.0.1] [--port 4600] [--open | --no-open]

Serve OpenRod locally for local sandboxes or configured SSH hosts and
open it in your default browser. The link carries a secret that changes
on every start. Over SSH, in CI, without a display, or when the output is
not a terminal, the link is only printed.

  --host <host>  Loopback only: 127.0.0.1, localhost, or ::1
  --port <port>  HTTP port from 1 to 65535 (default: 4600)
  --open         Always open the console in your default browser
  --no-open      Only print the link
  --help, -h     Show this help
  --version, -v  Show the installed version

Mutable data: OPENSHELL_CONSOLE_DATA_DIR, or
  $XDG_STATE_HOME/openshell-console (~/.local/state/openshell-console).
Requires Node.js >=22.13.0. SSH hosts need local OpenSSH and OpenSSL,
plus a running Docker Engine on the remote Linux host.
If OpenShell is missing, openrod offers to install the pinned 0.1.2
release (macOS needs Homebrew). Connecting an SSH host downloads a missing
openshell-gateway executable, checksum-verified, on supported platforms.
`

export function nodeSupported(version = process.versions.node) {
  const [major, minor] = version.split('.').map(Number)
  return major > 22 || (major === 22 && minor >= 13)
}

// node:sqlite prints an ExperimentalWarning on every start. It is expected, so
// only that one is dropped; every other warning still prints as usual.
function quietSqliteWarning() {
  process.removeAllListeners('warning')
  process.on('warning', (warning) => {
    if (warning.name === 'ExperimentalWarning' && /SQLite/.test(warning.message)) return
    console.error(`(node:${process.pid}) ${warning.name}: ${warning.message}`)
  })
}

export function parseOptions(args = process.argv.slice(2)) {
  const { values } = parseArgs({ args, options: {
    host: { type: 'string', default: '127.0.0.1' },
    port: { type: 'string', default: '4600' },
    open: { type: 'boolean' }, 'no-open': { type: 'boolean' },
    help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' },
  } })
  if (!['127.0.0.1', 'localhost', '::1'].includes(values.host)) throw new Error('--host must be a loopback address: 127.0.0.1, localhost, or ::1.')
  if (!/^\d+$/.test(values.port) || Number(values.port) < 1 || Number(values.port) > 65535) throw new Error('--port must be an integer from 1 to 65535.')
  if (values.open && values['no-open']) throw new Error('Choose either --open or --no-open, not both.')
  return { host: values.host, port: Number(values.port), open: values.open ? true : values['no-open'] ? false : undefined, help: Boolean(values.help), version: Boolean(values.version) }
}

// Opening the page hands over the launch link without copying it, so it is the
// default. A session with no screen to open on only prints the link.
export function autoOpen({ env = process.env, platform = process.platform, tty = process.stdout.isTTY } = {}) {
  const set = (name) => Boolean(env[name]) && !['0', 'false'].includes(env[name].toLowerCase())
  if (!tty || set('CI') || env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY) return false
  return ['darwin', 'win32'].includes(platform) || Boolean(env.DISPLAY || env.WAYLAND_DISPLAY)
}

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf', '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm', '.map': 'application/json; charset=utf-8',
}

export function staticMiddleware(directory) {
  return async (req, res) => {
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405, { Allow: 'GET, HEAD' }).end(); return }
    let pathname
    try { pathname = decodeURIComponent((req.url ?? '/').split('?', 1)[0]) }
    catch { res.writeHead(400).end(); return }
    if (!pathname.startsWith('/') || pathname.includes('\\') || pathname.includes('\0') || pathname.split('/').some((part) => part.startsWith('.'))) {
      res.writeHead(400).end(); return
    }
    const resolveFile = async (relative) => {
      const file = await fs.realpath(path.join(directory, relative))
      if (!file.startsWith(`${directory}${path.sep}`)) return null
      const stat = await fs.stat(file)
      return stat.isFile() ? { file, stat } : null
    }
    let entry
    try { entry = await resolveFile(pathname === '/' ? 'index.html' : pathname.slice(1)) }
    catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error }
    if (!entry && !path.extname(pathname) && !pathname.startsWith('/assets/') && (req.headers.accept ?? '').includes('text/html')) entry = await resolveFile('index.html')
    if (!entry) { res.writeHead(404).end(); return }
    const { file, stat } = entry
    const etag = `W/"${stat.size.toString(16)}-${Math.trunc(stat.mtimeMs).toString(16)}"`
    const immutable = /^\/assets\/[^/]+-[\w-]{8,}\.[a-z\d]+$/i.test(pathname)
    const headers = {
      'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
      'X-Content-Type-Options': 'nosniff', ETag: etag,
    }
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers).end(); return }
    res.writeHead(200, { ...headers, 'Content-Length': stat.size })
    if (req.method === 'HEAD') { res.end(); return }
    const stream = createReadStream(file)
    stream.on('error', (error) => res.destroy(error))
    res.on('close', () => stream.destroy())
    stream.pipe(res)
  }
}

function openBrowser(url, logger) {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'rundll32' : 'xdg-open'
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url]
  const child = spawn(command, args, { stdio: 'ignore', detached: true })
  child.once('error', (error) => logger.warn(`Couldn’t open a browser (${error.message}). Open the link above.`))
  child.once('exit', (code) => { if (code) logger.warn(`Couldn’t open a browser (exit ${code}). Open the link above.`) })
  child.unref()
}

// The API authenticates these upgrades. The CLI must not destroy a cloud
// relay socket after that asynchronous handler has accepted responsibility.
export function rejectUnsupportedUpgrade(req, socket) {
  const pathname = (req.url ?? '').split('?', 1)[0]
  if (!['/api/os/terminal', '/api/os/ssh', '/api/remote/os/terminal', '/api/remote/os/ssh'].includes(pathname)) socket.destroy()
}

export async function startConsole(options = parseOptions([]), logger = console) {
  // The openrod command is the loopback console guarded by its launch token.
  // Cloud and worker deployments start server/start.js instead.
  if ((process.env.OPENROD_MODE ?? 'local') !== 'local') throw new Error('openrod runs the local console. Unset OPENROD_MODE, or start cloud and worker deployments with server/start.js.')
  const { host, port } = parseOptions(['--host', options.host ?? '127.0.0.1', '--port', String(options.port ?? 4600)])
  let directory
  try {
    directory = await fs.realpath(path.resolve(import.meta.dirname, '../dist'))
    await fs.access(path.join(directory, 'index.html'))
  } catch { throw new Error('Built frontend is missing. Run npm run build from the source checkout before starting or packaging the console.') }
  const { createOpenShellApi, isLocalApiRequest } = await import('./api.js')
  const { createSecurity } = await import('./security.js')
  const { createLaunchToken, tokenUrl } = await import('./launch-token.js')
  const token = createLaunchToken()
  const serveStatic = staticMiddleware(directory)
  const connections = new Set()
  let api
  const server = createServer((req, res) => {
    if (!isLocalApiRequest(req)) { res.writeHead(403).end(); return }
    const failed = (error) => {
      logger.error(`Request failed: ${error.message}`)
      if (res.headersSent) res.destroy(error)
      else res.writeHead(500, { 'Content-Type': 'text/plain' }).end('Request failed')
    }
    Promise.resolve(api.middleware(req, res, () => serveStatic(req, res))).catch(failed)
  })
  server.on('connection', (socket) => { connections.add(socket); socket.once('close', () => connections.delete(socket)) })
  // Bind before starting collectors, so a port collision has no side effects.
  await new Promise((resolve, reject) => {
    const error = (error) => {
      if (error.code === 'EADDRINUSE') reject(new Error(`Port ${port} is already in use on ${host}. Stop the other console or choose --port <port>.`))
      else reject(error)
    }
    server.once('error', error)
    server.listen(port, host === 'localhost' ? '127.0.0.1' : host, () => { server.off('error', error); resolve() })
  })
  try { api = createOpenShellApi({ httpServer: server, logger, token, security: createSecurity({ mode: 'local' }) }) }
  catch (error) { server.close(); throw error }
  server.on('upgrade', rejectUnsupportedUpgrade)
  let closing
  const close = () => {
    if (closing) return closing
    closing = (async () => {
      const apiClosed = api.close()
      const timer = setTimeout(() => { for (const socket of connections) socket.destroy() }, 5000)
      timer.unref()
      try { await Promise.all([apiClosed, new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))]) }
      finally { clearTimeout(timer) }
    })()
    return closing
  }
  // The link carries this launch's secret; it changes on every restart.
  const url = tokenUrl(host, port, token)
  logger.info(`OpenRod console (open this link): ${url}`)
  if (options.open) {
    // A fresh console first connects to its local gateway, so the page opens on it.
    await Promise.race([api.ready?.(), new Promise((resolve) => setTimeout(resolve, 5000).unref())])
    openBrowser(tokenUrl(host, port, api.launchCode?.() ?? token), logger)
  }
  return { server, url, close }
}

async function main() {
  const options = parseOptions()
  if (options.help) { process.stdout.write(HELP); return }
  if (options.version) { console.log(JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8')).version); return }
  if (!nodeSupported()) throw new Error(`OpenRod needs Node.js 22.13 or newer, and this is ${process.versions.node}. Install a current release from https://nodejs.org, then run it again.`)
  quietSqliteWarning()
  // Before the console starts, so the browser opens on a usable local gateway.
  try {
    const { offerOpenShellInstall } = await import('./openshell-install.js')
    if (await offerOpenShellInstall() === 'cancelled') { process.exitCode = 130; return }
  } catch (error) { console.warn(`Could not check for OpenShell: ${error.message}`) }
  const runtime = await startConsole({ ...options, open: options.open ?? autoOpen() })
  let stopping = false
  const shutdown = () => {
    if (stopping) return
    stopping = true
    runtime.close().catch((error) => { console.error(`Shutdown failed: ${error.message}`); process.exitCode = 1 })
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

if (process.argv[1] && import.meta.url === pathToFileURL(await fs.realpath(process.argv[1])).href) {
  main().catch((error) => { console.error(`openrod: ${error.message}`); process.exitCode = 1 })
}
