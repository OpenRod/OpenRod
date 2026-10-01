import { currentComputeTarget } from './compute-target.js'
import { AGENTS } from "./image-templates.js"
import { agentsOf } from "./agents.js"

export const SESSION_LABEL = "openshell.console/session"
// The folder under /sandbox that a started-from-files sandbox opens in. The
// label is read back from the gateway, so its value is checked again here:
// one path segment of letters, digits, '-', '_' and '.', never "." or "..".
export const PROJECT_LABEL = "openshell.console/project"
export const projectOf = (sandbox) => {
  const value = sandbox?.labels?.[PROJECT_LABEL]
  return typeof value === "string" && /^[A-Za-z0-9]([A-Za-z0-9._-]{0,61}[A-Za-z0-9])?$/.test(value) ? value : null
}

// What each session runs when someone connects: a login shell, or an agent by
// its own command. Labels come from the gateway, so only these ever run.
const SESSIONS = { shell: "/bin/bash -l", ...Object.fromEntries(AGENTS.map((a) => [a.command, a.command])) }
export const isSession = (session) => Object.hasOwn(SESSIONS, session ?? "")

// A launch may select only Shell or a session explicitly included by the template.
export function templateSession(saved, requested) {
  const start = saved.recipe.command.trim()
  const fallback = !start ? 'shell' : start !== 'shell' && isSession(start) ? start : null
  if (requested == null) return fallback
  const installed = saved.managed && saved.recipe.source === 'build'
    ? AGENTS.filter((agent) => saved.recipe.agents.includes(agent.id)).map((agent) => agent.command) : []
  if (requested !== 'shell' && requested !== fallback && !installed.includes(requested)) throw new Error('Choose Shell or an agent included in this template.')
  if (!isSession(requested)) throw new Error('Unknown session type.')
  return requested
}

export function sessionLaunch(session, command) {
  if (isSession(session)) {
    return {
      command: ["/bin/sleep", "infinity"],
      tty: false,
      labels: { [SESSION_LABEL]: session, ...(session !== "shell" ? { "openshell.console/agents": session } : {}) },
    }
  }
  return { command, tty: command.length > 0, labels: {} }
}

const shellQuote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`

// Native terminal commands are always pinned to the gateway shown by the
// console. Exec starts a fresh console-managed session; attach reconnects to
// the sandbox's canonical TTY process.
export function connectionPlan(sandbox, { gateway, mode = "exec", executable = "openshell" } = {}) {
  if (!["exec", "attach"].includes(mode)) throw new Error("Unknown connection mode.")
  if (mode === "attach" && !sandbox.tty) throw new Error("This sandbox has no canonical TTY session.")
  const argv = ["--gateway", gateway, "sandbox"]
  if (mode === "attach") argv.push("connect", sandbox.name)
  else {
    const project = projectOf(sandbox)
    argv.push("exec", "--name", sandbox.name)
    if (project) argv.push("--workdir", `/sandbox/${project}`)
    argv.push("--tty", "--", ...sessionArgv(defaultSession(sandbox)))
  }
  return {
    mode,
    argv,
    command: [executable, ...argv].map(shellQuote).join(" "),
    session: mode === "exec" ? defaultSession(sandbox) : null,
    workdir: mode === "exec" && projectOf(sandbox) ? `/sandbox/${projectOf(sandbox)}` : null,
  }
}

// The browser terminal runs the same programs. What a tab opens by default is
// the session the sandbox was created for, or a shell for sandboxes started
// with their own command.
export const sessionArgv = (session) => (isSession(session) ? SESSIONS[session].split(" ") : null)
export const defaultSession = (sandbox) => (isSession(sandbox?.labels?.[SESSION_LABEL]) ? sandbox.labels[SESSION_LABEL] : "shell")
export const sessionName = (session) => (session === "shell" ? "Shell" : AGENTS.find((a) => a.command === session)?.name ?? session)
// A shell, plus every installed agent the console knows how to launch.
export function sessionChoices(sandbox) {
  const current = defaultSession(sandbox)
  const installed = agentsOf(sandbox).flatMap((agent) => AGENTS.filter((a) => a.name === agent.name).map((a) => a.command))
  const commands = [...new Set([...(current === "shell" ? [] : [current]), ...installed])]
  return [{ id: "shell", name: "Shell" }, ...commands.map((command) => ({ id: command, name: sessionName(command) }))]
}
// A browser terminal is its own tab; the app routes this hash to it.
export const terminalHref = (name, session, target = currentComputeTarget()) => `?target=${target}#terminal/${encodeURIComponent(name)}${session ? `?session=${encodeURIComponent(session)}` : ""}`
