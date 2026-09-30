import { AGENTS } from "./image-templates.js"

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

export function sessionCommand(sandbox) {
  const session = sandbox.labels?.[SESSION_LABEL]
  // Sandbox names are validated by the server; quote defensively for copied commands.
  const name = `'${sandbox.name.replaceAll("'", "'\\''")}'`
  // A checked label value has only letters, digits, '-', '_' and '.', so the path needs no quoting.
  const project = projectOf(sandbox)
  const workdir = project ? ` --workdir /sandbox/${project}` : ""
  if (isSession(session)) return `openshell sandbox exec --name ${name}${workdir} --tty -- ${SESSIONS[session]}`
  return `openshell sandbox connect ${name}`
}
