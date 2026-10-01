import { groupsFromLabels } from "../../shared/group-membership.js"
// Gateway phases folded onto the OpenRod Desk status palette. The palette has five
// states and the gateway ten; the fold keeps each colour meaning one thing.
export const STATUS = {
  running: { label: "Ready", bar: "bg-emerald-500", strip: "bg-emerald-500", cell: "bg-emerald-500/85", ring: "ring-emerald-600/30" },
  sleeping: { label: "Stopped", bar: "bg-stone-300", strip: "bg-stone-400", cell: "bg-stone-300", ring: "ring-stone-400/40" },
  provisioning: { label: "Preparing", bar: "bg-amber-400", strip: "bg-amber-400", cell: "bg-amber-400", ring: "ring-amber-600/30" },
  error: { label: "Needs attention", bar: "bg-red-500", strip: "bg-red-500", cell: "bg-red-500", ring: "ring-red-600/40" },
  unknown: { label: "Unverified", bar: "bg-stone-200", strip: "bg-stone-300", cell: "bg-stone-200", ring: "ring-stone-400/30" },
}
export const STATUS_ORDER = ["running", "sleeping", "provisioning", "error", "unknown"]

const FOLD = {
  ready: "running",
  provisioning: "provisioning", starting: "provisioning", stopping: "provisioning",
  stopped: "sleeping", completed: "sleeping",
  error: "error",
  deleting: "unknown", unknown: "unknown", unspecified: "unknown",
}

// The gateway's own word, for the places that should be exact.
export const PHASE_LABEL = {
  ready: "Ready", provisioning: "Provisioning", starting: "Starting", stopping: "Stopping",
  stopped: "Stopped", completed: "Completed", error: "Error", deleting: "Deleting",
  unknown: "Unknown", unspecified: "Unknown",
}

export const statusOf = (phase) => FOLD[phase] ?? "unknown"
export const styleOf = (phase) => STATUS[statusOf(phase)]

// A sandbox is "Completed" when its main process exited; it cannot be
// restarted, only replaced. Stop/start apply to the rest.
export const canStop = (phase) => ["ready", "provisioning", "starting"].includes(phase)
export const canStart = (phase) => phase === "stopped"

export const commandText = (command) => (command?.length ? command.join(" ") : "Scratch shell")
export const imageName = (image, templateName) => templateName || (/^sha256:[a-f0-9]{64}$/i.test(image ?? "") ? "Unknown template" : image) || "Gateway default"

export function summarize(sandboxes) {
  const status = Object.fromEntries(STATUS_ORDER.map((key) => [key, 0]))
  for (const sandbox of sandboxes) status[statusOf(sandbox.phase)] += 1
  return { total: sandboxes.length, status }
}

export const GROUP_LABEL = "openshell.console/group"

export function groupKey(sandbox, by) {
  if (by === "group") return groupsFromLabels(sandbox.labels).sort().join(", ") || "No group"
  if (by === "image") return imageName(sandbox.image, sandbox.imageTemplateName)
  if (by === "provider") return sandbox.providers.length ? sandbox.providers.join(", ") : "No provider"
  return PHASE_LABEL[sandbox.phase] ?? "Unknown"
}

export function destinationOf(chunk) {
  const endpoint = chunk.endpoints?.[0]
  if (!endpoint) return chunk.ruleName
  return endpoint.port ? `${endpoint.host}:${endpoint.port}` : endpoint.host
}

export const programName = (path) => (path ? path.split("/").pop() : "Unknown program")

export const ownerOf = (sandbox) => sandbox.owner || sandbox.labels?.["openshell.console/owner"] || sandbox.labels?.owner || "Not reported"
export const creatorOf = (sandbox) => sandbox.createdBy || sandbox.labels?.["openshell.console/created-by"] || "Not reported"

export function elapsedSince(value, now = Date.now()) {
  const time = Date.parse(value)
  if (!Number.isFinite(time)) return "Not reported"
  const minutes = Math.max(0, Math.floor((now - time) / 60000))
  if (minutes < 1) return "<1m"
  if (minutes < 60) return `${minutes}m`
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
  return `${Math.floor(minutes / 1440)}d ${Math.floor(minutes % 1440 / 60)}h`
}

export function uptimeOf(sandbox, now = Date.now()) {
  if (["stopped", "completed"].includes(sandbox.phase)) return "Not running"
  return sandbox.phase === "ready" ? elapsedSince(sandbox.startedAt, now) : "-"
}
