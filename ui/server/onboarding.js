import fs from 'node:fs'
import path from 'node:path'
import { X509Certificate, createPrivateKey } from 'node:crypto'
import { CONFIG_DIR, gatewayWorkspaces, listGateways } from './gateway.js'
import { findExecutable, openshellBinary, sshBinary } from './openshell-cli.js'
import { stateDirectory } from './paths.js'

export function onboardingInfo() {
  const describe = (file) => ({ available: Boolean(file), path: file })
  return {
    configDir: CONFIG_DIR,
    contextFile: path.join(CONFIG_DIR, 'console-context.json'),
    stateDir: stateDirectory(),
    platform: process.platform,
    nodeVersion: process.versions.node,
    tools: {
      openshell: describe(openshellBinary()),
      ssh: describe(sshBinary()),
      kubectl: describe(findExecutable('kubectl')),
    },
    policySweepEnabled: process.env.OPENSHELL_CONSOLE_SWEEP === '1',
  }
}

function connectionFailure(error) {
  const message = `${error.code ?? ''} ${error.message ?? ''}`
  if (/ENOTFOUND|EAI_AGAIN|name resolution/i.test(message)) return 'Gateway hostname could not be resolved. Check the registered endpoint and your DNS/VPN connection.'
  if (/ECONNREFUSED|ECONNRESET|fetch failed|socket hang up/i.test(message)) return 'Gateway connection failed. Check the registered endpoint and keep its tunnel running. For Kubernetes, also check your cloud login and kubectl port-forward output.'
  if (/timeout|timed out|deadline|ETIMEDOUT/i.test(message)) return 'Gateway discovery timed out. Check endpoint reachability, VPN/firewall access, and tunnel output.'
  if (/certificate|CERT_|TLS|SSL|self.signed|signature/i.test(message)) return 'TLS verification failed. Confirm the endpoint matches the server certificate and reinstall the original client bundle from this gateway. OpenShell 0.1.2 registration can replace that bundle. Do not disable TLS verification.'
  if (/unauthenticated|permission.denied|unauthorized|forbidden/i.test(message)) return 'The gateway refused workspace discovery. Ask its administrator to verify your identity and workspace access; mTLS transport alone does not grant Kubernetes user authorization.'
  return 'The gateway could not list workspaces. Check the OpenShell CLI connection and gateway logs, and confirm SDK/gateway compatibility. No connection was selected.'
}

// Only the explicit check action calls this. No registration, selection, local
// state, sandbox execution, or collector is changed by checking a gateway.
export async function checkGateway(name, { configDir = CONFIG_DIR, probe = gatewayWorkspaces } = {}) {
  const checks = []
  const add = (id, label, status, detail) => checks.push({ id, label, status, detail })
  const tools = onboardingInfo().tools
  const sshReady = tools.openshell.available && tools.ssh.available && ['darwin', 'linux'].includes(process.platform)
  const target = listGateways({ configDir }).find((entry) => entry.name === name)
  const result = (workspaces = []) => ({
    gateway: target ? { name: target.name, endpoint: target.endpoint, authMode: target.authMode, remote: target.remote } : null,
    checks, workspaces, canConnect: workspaces.length > 0 && !checks.some((check) => check.status === 'fail'), sshReady,
  })
  if (!target) {
    add('registration', 'Gateway registration', 'fail', 'No registration with this name was found. Run the reviewed registration commands, then refresh registrations.')
    return result()
  }
  if (target.error) {
    add('registration', 'Gateway registration', 'fail', `${target.error} Directory: ${path.join(configDir, 'gateways', target.name)}`)
    return result()
  }
  add('registration', 'Gateway registration', 'pass', path.join(configDir, 'gateways', target.name, 'metadata.json'))
  if (!target.supported) {
    add('authentication', 'Supported authentication', 'fail', `This registration uses ${target.authMode || 'unknown authentication'}. The console supports mTLS only, not OIDC, edge authentication, or plaintext HTTP. Do not weaken gateway authentication to make this check pass.`)
    return result()
  }
  let endpoint
  try {
    endpoint = new URL(target.endpoint)
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('unsupported endpoint')
  } catch {
    add('endpoint', 'Gateway endpoint', 'fail', 'Use an HTTPS gateway endpoint without embedded credentials, query parameters, or fragments. Correct the CLI registration before checking again.')
    return result()
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)
  add('endpoint', 'Gateway endpoint', 'pass', `${endpoint.href}${loopback ? ' — loopback endpoint; if this is a tunnel, keep it running. This does not imply local compute.' : ''}`)
  add('authentication', 'Supported authentication', 'pass', 'mTLS client certificates. Gateway user authorization is a separate deployment requirement.')
  const material = {}
  for (const filename of ['ca.crt', 'tls.crt', 'tls.key']) {
    const file = path.join(configDir, 'gateways', target.name, 'mtls', filename)
    try {
      const stat = fs.statSync(file)
      if (!stat.isFile()) throw new Error('not a file')
      material[filename] = fs.readFileSync(file)
      if (process.platform !== 'win32' && (stat.mode & 0o077)) {
        add(filename, filename, filename === 'tls.key' ? 'fail' : 'warning', `${file} is readable by other users. Set its permissions to 600; the console will not change permissions for you.`)
      } else add(filename, filename, 'pass', `Readable by the console: ${file}`)
    } catch {
      add(filename, filename, 'fail', `Cannot read ${file}. Install the gateway administrator's original client bundle on this machine; do not paste private keys into the browser.`)
    }
  }
  if (checks.some((check) => check.status === 'fail')) return result()
  try {
    const ca = new X509Certificate(material['ca.crt'])
    const certificate = new X509Certificate(material['tls.crt'])
    const key = createPrivateKey(material['tls.key'])
    if (!certificate.checkPrivateKey(key)) {
      add('certificate', 'Certificate and private key', 'fail', 'The client certificate and key do not match. Reinstall all three files from the same original gateway bundle.')
      return result()
    }
    const now = Date.now()
    if ([ca, certificate].some((cert) => now < Date.parse(cert.validFrom) || now >= Date.parse(cert.validTo))) {
      add('certificate', 'Certificate validity', 'fail', 'The CA or client certificate is expired or not yet valid. Check the local clock and ask the gateway administrator for a current bundle.')
      return result()
    }
    add('certificate', 'Certificate validity and key match', 'pass', `Client certificate valid until ${certificate.validTo}. The gateway still verifies its trust during the connection check.`)
  } catch {
    add('certificate', 'Certificate and private key', 'fail', 'The bundle could not be parsed. Use PEM CA/client certificates and a matching unencrypted client key protected by mode 600. Ask the administrator for the correct bundle.')
    return result()
  }
  add('ssh-tools', 'Native SSH prerequisites', sshReady ? 'pass' : 'warning', sshReady
    ? `OpenShell: ${tools.openshell.path}; OpenSSH: ${tools.ssh.path}. Executables found; no shell or sandbox command has been run.`
    : 'Native terminal launch requires the OpenShell CLI and OpenSSH on macOS/Linux. Install missing tools on the console machine; browser-terminal connectivity is checked independently.')
  let workspaces
  try {
    workspaces = await probe(target.name)
  } catch (error) {
    add('connection', 'Gateway and workspace discovery', 'fail', connectionFailure(error))
    return result()
  }
  add('connection', 'Gateway and workspace discovery', 'pass', 'Authenticated workspace-list request succeeded. This does not yet prove sandbox readiness or an SSH login.')
  if (!workspaces.length) add('workspaces', 'Available workspaces', 'fail', 'The gateway returned no workspaces. Ask its administrator to create a workspace or grant access. The console will not invent a default workspace.')
  else add('workspaces', 'Available workspaces', 'pass', `${workspaces.length} workspace(s) returned. Choose one, then explicitly use this gateway.`)
  return result(workspaces)
}
