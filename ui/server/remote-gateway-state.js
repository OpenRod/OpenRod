import fs from 'node:fs/promises'
import path from 'node:path'
import net from 'node:net'
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto'
import { stringify } from 'smol-toml'
import { CONFIG_DIR } from './gateway.js'
import { stateDirectory } from './paths.js'
import { fail, findExecutable, runCli } from './openshell-cli.js'

export const remoteGatewayName = (host, engineId) => `console-ssh-${createHash('sha256').update(JSON.stringify([host, engineId])).digest('hex').slice(0, 24)}`

export function gatewayEnvironment(root) {
  // Inherited gateway/TLS/database overrides must never point this process at
  // the operator's existing gateway state or weaken its authentication.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('OPENSHELL_')))
  return { ...env, XDG_CONFIG_HOME: path.join(root, 'config'), XDG_STATE_HOME: path.join(root, 'state'), XDG_CACHE_HOME: path.join(root, 'cache'), NO_COLOR: '1' }
}

export async function unusedPort() {
  const server = net.createServer()
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const port = server.address().port
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  return port
}

async function privateWrite(file, value) {
  await fs.writeFile(file, value, { mode: 0o600 })
  await fs.chmod(file, 0o600)
}

async function certificates(root) {
  const directory = path.join(root, 'tls')
  try { await fs.access(path.join(directory, 'complete')); return directory } catch (error) { if (error.code !== 'ENOENT') throw error }
  const openssl = findExecutable('openssl')
  if (!openssl) throw fail('OpenSSL is required locally to create the remote-work gateway certificates.', 409)
  const staging = await fs.mkdtemp(path.join(root, 'tls-'))
  const run = async args => {
    const result = await runCli(openssl, args, { cwd: staging, timeoutMs: 30_000 })
    if (result.code !== 0 || result.timedOut || result.outputExceeded) throw fail(`Could not generate gateway certificates: ${result.stderr.trim()}`, 502)
  }
  try {
    await privateWrite(path.join(staging, 'ca.cnf'), '[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ca\n[dn]\nCN=OpenRod Remote CA\n[ca]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\nsubjectKeyIdentifier=hash\n')
    await run(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '3650', '-keyout', 'ca.key', '-out', 'ca.crt', '-config', 'ca.cnf'])
    for (const kind of ['server', 'client', 'supervisor']) {
      await privateWrite(path.join(staging, `${kind}.ext`), `basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nauthorityKeyIdentifier=keyid,issuer\nextendedKeyUsage=${kind === 'server' ? 'serverAuth' : 'clientAuth'}\n${kind === 'server' ? 'subjectAltName=DNS:localhost,IP:127.0.0.1\n' : ''}`)
      const subject = kind === 'server' ? '/CN=openshell-server' : kind === 'client' ? '/CN=openshell-client/OU=openshell-user' : '/CN=openshell-supervisor'
      await run(['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-subj', subject, '-keyout', `${kind}.key`, '-out', `${kind}.csr`])
      await run(['x509', '-req', '-in', `${kind}.csr`, '-CA', 'ca.crt', '-CAkey', 'ca.key', '-set_serial', `0x${randomBytes(16).toString('hex')}`, '-days', '3650', '-extfile', `${kind}.ext`, '-out', `${kind}.crt`])
    }
    const jwt = generateKeyPairSync('ed25519')
    await privateWrite(path.join(staging, 'jwt.key'), jwt.privateKey.export({ type: 'pkcs8', format: 'pem' }))
    await privateWrite(path.join(staging, 'jwt.pub'), jwt.publicKey.export({ type: 'spki', format: 'pem' }))
    await privateWrite(path.join(staging, 'jwt.kid'), randomBytes(16).toString('hex'))
    for (const file of await fs.readdir(staging)) await fs.chmod(path.join(staging, file), 0o600)
    await privateWrite(path.join(staging, 'complete'), '1\n')
    await fs.rename(staging, directory)
    return directory
  } catch (error) { await fs.rm(staging, { recursive: true, force: true }); throw error }
}

export async function prepareGatewayState(host, probe, socketPath, { rootDirectory = stateDirectory() } = {}) {
  if (!probe.engineId) throw fail('The remote Docker engine did not report a stable identity.', 409)
  const name = remoteGatewayName(host, probe.engineId)
  const root = path.join(rootDirectory, 'remote-gateways', name)
  await fs.mkdir(root, { recursive: true, mode: 0o700 })
  await fs.chmod(root, 0o700)
  const tls = await certificates(root)
  const settingsFile = path.join(root, 'connection.json')
  let settings
  try { settings = JSON.parse(await fs.readFile(settingsFile, 'utf8')) } catch (error) { if (error.code !== 'ENOENT') throw error }
  if (!settings) {
    settings = { host, engineId: probe.engineId, port: await unusedPort() }
    await privateWrite(settingsFile, JSON.stringify(settings))
  }
  if (settings.host !== host || settings.engineId !== probe.engineId || !Number.isInteger(settings.port) || settings.port < 1024 || settings.port > 65535) throw fail('The managed gateway connection state is invalid.', 409)
  const config = {
    openshell: {
      version: 2,
      gateway: {
        name, bind_address: `127.0.0.1:${settings.port}`, compute_driver: 'docker',
        guest_tls_ca: path.join(tls, 'ca.crt'),
        // OpenShell 0.1.2 requires a complete guest bundle. Never reuse either
        // gateway's operator certificate: only this runtime key goes remotely.
        guest_tls_cert: path.join(tls, 'supervisor.crt'), guest_tls_key: path.join(tls, 'supervisor.key'),
        tls: { cert_path: path.join(tls, 'server.crt'), key_path: path.join(tls, 'server.key'), client_ca_path: path.join(tls, 'ca.crt') },
        mtls_auth: { enabled: true },
        gateway_jwt: { signing_key_path: path.join(tls, 'jwt.key'), public_key_path: path.join(tls, 'jwt.pub'), kid_path: path.join(tls, 'jwt.kid'), gateway_id: name },
      },
      drivers: { docker: {
        socket_path: socketPath, sandbox_label: name,
        grpc_endpoint: `https://127.0.0.1:${settings.port}`,
        sandbox_runtime_image: `ghcr.io/nvidia/openshell/sandbox:${probe.version}`,
        supervisor_image: `ghcr.io/nvidia/openshell/supervisor:${probe.version}`,
      } },
    },
  }
  const configFile = path.join(root, 'gateway.toml')
  await privateWrite(configFile, stringify(config))
  return { root, name, port: settings.port, tls, configFile, socketPath, env: gatewayEnvironment(root) }
}

export async function registerManagedGateway(state, host, { configDir = CONFIG_DIR } = {}) {
  const directory = path.join(configDir, 'gateways', state.name)
  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  const marker = path.join(directory, 'console-managed.json')
  let owner
  try { owner = JSON.parse(await fs.readFile(marker, 'utf8')) } catch (error) { if (error.code !== 'ENOENT') throw error }
  if (owner && (owner.root !== state.root || owner.host !== host)) throw fail('A different console owns this gateway registration.', 409)
  if (!owner) {
    const files = await fs.readdir(directory)
    if (files.length) throw fail('The managed gateway name conflicts with an existing registration.', 409)
    await privateWrite(marker, JSON.stringify({ root: state.root, host }))
  }
  const mtls = path.join(directory, 'mtls')
  await fs.mkdir(mtls, { recursive: true, mode: 0o700 })
  for (const [from, to] of [['ca.crt', 'ca.crt'], ['client.crt', 'tls.crt'], ['client.key', 'tls.key']]) {
    await privateWrite(path.join(mtls, to), await fs.readFile(path.join(state.tls, from)))
  }
  // The gateway runs locally, but its workloads and published images belong to
  // remote compute. Builders must explicitly transfer images before publication.
  await privateWrite(path.join(directory, 'metadata.json'), JSON.stringify({ name: state.name, gateway_endpoint: `https://127.0.0.1:${state.port}`, is_remote: true, gateway_port: state.port, auth_mode: 'mtls' }))
}

// Removes only a registration this console made for its own state. The state
// stays, so reconnecting the host reuses its certificates and port.
export async function unregisterManagedGateway(name, { configDir = CONFIG_DIR, rootDirectory = stateDirectory() } = {}) {
  if (!/^console-ssh-[a-f0-9]{24}$/.test(name ?? '')) return
  const directory = path.join(configDir, 'gateways', name)
  let owner
  try { owner = JSON.parse(await fs.readFile(path.join(directory, 'console-managed.json'), 'utf8')) } catch { return }
  if (owner?.root !== path.join(rootDirectory, 'remote-gateways', name)) return
  await fs.rm(directory, { recursive: true, force: true })
}
