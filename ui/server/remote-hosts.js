import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fail, shellQuote, sshBinary } from './openshell-cli.js'

const ALIAS = /^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$/
const SOCKET = /^\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/
const VERSION = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*)?$/

// Only enumerate names. OpenSSH itself still resolves all connection settings.
function tokens(line) {
  const words = []
  let word = '', quote = '', escaped = false
  for (const char of line) {
    if (escaped) { word += char; escaped = false; continue }
    if (char === '\\') { escaped = true; continue }
    if (quote) {
      if (char === quote) quote = ''
      else word += char
    } else if (char === '"' || char === "'") quote = char
    else if (char === '#') break
    else if (/\s/.test(char)) { if (word) words.push(word); word = '' }
    else word += char
  }
  if (quote || escaped) throw fail('Malformed quoting in SSH configuration. Fix it before connecting.', 409)
  if (word) words.push(word)
  return words
}

export function listSshHosts({ homeDirectory = os.homedir(), configPath = path.join(homeDirectory, '.ssh/config'), systemConfigPath = '/etc/ssh/ssh_config' } = {}) {
  if (!fs.existsSync(configPath)) return []
  const hosts = new Set()
  const visited = new Set()
  let bytes = 0
  function visit(file, base, depth = 0) {
    if (depth > 32 || visited.size > 1024) throw fail('SSH configuration includes are too deeply nested or numerous.', 409)
    let real
    try { real = fs.realpathSync(file) } catch (error) { if (error.code === 'ENOENT') return; throw error }
    if (visited.has(real)) return
    visited.add(real)
    const size = fs.statSync(real).size
    bytes += size
    if (bytes > 4 * 1024 * 1024) throw fail('SSH configuration exceeds the 4 MiB enumeration limit.', 409)
    const text = fs.readFileSync(real, 'utf8')
    for (const line of text.split(/\r?\n/)) {
      const parts = tokens(line.replace(/^(\s*[A-Za-z]+)\s*=\s*/, '$1 '))
      const directive = parts.shift()?.toLowerCase()
      if (directive === 'host') {
        for (const name of parts) if (ALIAS.test(name)) hosts.add(name)
      } else if (directive === 'include') {
        for (let pattern of parts) {
          if (pattern.startsWith('~/')) pattern = path.join(homeDirectory, pattern.slice(2))
          else if (pattern.startsWith('~')) continue // OpenSSH resolves other users; do not guess their homes.
          if (!path.isAbsolute(pattern)) pattern = path.join(base, pattern)
          for (const match of fs.globSync(pattern).sort()) visit(match, base, depth + 1)
        }
      }
    }
  }
  visit(configPath, path.join(homeDirectory, '.ssh'))
  visit(systemConfigPath, path.dirname(systemConfigPath))
  return [...hosts].sort().map((name) => ({ name }))
}

export function sshArgs(host) {
  if (typeof host !== 'string' || !ALIAS.test(host) || !listSshHosts().some(({ name }) => name === host)) {
    throw fail('Choose a concrete Host alias from your local ~/.ssh/config.', 400)
  }
  return ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=10',
    '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', '-o', 'ForwardAgent=no',
    '-o', 'ForwardX11=no', '-o', 'ControlMaster=no', '-o', 'ControlPath=none',
    '-o', 'PermitLocalCommand=no', '-o', 'RemoteCommand=none', '-o', 'RequestTTY=no', '--', host]
}

function stop(child, signal) {
  try {
    if (child.pid && process.platform !== 'win32') process.kill(-child.pid, signal)
    else child.kill(signal)
  } catch { /* Already exited. */ }
}

function execute(host, script, { timeoutMs = 60_000, outputLimit = 256 * 1024, signal, input, onProgress } = {}) {
  const args = sshArgs(host)
  args.splice(-2, 0, '-o', 'ClearAllForwardings=yes')
  const executable = sshBinary()
  if (!executable) throw fail('Install the OpenSSH client on this computer before connecting.', 409)
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isSafeInteger(outputLimit) || outputLimit <= 0) throw fail('Invalid SSH execution limits.')
  if (typeof script !== 'string' || script.includes('\0')) throw fail('Invalid remote command.')
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...args, `sh -c ${shellQuote(script)}`], {
      detached: process.platform !== 'win32', shell: false, stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    })
    const stdout = [], stderr = []
    let bytes = 0, failure, hardKill, source, progressBuffer = ''
    const terminate = (error) => {
      if (failure) return
      failure = error
      source?.destroy()
      child.stdin?.destroy()
      stop(child, 'SIGTERM')
      hardKill = setTimeout(() => stop(child, 'SIGKILL'), 500)
    }
    const append = (chunks, chunk) => {
      const remaining = outputLimit - bytes
      if (remaining > 0) chunks.push(chunk.subarray(0, remaining))
      bytes += chunk.length
      if (bytes > outputLimit) terminate(fail(`SSH output from ${host} exceeded the ${outputLimit}-byte limit.`, 502))
    }
    child.stdout.on('data', (chunk) => {
      append(stdout, chunk)
      if (!onProgress || failure) return
      progressBuffer += chunk.toString('utf8')
      const lines = progressBuffer.split('\n')
      progressBuffer = lines.pop()
      for (const line of lines) {
        if (line.startsWith('OPENSHELL_PROGRESS=')) onProgress(line.slice(19))
      }
    })
    child.stderr.on('data', (chunk) => append(stderr, chunk))
    const abort = () => terminate(fail(`SSH operation on ${host} was cancelled.`, 409))
    const timer = setTimeout(() => terminate(fail(`SSH operation on ${host} timed out. Check connectivity and the remote Docker engine.`, 504)), timeoutMs)
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    child.once('error', (error) => terminate(fail(`Could not start SSH: ${error.message}`, 502)))
    if (input && !failure) {
      source = fs.createReadStream(input, { autoClose: true })
      source.once('error', (error) => terminate(fail(`Cannot read runtime package: ${error.message}`, 400)))
      child.stdin.on('error', (error) => terminate(fail(`Runtime package upload failed: ${error.message}`, 502)))
      source.pipe(child.stdin)
    }
    child.once('close', (code, exitSignal) => {
      clearTimeout(timer)
      clearTimeout(hardKill)
      signal?.removeEventListener('abort', abort)
      source?.destroy()
      stop(child, 'SIGKILL') // Also reap any ProxyCommand descendants holding pipes open.
      const out = Buffer.concat(stdout).toString('utf8')
      const err = Buffer.concat(stderr).toString('utf8').trim()
      if (failure) reject(failure)
      else if (code === 255) reject(fail(`SSH to ${host} failed (255): ${err || out.trim() || 'no diagnostic output'}. Verify the alias, credentials, and trusted host key with ssh ${host}.`, 502))
      else if (code !== 0) reject(fail(`Remote command on ${host} failed (${code ?? exitSignal}): ${err || out.trim() || 'no diagnostic output'}`, 502))
      else resolve(out)
    })
  })
}

export async function runSsh(host, script, options = {}) {
  return execute(host, script, options)
}

function imageRefs(version) {
  if (typeof version !== 'string' || !VERSION.test(version)) throw fail('The local gateway must report a pinned release version (for example 0.1.2).', 409)
  // Release chart: NVIDIA/OpenShell v0.1.2 deploy/helm/openshell/values.yaml.
  // The persistent gateway container runs the release's gateway image too.
  return ['sandbox', 'supervisor', 'gateway'].map((image) => `ghcr.io/nvidia/openshell/${image}:${version}`)
}

// Absence is deliberately conservative: a broken CLI, daemon, package, socket,
// or service is an existing installation that must be repaired manually.
const dockerPresence = `
docker_present() {
  if command -v docker >/dev/null 2>&1; then return 0; fi
  if command -v dockerd >/dev/null 2>&1; then
    fail 'Docker Engine is installed but its CLI is unavailable. Repair Docker and this SSH user’s PATH manually, then reconnect.'
  fi
  for item in /usr/bin/docker /usr/local/bin/docker /bin/docker /usr/sbin/dockerd /usr/bin/dockerd /snap/bin/docker /run/docker.sock /var/run/docker.sock /etc/systemd/system/docker.service /lib/systemd/system/docker.service /usr/lib/systemd/system/docker.service /etc/systemd/system/docker.socket /lib/systemd/system/docker.socket /usr/lib/systemd/system/docker.socket; do
    if [ -e "$item" ] || [ -L "$item" ]; then
      fail 'Docker components already exist but its CLI is unavailable. Repair the existing installation and SSH user access manually, then reconnect.'
    fi
  done
  if command -v dpkg-query >/dev/null 2>&1; then
    status=0
    states=$(dpkg-query -W -f='\${db:Status-Status}\\n' docker.io docker-ce docker-ce-cli docker-engine moby-engine moby-cli 2>/dev/null) || status=$?
    [ "$status" -le 1 ] || fail 'Cannot inspect the host Docker package state. Repair package database access manually, then reconnect.'
    for state in $states; do
      case "$state" in installed|unpacked|half-configured|half-installed|triggers-awaited|triggers-pending)
        fail 'Docker packages already exist but its CLI is unavailable. Repair the existing installation manually, then reconnect.';;
      esac
    done
  fi
  if command -v rpm >/dev/null 2>&1; then
    for package in docker docker-ce docker-ce-cli moby-engine moby-cli; do
      if rpm -q "$package" >/dev/null 2>&1; then
        fail 'Docker packages already exist but its CLI is unavailable. Repair the existing installation manually, then reconnect.'
      fi
    done
  fi
  return 1
}
`

const dockerInstallPlatform = `
distribution=unknown
if [ -r /etc/os-release ]; then
  ID=
  . /etc/os-release
  distribution=\${ID:-unknown}
fi
supported=true
reason=
case "$distribution" in ubuntu|debian) ;; *)
  supported=false
  reason='Automatic Docker installation supports only Ubuntu and Debian. Install a native rootful Docker Engine manually, grant this SSH user socket access, then reconnect.';;
esac
case "$(uname -m)" in x86_64|amd64|aarch64|arm64) ;; *)
  supported=false
  reason='Automatic Docker installation requires native amd64 or arm64 Linux. Use a supported host.';;
esac
if ! command -v apt-get >/dev/null 2>&1 || ! command -v systemctl >/dev/null 2>&1 || [ ! -d /run/systemd/system ]; then
  supported=false
  reason='Automatic Docker installation requires apt-get and a running systemd host. Install and start Docker Engine manually, grant this SSH user socket access, then reconnect.'
fi
`

const discovery = `set -eu
fail() { printf '%s\\n' "$*" >&2; exit 1; }
[ "$(uname -s)" = Linux ] || fail 'A native Linux Docker host is required.'
command -v docker >/dev/null 2>&1 || fail 'Docker CLI is unavailable. Install or repair Docker Engine and grant this SSH user socket access, then reconnect.'
if [ -n "\${DOCKER_CONTEXT:-}" ]; then
  endpoint=$(docker context inspect "$DOCKER_CONTEXT" --format '{{.Endpoints.docker.Host}}')
elif [ -n "\${DOCKER_HOST:-}" ]; then
  endpoint=$DOCKER_HOST
else
  endpoint=$(docker context inspect --format '{{.Endpoints.docker.Host}}')
fi
case "$endpoint" in unix:///*) socket=\${endpoint#unix://};; *) fail 'Select a local Unix Docker Engine socket on this SSH host; TCP, SSH, and other remote Docker contexts are not supported.';; esac
case "$socket" in *[!a-zA-Z0-9_./-]*|*'/../'*|*'/./'*|*'//'*) fail 'Docker socket path is not safe for SSH forwarding.';; esac
[ -S "$socket" ] && [ -r "$socket" ] && [ -w "$socket" ] || fail 'Docker socket is missing or inaccessible. Start Docker Engine and grant this SSH user read/write socket access, then reconnect.'
unset DOCKER_CONTEXT DOCKER_HOST DOCKER_TLS_VERIFY DOCKER_CERT_PATH
engine() { docker --host "$endpoint" "$@"; }
`

function architecture(value) {
  return ({ x86_64: 'amd64', amd64: 'amd64', aarch64: 'arm64', arm64: 'arm64' })[value]
}

export async function probeHost(host, version, { signal } = {}) {
  const refs = imageRefs(version)
  const script = `set -eu
fail() { printf '%s\\n' "$*" >&2; exit 1; }
[ "$(uname -s)" = Linux ] || fail 'A native Linux Docker host is required.'
${dockerPresence}
if ! docker_present; then
  ${dockerInstallPlatform}
  printf 'OPENSHELL_HOST_OS=Linux\\nOPENSHELL_HOST_ARCH=%s\\n' "$(uname -m)"
  printf 'OPENSHELL_DOCKER_INSTALLED=false\\nOPENSHELL_DISTRIBUTION=%s\\nOPENSHELL_DOCKER_INSTALL_SUPPORTED=%s\\nOPENSHELL_DOCKER_INSTALL_REASON=%s\\n' "$distribution" "$supported" "$reason"
  exit 0
fi
${discovery}
printf 'OPENSHELL_HOST_OS=%s\\n' "$(uname -s)"
printf 'OPENSHELL_HOST_ARCH=%s\\n' "$(uname -m)"
printf 'OPENSHELL_HOST_KERNEL=%s\\n' "$(uname -r)"
printf 'OPENSHELL_SOCKET=%s\\n' "$socket"
printf 'OPENSHELL_ENGINE='
engine info --format '{{json .}}' || fail 'Docker Engine is unusable by this SSH user. Check its socket permissions and daemon status.'
${refs.map((ref, index) => `image=$(engine image inspect --format '{{json .}}' ${shellQuote(ref)} 2>/dev/null) || image=null\nprintf 'OPENSHELL_IMAGE_${index}=%s\\n' "$image"`).join('\n')}
`
  const text = await runSsh(host, script, { signal })
  const fields = new Map(text.split(/\r?\n/).filter((line) => line.startsWith('OPENSHELL_')).map((line) => {
    const index = line.indexOf('=')
    return [line.slice(10, index), line.slice(index + 1)]
  }))
  if (fields.get('DOCKER_INSTALLED') === 'false') {
    const arch = architecture(fields.get('HOST_ARCH'))
    if (fields.get('HOST_OS') !== 'Linux' || !fields.get('HOST_ARCH') || !fields.get('DISTRIBUTION')) throw fail('Remote host returned an invalid Docker discovery response.', 502)
    const supported = Boolean(arch) && fields.get('DOCKER_INSTALL_SUPPORTED') === 'true'
    return {
      os: 'linux', arch: arch ?? fields.get('HOST_ARCH'), version, runtimeReady: false,
      dockerInstalled: false, distribution: fields.get('DISTRIBUTION'), dockerInstallSupported: supported,
      ...(!supported ? { dockerInstallReason: fields.get('DOCKER_INSTALL_REASON') || 'Install Docker Engine manually on a supported native Linux host, then reconnect.' } : {}),
    }
  }
  let info, images
  try {
    info = JSON.parse(fields.get('ENGINE'))
    images = refs.map((_, index) => JSON.parse(fields.get(`IMAGE_${index}`)))
  } catch { throw fail('Remote Docker returned an invalid probe response. Check the remote shell and Docker installation.', 502) }
  const arch = architecture(fields.get('HOST_ARCH'))
  const dockerSocket = fields.get('SOCKET')
  if (fields.get('HOST_OS') !== 'Linux' || info?.OSType !== 'linux' || /docker[ -]desktop/i.test(`${info?.OperatingSystem} ${info?.Name}`)) throw fail('Use a native Linux Docker Engine, not Docker Desktop or a non-Linux daemon.', 409)
  if (!arch || architecture(info.Architecture) !== arch) throw fail('Docker and the SSH host must have the same supported architecture (amd64 or arm64).', 409)
  if (!fields.get('HOST_KERNEL') || info.KernelVersion !== fields.get('HOST_KERNEL')) throw fail('Docker must run directly on the SSH host, not inside a separate VM. Select this host’s native Docker Engine socket.', 409)
  if (!SOCKET.test(dockerSocket ?? '') || dockerSocket.split('/').some((part) => part === '.' || part === '..')) throw fail('The Docker socket must be a safe absolute Unix socket path.', 409)
  if (!Array.isArray(info.SecurityOptions) || !info.SecurityOptions.some((option) => /^name=seccomp(?:,|$)/.test(option))) throw fail('Enable Docker Engine seccomp support before running non-root OpenShell workloads.', 409)
  if (info.SecurityOptions.some((option) => /^name=rootless(?:,|$)/.test(option))) throw fail('Rootless Docker is not supported by persistent remote gateways. Select a rootful Docker Engine on this Linux host; workloads still run non-root.', 409)
  if (typeof info.ID !== 'string' || !info.ID.trim()) throw fail('Docker Engine did not report its identity; upgrade or repair the daemon before connecting.', 409)
  const runtimeReady = images.every((image, index) => image?.Os === 'linux' && architecture(image.Architecture) === arch && image.RepoTags?.includes(refs[index]))
  return { os: 'linux', arch, dockerSocket, runtimeReady, version, engineId: info.ID, dockerInstalled: true }
}

export async function installDocker(host, version, { signal, onProgress = () => {} } = {}) {
  onProgress('Checking whether Docker is genuinely missing')
  const before = await probeHost(host, version, { signal })
  if (before.dockerInstalled) return before
  if (!before.dockerInstallSupported) throw fail(before.dockerInstallReason, 409)
  const script = `set -eu
fail() { printf '%s\\n' "$*" >&2; exit 1; }
[ "$(uname -s)" = Linux ] || fail 'A native Linux Docker host is required.'
${dockerPresence}
# A concurrent installation must never become permission repair or replacement.
if docker_present; then exit 0; fi
${dockerInstallPlatform}
[ "$supported" = true ] || fail "$reason"
uid=$(id -u)
user=$(id -un)
if [ "$uid" != 0 ]; then
  command -v sudo >/dev/null 2>&1 && sudo -n true || fail 'Docker installation needs root or passwordless sudo (sudo -n). Ask an administrator to install Docker, then reconnect; no password can be entered here.'
fi
priv() { if [ "$uid" = 0 ]; then "$@"; else sudo -n "$@"; fi; }
printf 'OPENSHELL_PROGRESS=Updating distribution package indexes\\n'
priv env DEBIAN_FRONTEND=noninteractive apt-get update
if docker_present; then exit 0; fi
printf 'OPENSHELL_PROGRESS=Installing the distribution docker.io package and dependencies\\n'
priv env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends docker.io --no-remove
printf 'OPENSHELL_PROGRESS=Enabling and starting the Docker system service\\n'
priv systemctl enable --now docker
if [ "$uid" != 0 ]; then
  printf 'OPENSHELL_PROGRESS=Granting the SSH user docker group access (root-equivalent)\\n'
  priv usermod -aG docker "$user"
fi
`
  try {
    await execute(host, script, { signal, onProgress, timeoutMs: 15 * 60_000, outputLimit: 1024 * 1024 })
    onProgress('Verifying Docker access in a fresh SSH session')
    const probe = await probeHost(host, version, { signal })
    if (!probe.dockerInstalled) throw fail('Docker is still missing after the package installation.', 502)
    return probe
  } catch (error) {
    throw fail(`Docker preparation did not complete. Package, service, or group changes may already remain on the host; inspect it before retrying. ${error.message}`, error.status ?? 502)
  }
}

export async function installRuntime(host, version, method, { packagePath, onProgress = () => {}, signal } = {}) {
  const refs = imageRefs(version)
  if (method !== 'download' && method !== 'upload') throw fail('Choose runtime download or Docker-save package upload.')
  if (method === 'upload') {
    if (typeof packagePath !== 'string' || !path.isAbsolute(packagePath)) throw fail('A local Docker-save package file is required.')
    let stat
    try { stat = fs.statSync(packagePath) } catch { throw fail('The uploaded Docker-save package is unavailable.') }
    if (!stat.isFile() || stat.size === 0) throw fail('The Docker-save package must be a nonempty regular file.')
  }
  await probeHost(host, version, { signal })
  onProgress(method === 'download' ? 'Downloading pinned runtime images on the SSH host' : 'Uploading and loading the Docker-save package')
  const command = method === 'download'
    ? refs.map((ref) => `engine pull --quiet ${shellQuote(ref)}`).join('\n')
    : 'engine load --quiet'
  await execute(host, `${discovery}${command}\n`, { input: method === 'upload' ? packagePath : undefined, timeoutMs: 30 * 60_000, outputLimit: 1024 * 1024, signal })
  onProgress('Checking the installed runtime versions and platform')
  const probe = await probeHost(host, version, { signal })
  if (!probe.runtimeReady) throw fail(`The host still needs the pinned linux/${probe.arch} images: ${refs.join(', ')}. Build the Docker-save package for this host's platform.`, 409)
  return probe
}
