// What the gateway's proxy has decided, folded per sandbox and per host. Built
// from the live audit buffer (the most recent decisions, not all of history),
// so counts are "lately", and a sandbox with no entry has simply been quiet.
export const hostOf = (destination) => destination?.split("/")[0]?.replace(/:\d+$/, "") ?? null
const isIp = (host) => /^\d+\.\d+\.\d+\.\d+$/.test(host)

export function foldTraffic(events) {
  const bySandbox = new Map()
  const byHost = new Map()
  let allowed = 0, denied = 0
  for (const e of events) {
    if (e.kind !== "audit" || !e.verdict) continue
    const verdict = e.verdict === "allowed" ? "allowed" : "denied"
    verdict === "allowed" ? allowed++ : denied++
    let box = bySandbox.get(e.sandbox)
    if (!box) bySandbox.set(e.sandbox, (box = { allowed: 0, denied: 0, hosts: new Map(), last: e.at }))
    box[verdict] += 1
    const host = hostOf(e.destination)
    if (!host || isIp(host)) continue
    const perBox = box.hosts.get(host) ?? { allowed: 0, denied: 0 }
    perBox[verdict] += 1
    box.hosts.set(host, perBox)
    let entry = byHost.get(host)
    if (!entry) byHost.set(host, (entry = { host, allowed: 0, denied: 0, sandboxes: new Set() }))
    entry[verdict] += 1
    entry.sandboxes.add(e.sandbox)
  }
  const hosts = [...byHost.values()].sort((a, b) => (b.allowed + b.denied) - (a.allowed + a.denied) || a.host.localeCompare(b.host))
  return { bySandbox, hosts, allowed, denied }
}

export const rankHosts = (hosts) => [...hosts].map(([host, n]) => ({ host, ...n })).sort((a, b) => (b.allowed + b.denied) - (a.allowed + a.denied))

// ---- development only: a synthetic fleet, to see the page at scale ----------
// Opened with `?fleet=10000`. Never reached in a production build.

const IMAGES = ["claude-sandbox:latest", "codex-sandbox:1.4", "python:3.12-slim", "node:22-alpine", "gateway default", "rust-agent:0.9", "browser-use:2"]
const GROUPS = ["coding-agents", "research", "evals", "support-bots", "data-pipelines", null]
const PROVIDERS = [["my-claude"], ["openai-prod"], ["my-claude", "github"], [], ["github"]]
const HOSTS = ["api.anthropic.com", "api.openai.com", "github.com", "pypi.org", "registry.npmjs.org", "files.pythonhosted.org", "objects.githubusercontent.com", "huggingface.co", "sentry.io", "api.stripe.com", "pastebin.com", "ngrok.io", "s3.amazonaws.com"]
const SUSPECT = new Set(["pastebin.com", "ngrok.io", "api.stripe.com"])
const PHASES = [["ready", 0.78], ["stopped", 0.12], ["provisioning", 0.04], ["completed", 0.035], ["error", 0.025]]

function seeded(seed) {
  let s = seed >>> 0
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32)
}
const pick = (rand, list) => list[Math.floor(rand() * list.length)]
function pickPhase(rand) {
  let r = rand()
  for (const [phase, p] of PHASES) { if ((r -= p) <= 0) return phase }
  return "ready"
}

export function demoFleet(size) {
  const rand = seeded(7)
  const now = Date.now()
  return Array.from({ length: size }, (_, i) => {
    const group = pick(rand, GROUPS)
    const providers = pick(rand, PROVIDERS)
    const phase = pickPhase(rand)
    return {
      id: `demo-${i}`,
      name: `${(group ?? "box").split("-")[0]}-${(i + 1).toString(36).padStart(4, "0")}`,
      workspace: "default",
      createdAt: new Date(now - rand() * 30 * 86400000).toISOString(),
      phase,
      image: pick(rand, IMAGES),
      providers,
      command: rand() > 0.3 ? ["claude"] : [],
      tty: true,
      labels: group ? { "openshell.console/group": group } : {},
      policyVersion: 1 + Math.floor(rand() * 6),
      conditions: [],
      problem: phase === "error" ? "Supervisor session lost" : null,
    }
  })
}

export function demoEvent(sandboxes, rand = Math.random, at = new Date().toISOString()) {
  const box = sandboxes[Math.floor(rand() ** 2.2 * sandboxes.length)]
  const host = rand() < 0.08 ? pick(rand, [...SUSPECT]) : HOSTS[Math.floor(rand() ** 1.8 * (HOSTS.length - 3))]
  const denied = SUSPECT.has(host) ? rand() < 0.9 : rand() < 0.03
  return {
    sandbox: box.name, at, kind: "audit", level: "OCSF", category: "NET", severity: denied ? "MED" : "INFO",
    verdict: denied ? "denied" : "allowed", destination: `${host}:443`, binary: "/usr/local/bin/claude",
    reason: denied ? "policy_dns_ineligible" : null, policy: denied ? null : "_provider_my_claude",
    message: `NET:OPEN [${denied ? "MED" : "INFO"}] ${denied ? "DENIED" : "ALLOWED"} /usr/local/bin/claude(0) -> ${host}:443 #${Math.floor(rand() * 1e9)}`,
    detail: `/usr/local/bin/claude(0) -> ${host}:443`,
  }
}

export function demoHistory(sandboxes, count = 2000) {
  const rand = seeded(11)
  const now = Date.now()
  const phase = new Map(sandboxes.map((s) => [s.name, s.phase]))
  return Array.from({ length: count }, (_, i) => demoEvent(sandboxes, rand, new Date(now - i * 1500).toISOString()))
    .filter((e) => ["ready", "error"].includes(phase.get(e.sandbox)))
}
