// Sandbox creations that outlive the dialog that started them. Preparing a
// Quick-setup environment can take minutes, so the dialog hands the work here
// and closes; progress, build logs and the result follow the user around the
// console as a notification.
export function createSandboxCreations() {
  let snapshot = []
  const listeners = new Set()
  const runs = new Map()
  const emit = () => listeners.forEach((listener) => listener())
  const update = (id, patch) => {
    snapshot = snapshot.map((job) => job.id === id ? { ...job, ...(typeof patch === "function" ? patch(job) : patch) } : job)
    emit()
  }

  function run(id) {
    const job = snapshot.find((item) => item.id === id)
    const { task } = runs.get(id)
    const controller = new AbortController()
    runs.set(id, { task, controller })
    update(id, { status: "preparing", message: "Preparing environment…", error: null, build: null })
    const report = {
      signal: controller.signal,
      progress: (message) => update(id, { message }),
      build: (build) => update(id, (current) => ({ build: { ...build, logs: build.logs ?? current.build?.logs } })),
      creating: () => update(id, { status: "creating", message: "Creating sandbox…" }),
    }
    task(report).then((sandbox) => {
      if (controller.signal.aborted) return update(id, { status: "cancelled", message: "Creation cancelled." })
      update(id, { status: "created", sandbox: { ...sandbox, location: sandbox.location ?? job.location }, message: "" })
    }).catch((error) => {
      if (controller.signal.aborted || error.name === "AbortError") update(id, { status: "cancelled", message: "Creation cancelled." })
      else update(id, { status: "failed", error: error.message, message: "" })
    })
  }

  return {
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
    getSnapshot: () => snapshot,
    // `task` receives { signal, progress, build, creating } and resolves to the created sandbox.
    start({ name, location, task }) {
      const id = crypto.randomUUID()
      snapshot = [...snapshot, { id, name, location, status: "preparing" }]
      runs.set(id, { task })
      run(id)
      return id
    },
    retry(id) { if (runs.has(id)) run(id) },
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
