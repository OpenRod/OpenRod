import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

// The console starts its remote gateway and SSH tunnel in their own process
// groups so a stop reaches their children. The cost: if the console dies
// without cleaning up (SIGKILL, crash, a dev server being stopped), they are
// reparented to init and keep running. The old tunnel still holds its reverse
// port on the remote host, so every later connect fails with "remote port
// forwarding failed". An orphan is one of our processes whose parent is init;
// a live console's children always have that console as their parent.
export function findOrphans(listing, { stateRoot, user = null }) {
  const gatewayConfigs = path.join(stateRoot, 'remote-gateways') + path.sep
  const found = []
  for (const line of listing.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    if (!match) continue
    const [, pid, ppid, command] = match
    if (ppid !== '1' || Number(pid) === process.pid) continue
    const tunnel = command.includes('ExitOnForwardFailure=yes') && command.includes('StreamLocalBindMask=0177') && /\bos-ssh-[^/\s]+\/docker\.sock/.test(command)
    const gateway = /openshell-gateway\b/.test(command) && command.includes(`--config ${gatewayConfigs}`)
    if (tunnel || gateway) found.push({ pid: Number(pid), kind: tunnel ? 'tunnel' : 'gateway', command })
  }
  return found
}

export async function reapOrphans({ stateRoot, logger = console, timeoutMs = 2000 } = {}) {
  if (process.platform === 'win32') return []
  let listing
  try { listing = (await run('ps', ['-x', '-o', 'pid=,ppid=,command='], { maxBuffer: 8 * 1024 * 1024 })).stdout } catch { return [] }
  const orphans = findOrphans(listing, { stateRoot })
  const signal = (orphan, name) => { try { process.kill(-orphan.pid, name) } catch { try { process.kill(orphan.pid, name) } catch { /* already gone */ } } }
  for (const orphan of orphans) signal(orphan, 'SIGTERM')
  const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }
  const deadline = Date.now() + timeoutMs
  while (orphans.some(orphan => alive(orphan.pid)) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100))
  for (const orphan of orphans) if (alive(orphan.pid)) signal(orphan, 'SIGKILL')
  for (const orphan of orphans) logger.warn(`Stopped a leftover remote ${orphan.kind} from an earlier console run (pid ${orphan.pid}).`)
  return orphans
}
