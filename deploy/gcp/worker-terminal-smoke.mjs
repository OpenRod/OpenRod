import fs from 'node:fs'
import http from 'node:http'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { signWorkerRequest } from '../../ui/server/worker-auth.js'
import { workerAuthHeader } from '../../ui/server/cloud-deployment.js'

const [envFile, portValue, sandbox, workspace, option] = process.argv.slice(2)
if (!envFile || !/^[a-z0-9-]{1,63}$/.test(sandbox ?? '') || !/^[a-z0-9-]{1,19}$/.test(workspace ?? '') || (option && option !== '--agents')) throw Error('Usage: worker-terminal-smoke.mjs ENV_FILE PORT SANDBOX ISOLATED_WORKSPACE [--agents]')
const env = Object.fromEntries(fs.readFileSync(envFile, 'utf8').split('\n').filter(line => line && !line.startsWith('#') && line.includes('=')).map(line => {
  const at = line.indexOf('='), raw = line.slice(at + 1)
  return [line.slice(0, at), raw.startsWith('"') ? JSON.parse(raw) : raw]
}))
const port = Number(portValue)
if (env.OPENROD_MODE !== 'worker' || env.OPENSHELL_WORKSPACE !== workspace || workspace === 'default' || !Number.isInteger(port) || port < 1024 || port > 65535) throw Error('Use an isolated staging worker workspace and valid port')
const origin = new URL(env.OPENROD_PUBLIC_ORIGIN), authHeader = workerAuthHeader(env.OPENROD_WORKER_PROTOCOL, env)
const headersFor = (method, target, uid = env.OPENROD_WORKER_UID) => ({ host: origin.host, origin: origin.origin, 'x-openshell-console': '1', [authHeader]: signWorkerRequest(env.OPENROD_WORKER_KEY, { uid, expires: Date.now() + 60000 }, { method, url: target }) })
async function request(method, target, body, { raw = false, anonymous = false, uid } = {}) {
  const input = body === undefined ? undefined : Buffer.from(JSON.stringify(body))
  return new Promise((resolve, reject) => {
    const headers = headersFor(method, target, uid)
    if (anonymous) delete headers[authHeader]
    if (input) Object.assign(headers, { 'content-type': 'application/json', 'content-length': input.length })
    const req = http.request({ hostname: '127.0.0.1', port, method, path: target, headers }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.once('error', reject)
      res.once('end', () => { const bytes = Buffer.concat(chunks); let value; try { value = raw ? bytes : JSON.parse(bytes) } catch { return reject(Error(`Unexpected response: ${res.statusCode}`)) }; resolve({ status: res.statusCode, value }) })
    })
    req.setTimeout(45000, () => req.destroy(Error('Smoke request timed out'))); req.once('error', reject); req.end(input)
  })
}
const context = await request('GET', '/api/os/context')
if (context.status !== 200 || context.value.workspace !== workspace) throw Error('Staging workspace is not selected')
const anonymous = await request('GET', '/api/os/capabilities', undefined, { anonymous: true })
const wrongOwner = await request('GET', '/api/os/capabilities', undefined, { uid: 'openrod-smoke-wrong-owner' })
if (anonymous.status !== 403 || wrongOwner.status !== 403) throw Error('Worker owner checks did not reject unauthorized requests')
const session = await request('POST', `/api/os/sandboxes/${sandbox}/terminal-session`, { session: 'shell', cols: 80, rows: 24 })
if (session.status !== 200 || !session.value.ticket) throw Error(`Terminal ticket failed: ${JSON.stringify(session.value)}`)
const marker = `OpenRod terminal/files smoke ${randomUUID()}`, filename = `openrod-smoke-${randomUUID().slice(0, 8)}.txt`, file = `/sandbox/${filename}`
const versionsFile = `${file}.versions.txt`
const target = `/api/os/terminal?ticket=${encodeURIComponent(session.value.ticket)}`
const require = createRequire(new URL('../../ui/package.json', import.meta.url)), { WebSocket } = require('ws')
const terminal = await new Promise((resolve, reject) => {
  const socket = new WebSocket(`ws://127.0.0.1:${port}${target}`, { headers: headersFor('GET', target) })
  let ready = false, exitCode, received = 0
  const deadline = setTimeout(() => { socket.terminate(); reject(Error('Terminal smoke timed out')) }, 45000)
  socket.on('message', (data, binary) => {
    if (binary) { received += data.length; return }
    let value; try { value = JSON.parse(data.toString()) } catch { return }
    if (value.type === 'ready') {
      ready = true
      const versionCheck = option === '--agents' ? `claude --version > '${versionsFile}' && codex --version >> '${versionsFile}' && ` : ''
      socket.send(Buffer.from(`${versionCheck}printf '%s\\n' '${marker}' > '${file}' && cat '${file}'; result=$?; exit "$result"\n`))
    } else if (value.type === 'exit') exitCode = value.exitCode
    else if (value.type === 'error') { socket.terminate(); reject(Error(value.message)) }
  })
  socket.once('error', error => { clearTimeout(deadline); reject(error) })
  socket.once('close', code => { clearTimeout(deadline); if (!ready || exitCode !== 0 || received === 0) reject(Error(`Terminal closed without successful execution (code ${code}, exit ${exitCode})`)); else resolve({ ready, exitCode, received }) })
})
const listing = await request('GET', `/api/os/files/${sandbox}?path=%2Fsandbox`)
const entry = listing.value.entries?.find(value => value.name === filename)
if (listing.status !== 200 || entry?.type !== 'file') throw Error('Terminal-created file was not visible through Files API')
const download = await request('POST', `/api/os/files/${sandbox}/download`, { path: file })
if (download.status !== 200 || !download.value.token) throw Error('Files download preparation failed')
const content = await request('GET', `/api/os/downloads/${download.value.token}`, undefined, { raw: true })
if (content.status !== 200 || content.value.toString() !== marker + '\n') throw Error('Downloaded content does not match terminal-written file')
let agentVersions
if (option === '--agents') {
  const versionDownload = await request('POST', `/api/os/files/${sandbox}/download`, { path: versionsFile })
  if (versionDownload.status !== 200 || !versionDownload.value.token) throw Error('Agent version download preparation failed')
  const versions = await request('GET', `/api/os/downloads/${versionDownload.value.token}`, undefined, { raw: true })
  const lines = versions.value.toString().trim().split('\n')
  if (versions.status !== 200 || lines.length !== 2 || !/claude/i.test(lines[0]) || !/codex/i.test(lines[1]) || lines.some(line => line.length > 200)) throw Error('Expected Claude and Codex CLI version output')
  agentVersions = lines
}
console.info(JSON.stringify({ sandbox, workspace, anonymousRejected: true, wrongOwnerRejected: true, terminal, file, downloadedBytes: content.value.length, contentVerified: true, ...(agentVersions ? { agentVersions } : {}) }))
