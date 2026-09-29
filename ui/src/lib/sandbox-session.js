export const SESSION_LABEL = "openshell.console/session"

// What each session runs when someone connects.
const SESSIONS = { claude: "claude", codex: "codex", shell: "/bin/bash -l" }

export function sessionLaunch(session, command) {
  if (Object.hasOwn(SESSIONS, session ?? "")) {
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
  if (Object.hasOwn(SESSIONS, session ?? "")) return `openshell sandbox exec --name ${name} --tty -- ${SESSIONS[session]}`
  return `openshell sandbox connect ${name}`
}
