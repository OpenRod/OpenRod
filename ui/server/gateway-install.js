import fs from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { stateDirectory } from './paths.js'
import { fail, findExecutable, runCli } from './openshell-cli.js'

const VERSION = '0.1.2'
// Pinned official NVIDIA/OpenShell v0.1.2 release digests, not a mutable latest release.
const RELEASES = {
  'darwin-arm64': ['aarch64-apple-darwin', '640068efa16e446d5f4f9ffaec0af769dbab04d686473d2a7bd6bafeb4ef7f45'],
  'linux-arm64': ['aarch64-unknown-linux-gnu', '8ec1b6ca5b71ef5085fa51f3244d719a541e8f0d58cc569c7a0d6705b6204397'],
  'linux-x64': ['x86_64-unknown-linux-gnu', '218d887845b3a020ab7535c9985eb9c666d6938f144044957f8b82b42892aadb'],
}

export async function ensureGateway({
  signal, onProgress = () => {},
  directory = path.join(stateDirectory(), 'tools', `openshell-gateway-${VERSION}`),
  find = findExecutable,
} = {}) {
  signal?.throwIfAborted()
  const installed = find('openshell-gateway')
  if (installed) return installed
  const cached = path.join(directory, 'openshell-gateway')
  try { await fs.access(cached, fs.constants.X_OK); return cached } catch (error) { if (error.code !== 'ENOENT') throw error }
  const release = RELEASES[`${process.platform}-${process.arch}`]
  if (!release) throw fail('Automatic gateway installation supports Apple Silicon macOS and arm64/x64 Linux. Install openshell-gateway for this platform manually.', 409)
  const tar = find('tar')
  if (!tar) throw fail('tar is required to install the local OpenShell gateway.', 409)
  onProgress(`Installing OpenShell gateway ${VERSION} on this computer`)
  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  const staging = await fs.mkdtemp(path.join(directory, '.install-'))
  try {
    const archive = path.join(staging, 'gateway.tar.gz')
    const url = `https://github.com/NVIDIA/OpenShell/releases/download/v${VERSION}/openshell-gateway-${release[0]}.tar.gz`
    const downloadSignal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(120_000)])
    const response = await fetch(url, { signal: downloadSignal })
    if (!response.ok || !response.body) throw fail(`Gateway download failed: HTTP ${response.status}`, 502)
    const hash = createHash('sha256')
    let bytes = 0
    const verify = new Transform({ transform(chunk, _encoding, callback) {
      bytes += chunk.length
      if (bytes > 64 * 1024 * 1024) return callback(fail('Gateway download exceeded its size limit.', 502))
      hash.update(chunk); callback(null, chunk)
    } })
    await pipeline(response.body, verify, createWriteStream(archive, { flags: 'wx', mode: 0o600 }), { signal: downloadSignal })
    if (hash.digest('hex') !== release[1]) throw fail('Gateway download checksum did not match the pinned release. Nothing was installed.', 502)
    signal?.throwIfAborted()
    const extracted = await runCli(tar, ['-xzf', archive, '-C', staging, 'openshell-gateway'], { timeoutMs: 30_000 })
    if (extracted.code !== 0) throw fail(`Could not unpack the gateway: ${extracted.stderr.trim()}`, 502)
    const binary = path.join(staging, 'openshell-gateway')
    if (!(await fs.lstat(binary)).isFile()) throw fail('Gateway package did not contain a regular executable.', 502)
    await fs.chmod(binary, 0o700)
    const checked = await runCli(binary, ['--version'], { timeoutMs: 5000 })
    if (checked.code !== 0 || checked.stdout.trim() !== `openshell-gateway ${VERSION}`) throw fail(`The downloaded gateway cannot run on this computer: ${checked.stderr.trim()}`, 502)
    signal?.throwIfAborted()
    await fs.rename(binary, cached)
    return cached
  } finally {
    await fs.rm(staging, { recursive: true, force: true })
  }
}
