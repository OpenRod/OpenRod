import { AGENTS } from "./image-templates.js"

export const SESSION_LABEL = "openshell.console/session"

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
  if (isSession(session)) return `openshell sandbox exec --name ${name} --tty -- ${SESSIONS[session]}`
  return `openshell sandbox connect ${name}`
}
