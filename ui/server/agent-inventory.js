import { setupPython } from './setup-python.js'
import { AGENTS } from '../src/lib/agents.js'

const resourceProbe = setupPython('./agent-resources.py')

// Inspect executables without starting an agent, reading credentials, or sourcing
// user profile scripts. The same check finds image contents and later installs.
// Cursor's current "agent" alias is ambiguous. Resolve its symlink to the
// vendor installation instead of running an unknown executable for identification.
export const agentProbe = `
report_agent() {
  candidate="$1"
  agent_command="$2"
  [ -f "$candidate" ] && [ -x "$candidate" ] || return 1
  if [ "$agent_command" = agent ]; then
    resolved=$(readlink -f "$candidate" 2>/dev/null || :)
    case "$resolved" in
      */cursor-agent|*/cursor-agent/*) ;;
      *) return 1 ;;
    esac
  fi
  printf '%s\\n' "$agent_command"
}
` + AGENTS.flatMap((agent) => agent.commands).map((command) => `
p=$(command -v ${command} 2>/dev/null || :)
if ! report_agent "$p" '${command}'; then
  for d in /usr/local/bin /usr/bin /opt/bin "$HOME/.local/bin" "$HOME/.npm-global/bin" "$HOME/.bun/bin" "$HOME/.opencode/bin" "$HOME/bin" "$HOME/.cargo/bin" "$HOME"/.nvm/versions/node/*/bin /opt/node/bin; do
    if report_agent "$d/${command}" '${command}'; then break; fi
  done
fi`).join('\n') + `\npython3 - <<'OPENSHELL_RESOURCES' 2>/dev/null\n${resourceProbe}\nOPENSHELL_RESOURCES\nprintf 'openshell-agent-scan-complete\\n'\n`

export function createAgentInventory({ now = Date.now, ttl = 20_000 } = {}) {
  const cache = new Map()
  return async function inventory(client, sandbox, gatewayKey = '') {
    const key = `${gatewayKey}|${sandbox.workspace}|${sandbox.id || sandbox.name}|${sandbox.createdAt}`
    let entry = cache.get(key)
    if (sandbox.phase !== 'ready') {
      if (entry) entry.expires = 0
      return { status: 'unavailable', agents: entry?.result?.agents ?? null, resources: null, checkedAt: entry?.result?.checkedAt ?? null }
    }
    if (entry?.pending) return entry.pending
    if (entry?.expires > now()) return entry.result
    entry ??= {}
    cache.set(key, entry)
    // Bound cached history when many different sandboxes are inspected.
    if (cache.size > 500) for (const [oldKey, old] of cache) {
      if (oldKey !== key && !old.pending) { cache.delete(oldKey); break }
    }
    entry.pending = (async () => {
      try {
        const result = await client.sandbox.exec(sandbox.name, ['/bin/sh', '-c', agentProbe], {
          workspace: sandbox.workspace || 'default', timeoutSecs: 8,
          noLoginShell: true, signal: AbortSignal.timeout(10_000),
        })
        const lines = result.stdout.toString().trim().split('\n')
        if (result.exitCode !== 0 || lines.at(-1) !== 'openshell-agent-scan-complete') throw new Error('Incomplete scan')
        const agents = AGENTS.filter((agent) => agent.commands.some((command) => lines.includes(command))).map(({ name }) => name)
        const resourceLine = lines.find((line) => line.startsWith('openshell-agent-resources:'))
        let resources = null
        try { resources = JSON.parse(resourceLine?.slice('openshell-agent-resources:'.length)) } catch { /* Resource scans can fail independently. */ }
        entry.result = { status: 'checked', agents, resources, checkedAt: new Date(now()).toISOString() }
      } catch {
        entry.result = { status: 'unavailable', agents: entry.result?.agents ?? null, resources: null, checkedAt: entry.result?.checkedAt ?? null }
      }
      entry.expires = now() + ttl
      return entry.result
    })()
    try { return await entry.pending } finally { entry.pending = null }
  }
}

export const agentInventory = createAgentInventory()
