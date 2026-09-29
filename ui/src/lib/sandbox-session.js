import { AGENTS } from "./image-templates.js"

export const SESSION_LABEL = "openshell.console/session"
// The folder under /sandbox that a started-from-files sandbox opens in.
export const PROJECT_LABEL = "openshell.console/project"

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
  // Label values are limited to letters, digits, '-', '_' and '.', so the path needs no quoting.
  const project = sandbox.labels?.[PROJECT_LABEL]
  const workdir = project ? ` --workdir /sandbox/${project}` : ""
  if (isSession(session)) return `openshell sandbox exec --name ${name}${workdir} --tty -- ${SESSIONS[session]}`
  return `openshell sandbox connect ${name}`
}
