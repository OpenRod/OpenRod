import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { runSsh } from './remote-hosts.js'
import { shellQuote, fail } from './openshell-cli.js'
import { DatabaseSync } from 'node:sqlite'

// Official v0.1.2 gateway image, pinned to the multi-platform release manifest.
export const REMOTE_GATEWAY_IMAGE = 'ghcr.io/nvidia/openshell/gateway:0.1.2@sha256:2fe4dad9118e14ab80a8258b545ea6e6cd74c3469e24ad4e6610f964d98913a2'
export const REMOTE_GATEWAY_IDS = {
  amd64: 'sha256:d6a87806b557730d55c95b4b3bd99ab74ccab0ad479166e116fae545e2b2f45e',
  arm64: 'sha256:e67f0bb7fac103c9efd05d481ea9aee464a59d8503490d3c4daca63546718eec',
}
const runtimeScript = await fs.readFile(new URL('./remote-runtime.py', import.meta.url), 'utf8')
// The CA signing key and operator's client key never leave this computer.
export const REMOTE_TLS_FILES = ['ca.crt', 'server.crt', 'server.key', 'supervisor.crt', 'supervisor.key', 'jwt.key', 'jwt.pub', 'jwt.kid']

export async function legacyRuntimeState(root, temporary) {
  const directory = path.join(root, 'state'), database = path.join(directory, 'openshell/gateway/openshell.db')
  try { await fs.access(database) } catch (error) { if (error.code === 'ENOENT') return {}; throw error }
  // A consistent read-only snapshot includes committed WAL data. The original
  // database remains intact for rollback; never copy a live .db file alone.
  const snapshot = path.join(temporary, 'legacy.sqlite')
  const db = new DatabaseSync(database, { readOnly: true })
  try { db.exec(`VACUUM INTO '${snapshot.replaceAll("'", "''")}'`) } finally { db.close() }
  const files = {}, pending = [directory]
  let bytes = 0
  while (pending.length) {
    const folder = pending.pop()
    for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw fail('Legacy gateway state contains a symlink. Migrate it manually before connecting.', 409)
      const file = path.join(folder, entry.name)
      if (entry.isDirectory()) { pending.push(file); continue }
      if (!entry.isFile() || /-(wal|shm)$/.test(entry.name)) continue
      const data = await fs.readFile(file === database ? snapshot : file)
      bytes += data.length
      if (bytes > 64 * 1024 * 1024 || Object.keys(files).length >= 5000) throw fail('Legacy gateway state exceeds the automatic migration limit. Migrate it manually.', 409)
      files[path.relative(directory, file).split(path.sep).join('/')] = data.toString('base64')
    }
  }
  return files
}

export async function startRemoteRuntime(host, probe, state, { signal, download = true, execute = runSsh } = {}) {
  if (probe.version !== '0.1.2' || !REMOTE_GATEWAY_IDS[probe.arch]) throw fail('Persistent remote gateways require OpenShell 0.1.2 on Linux amd64/arm64.', 409)
  const files = Object.fromEntries(await Promise.all(REMOTE_TLS_FILES.map(async name => [name, (await fs.readFile(path.join(state.tls, name))).toString('base64')])))
  const configuration = await fs.readFile(state.configFile, 'utf8')
  // gateway.toml remains local transport metadata for image jobs. Its remote
  // counterpart uses host-local Docker and host-local certificate paths.
  const remoteConfig = configuration.replaceAll(state.tls, '__CONSOLE_REMOTE_ROOT__/tls').replaceAll(state.socketPath, probe.dockerSocket)
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'os-runtime-'))
  try {
    const input = path.join(directory, 'input.json')
    let migrated = false
    try { await fs.access(path.join(state.root, 'remote-persistent')); migrated = true } catch (error) { if (error.code !== 'ENOENT') throw error }
    const legacy = migrated ? {} : await legacyRuntimeState(state.root, directory)
    await fs.writeFile(input, JSON.stringify({ name: state.name, engineId: probe.engineId, port: state.port, socket: probe.dockerSocket, config: remoteConfig, files, legacy, expectExisting: migrated, image: REMOTE_GATEWAY_IMAGE, imageId: REMOTE_GATEWAY_IDS[probe.arch], arch: probe.arch, download }), { mode: 0o600 })
    const output = await execute(host, `python3 -c ${shellQuote(runtimeScript)}`, { input, signal, timeoutMs: 180_000 })
    let result
    try { result = JSON.parse(output) } catch { throw fail('The remote gateway returned an invalid startup response.', 502) }
    if (result.name !== state.name || result.engineId !== probe.engineId || result.port !== state.port) throw fail('Remote gateway identity did not match this connection.', 409)
    await fs.writeFile(path.join(state.root, 'remote-persistent'), '1\n', { mode: 0o600 })
    return result
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
}
