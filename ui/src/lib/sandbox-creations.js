// Sandbox creations that outlive the dialog that started them. Preparing a
// Quick-setup environment can take minutes, so the dialog hands the work here
// and closes; progress, build logs and the result follow the user around the
// console as a notification.
import { analytics, classifyAnalyticsError } from './analytics.js'
export function createSandboxCreations({ telemetry = analytics } = {}) {
  let snapshot = []
  const listeners = new Set()
  const runs = new Map()
  const emit = () => listeners.forEach((listener) => listener())
  const update = (id, patch) => {
    snapshot = snapshot.map((job) => job.id === id ? { ...job, ...(typeof patch === "function" ? patch(job) : patch) } : job)
    const job = snapshot.find(item => item.id === id)
    if (job?.status === 'created' && job.phase === 'ready') telemetry.ready(job.analyticsFlow)
    emit()
  }

  function run(id) {
    const job = snapshot.find((item) => item.id === id)
    const { task } = runs.get(id)
    const controller = new AbortController()
    const tracked = telemetry.startFlow('sandbox_creation', job.analyticsProperties, job.analyticsFlow)
    runs.set(id, { task, controller })
    update(id, { status: "preparing", message: "Preparing environment…", error: null, build: null, analyticsFlow: tracked })
    const report = {
      signal: controller.signal,
      progress: (message) => update(id, { message }),
      build: (build) => { telemetry.step(tracked, 'building_image'); update(id, (current) => ({ build: { ...build, logs: build.logs ?? current.build?.logs } })) },
      creating: () => { telemetry.step(tracked, 'creating'); update(id, { status: "creating", message: "Creating sandbox…" }) },
    }
    task(report).then((sandbox) => {
      if (controller.signal.aborted) { telemetry.finishFlow(tracked, 'cancelled'); return update(id, { status: "cancelled", message: "Creation cancelled." }) }
      telemetry.finishFlow(tracked, 'created')
      update(id, { status: "created", sandbox: { ...sandbox, location: sandbox.location ?? job.location }, message: "" })
    }).catch((error) => {
      if (controller.signal.aborted || error.name === "AbortError") { telemetry.finishFlow(tracked, 'cancelled'); update(id, { status: "cancelled", message: "Creation cancelled." }) }
      else { telemetry.finishFlow(tracked, 'failed', snapshot.find(item => item.id === id)?.build?.status === 'failed' ? 'image_build' : classifyAnalyticsError(error)); update(id, { status: "failed", error: error.message, code: error.code ?? null, fix: error.fix ?? null, message: "" }) }
    })
  }

  return {
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
    getSnapshot: () => snapshot,
    // `task` receives { signal, progress, build, creating } and resolves to the created sandbox.
    start({ name, location, task, analyticsProperties, analyticsFlow }) {
      const id = crypto.randomUUID()
      snapshot = [...snapshot, { id, name, location, status: "preparing", analyticsProperties, analyticsFlow }]
      runs.set(id, { task })
      run(id)
      return id
    },
    // Only a failed job reruns; a late retry (Connect's `then`) must not start a second task.
    retry(id) { if (runs.has(id) && snapshot.find((job) => job.id === id)?.status === "failed") run(id) },
    cancel(id) {
      const job = snapshot.find((item) => item.id === id)
      if (job?.status !== "preparing") return
      runs.get(id)?.controller?.abort()
      update(id, { message: "Cancelling…" })
    },
    update,
    dismiss(id) { runs.delete(id); snapshot = snapshot.filter((job) => job.id !== id); emit() },
  }
}

export const sandboxCreations = createSandboxCreations()
