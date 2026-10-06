import fs from 'node:fs'
import http from 'node:http'
import { signWorkerRequest } from '../../ui/server/worker-auth.js'
import { workerAuthHeader } from '../../ui/server/cloud-deployment.js'

// Operator smoke-test helper. Run on the worker with its root-owned staging
// environment file. Authentication material never leaves this process or gets
// printed. The response can contain application data: use scoped test resources.
const [envFile, portValue, method = 'GET', target = '/api/os/capabilities', inputFile] = process.argv.slice(2)
const port = Number(portValue)
if (!envFile || !Number.isInteger(port) || port < 1024 || port > 65535 || !['GET', 'POST'].includes(method) || !target.startsWith('/api/') || target.startsWith('//') || target.includes('\\')) throw Error('Usage: worker-request.mjs ENV_FILE PORT GET|POST /api/path [JSON_FILE|-]')
const env = Object.fromEntries(fs.readFileSync(envFile, 'utf8').split('\n').filter(line => line && !line.startsWith('#') && line.includes('=')).map(line => {
  const at = line.indexOf('='), raw = line.slice(at + 1)
  return [line.slice(0, at), raw.startsWith('"') ? JSON.parse(raw) : raw]
}))
if (env.OPENROD_MODE !== 'worker' || !env.OPENROD_WORKER_KEY || !env.OPENROD_WORKER_UID) throw Error('Expected a staging worker environment')
const origin = new URL(env.OPENROD_PUBLIC_ORIGIN), input = inputFile ? fs.readFileSync(inputFile === '-' ? 0 : inputFile) : method === 'POST' ? Buffer.from('{}') : undefined
if (input) JSON.parse(input.toString())
const headers = { host: origin.host, origin: origin.origin, 'x-openshell-console': '1', [workerAuthHeader(env.OPENROD_WORKER_PROTOCOL)]: signWorkerRequest(env.OPENROD_WORKER_KEY, { uid: env.OPENROD_WORKER_UID, expires: Date.now() + 3600000 }, { method, url: target }) }
if (input) { headers['content-type'] = 'application/json'; headers['content-length'] = input.length }
const response = await new Promise((resolve, reject) => {
  const request = http.request({ hostname: '127.0.0.1', port, method, path: target, headers }, res => {
    let body = ''
    res.on('data', chunk => { body += chunk })
    res.once('end', () => { let value; try { value = JSON.parse(body) } catch { value = body }; resolve({ status: res.statusCode, body: value }) })
    res.once('error', reject)
  })
  request.setTimeout(35 * 60000, () => request.destroy(Error('Worker request timed out')))
  request.once('error', reject)
  request.end(input)
})
console.info(JSON.stringify(response))
if (response.status >= 400) process.exitCode = 1
