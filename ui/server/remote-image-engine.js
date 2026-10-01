import fs from 'node:fs/promises'
import path from 'node:path'
import { parse } from 'smol-toml'
import { CONFIG_DIR } from './gateway.js'
import { stateDirectory } from './paths.js'
import { remoteGatewayName } from './remote-gateway-state.js'
import { fail } from './openshell-cli.js'

// The caller supplies its Docker runner so cancellation and command execution
// retain the image job's existing behavior. Never discover another Docker host.
export async function remoteImageEngine(target, { execute } = {}) {
  const unsupported = () => fail('This remote gateway has no managed SSH Docker transport. Connect its host through SSH in Connections, then select that connection to use image templates.', 409)
  if (!target?.remote || !/^console-ssh-[a-f0-9]{24}$/.test(target.name || '')) throw unsupported()
  if (typeof execute !== 'function') throw new TypeError('remoteImageEngine requires a Docker execute function.')
  const reconnect = () => fail('The managed SSH Docker connection state is missing or invalid. Reconnect this host in Connections before using image templates.', 409)
  let owner
  try {
    owner = JSON.parse(await fs.readFile(path.join(CONFIG_DIR, 'gateways', target.name, 'console-managed.json'), 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') throw unsupported()
    throw reconnect()
  }
  const root = path.join(stateDirectory(), 'remote-gateways', target.name)
  if (owner?.root !== root || typeof owner.host !== 'string' || !owner.host.trim()) throw reconnect()
  let connection, socketPath
  try {
    connection = JSON.parse(await fs.readFile(path.join(root, 'connection.json'), 'utf8'))
    socketPath = parse(await fs.readFile(path.join(root, 'gateway.toml'), 'utf8')).openshell?.drivers?.docker?.socket_path
  } catch { throw reconnect() }
  if (connection?.host !== owner.host || typeof connection.engineId !== 'string' || !connection.engineId.trim()
    || !Number.isInteger(connection.port) || connection.port < 1024 || connection.port > 65535
    || remoteGatewayName(connection.host, connection.engineId) !== target.name
    || typeof socketPath !== 'string' || !path.isAbsolute(socketPath) || socketPath.includes('\0')) throw reconnect()

  const endpoint = `unix://${socketPath}`
  let info
  try {
    info = JSON.parse(await execute(['info', '--format', '{{json .}}'], { engine: { endpoint }, timeout: 15_000 }))
  } catch {
    throw fail('The SSH Docker tunnel is not available. Reconnect this host in Connections and retry the image operation.', 409)
  }
  if (!info || info.ID !== connection.engineId) throw fail('The SSH Docker tunnel no longer reaches the saved Docker engine. Reconnect this host in Connections before using image templates.', 409)
  if (info.OSType !== 'linux') throw fail('The SSH host must run Linux containers to use image templates.', 409)
  const architecture = ['aarch64', 'arm64'].includes(info.Architecture) ? 'arm64' : ['x86_64', 'amd64'].includes(info.Architecture) ? 'amd64' : null
  if (!architecture) throw fail('The SSH Docker engine must use the amd64 or arm64 architecture to use image templates.', 409)
  return { endpoint, architecture, engineId: connection.engineId }
}
