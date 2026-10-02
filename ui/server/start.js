import { cloudRouter } from './cloud-proxy.js'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import connect from 'connect'
import serveStatic from 'serve-static'
import { createSessionRevocations } from './session-revocations.js'
import { openshellApi } from './api.js'
import { CLOUD_UNRELEASED, createSecurity, releaseConfig, requestPath } from './security.js'

export async function createConsoleServer({ config = releaseConfig(), auth, machines, handoffs, connections, dist = path.resolve(import.meta.dirname, '../dist') } = {}) {
  if (config.mode === 'cloud' && !(auth && machines && handoffs && connections)) throw Error(CLOUD_UNRELEASED)
  if (!fs.existsSync(path.join(dist, 'index.html'))) throw Error('Build the UI with npm run build before starting the server')
  const revocations = config.mode === 'cloud' ? createSessionRevocations(path.resolve(import.meta.dirname, '../.state/sessions.sqlite')) : undefined
  const security = createSecurity(config, auth, revocations)
  const app = connect()
  const server = http.createServer(app)
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('X-Frame-Options', 'DENY')
    if (config.mode === 'cloud') {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000')
      res.setHeader('Cross-Origin-Opener-Policy', new URL(req.url, 'http://local').searchParams.get('handoff') === '1' ? 'unsafe-none' : 'same-origin-allow-popups')
      res.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self' https://apis.google.com; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self' wss://${new URL(config.origin).host} https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://www.googleapis.com https://${config.firebase.authDomain}; frame-src https://${config.firebase.authDomain}; object-src 'none'; base-uri 'self'; frame-ancestors 'none'`)
    }
    next()
  })
  if (config.mode === 'cloud') {
    const routes = cloudRouter(security, machines, handoffs, auth, {connections})
    app.use(routes.publicRoutes)
    app.use(security.middleware)
    app.use(routes.protectedRoutes)
    server.on('upgrade', routes.upgrade)
  } else openshellApi(security).configureServer({ middlewares: app, httpServer: server, config: { logger: { info: console.info } } })
  app.use('/healthz', (req, res) => { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ready') })
  const upgradePaths = config.mode === 'cloud'
    ? ['/api/os/terminal', '/api/cloud/local-connect/os/terminal', '/api/cloud/local-connect/os/ssh']
    : config.mode === 'local' ? ['/api/os/terminal', '/api/os/ssh', '/api/remote/os/terminal', '/api/remote/os/ssh'] : ['/api/os/terminal', '/api/os/ssh']
  server.on('upgrade', (req, socket) => {
    try { if (!upgradePaths.includes(requestPath(req))) socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n') }
    catch { /* The API upgrade handler rejects malformed targets. */ }
  })
  app.use(serveStatic(dist, { index: 'index.html', dotfiles: 'deny', maxAge: 0 }))
  app.use((req, res) => { res.writeHead(404); res.end('Not found') })
  server.once('close', () => revocations?.close())
  server.requestTimeout = 35 * 60000
  server.headersTimeout = 15000
  return server
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const server = await createConsoleServer()
    const port = Number(process.env.OPENROD_PORT ?? 4600)
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error('OPENROD_PORT must be between 1024 and 65535')
    const address = process.env.OPENROD_MODE === 'worker' ? '0.0.0.0' : '127.0.0.1'
    // Local mode prints only the tokened link (from the API plugin); a bare URL would just hit the token wall.
    const mode = process.env.OPENROD_MODE ?? 'local'
    server.listen(port, address, () => { if (mode !== 'local') console.info(`OpenRod ${mode} console listening on ${address}:${port}`) })
    for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { server.closeAllConnections(); server.close(() => process.exit(0)); setTimeout(() => process.exit(1), 5000).unref() })
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
