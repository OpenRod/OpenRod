// Follows whether OpenShell's VM driver can see the Docker that OpenRod builds
// template images with (NVIDIA/OpenShell#4155). The server makes the change;
// this store polls its status and asks before anything restarts.

// The driver's message when it fell through to Docker Hub for a local image.
export const dockerImageProblem = (p) => /failed to resolve .*image/i.test(p ?? '') && /docker\.io/.test(p ?? '')

const restartsNothing = (s) => Array.isArray(s?.sandboxes) && !s.sandboxes.length && !s.stranded?.length && !s.conflict
const seenKeys = (sandboxes) => (sandboxes ?? []).map((s) => typeof s === 'string' ? s : `${s.workspace}/${s.name}`)

export function createGatewayDocker(api, { schedule = setTimeout, cancel = clearTimeout } = {}) {
  let snapshot = { status: null, asking: null, error: null }
  let timer = null, after = null
  const listeners = new Set()
  const set = (patch) => { snapshot = { ...snapshot, ...patch }; listeners.forEach((listener) => listener()) }

  function poll() {
    cancel(timer); timer = null
    if (listeners.size) timer = schedule(() => { void refresh() }, snapshot.status?.state === 'working' ? 2000 : 15_000)
  }

  // Runs `then` once the job the user started has finished.
  function follow(status) {
    if (!after || status?.job?.status === 'working') return
    const { id, then } = after
    after = null
    if (status?.job?.id === id && status.job.status === 'done') then?.()
  }

  async function refresh(fresh = false) {
    try {
      const status = await api.gatewayDocker(fresh)
      set({ status })
      follow(status)
      return status
    } catch { return snapshot.status } finally { poll() }
  }

  async function run(kind, seen, then, confirm = true) {
    set({ asking: snapshot.asking && { ...snapshot.asking, busy: true }, error: null })
    try {
      const status = await (kind === 'undo' ? api.undoGatewayDocker(seenKeys(seen)) : api.connectGatewayDocker(seenKeys(seen), confirm))
      set({ status, asking: null })
      if (status.state === 'working' && status.job) after = { id: status.job.id, then }
      else if (status.state !== 'mismatch') then?.()
      return status
    } catch (error) {
      if (error.code === 'GATEWAY_DOCKER_MISMATCH' && !(kind === 'undo' && error.fix === 'manual')) {
        // Something changed since the user looked: show them the current list.
        const status = await refresh(true)
        set({ asking: { kind: error.fix === 'manual' ? 'steps' : kind, then, sandboxes: kind === 'undo' ? error.sandboxes ?? null : status?.sandboxes ?? error.sandboxes ?? null, busy: false } })
      } else set({ error: error.message, asking: { ...(snapshot.asking ?? { kind, then, sandboxes: snapshot.status?.sandboxes ?? null }), busy: false } })
      return null
    } finally { poll() }
  }

  return {
    subscribe(listener) {
      listeners.add(listener)
      if (listeners.size === 1) void refresh()
      return () => { listeners.delete(listener); if (!listeners.size) { cancel(timer); timer = null } }
    },
    getSnapshot: () => snapshot,
    refresh,
    // `seen` is the sandboxes the user was shown; the server refuses if more would restart.
    connect: (seen = snapshot.asking?.sandboxes) => run('connect', seen, snapshot.asking?.then),
    undo: (seen = snapshot.asking?.sandboxes) => run('undo', seen, snapshot.asking?.then),
    ask({ kind, then } = {}) {
      const s = snapshot.status
      kind ??= s?.fix === 'manual' ? 'steps' : 'connect'
      // A stale or unloaded status can't vouch for the restart: let the server ask.
      if (kind === 'connect' && (s?.state !== 'mismatch' || restartsNothing(s))) return run('connect', [], then, s?.state === 'mismatch')
      set({ asking: { kind, then, sandboxes: kind === 'connect' ? s?.sandboxes ?? null : null, busy: false }, error: null })
    },
    close: () => set({ asking: null, error: null }),
  }
}
