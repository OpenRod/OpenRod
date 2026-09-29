export const AGENTS = [
  { name: "Claude Code", logo: "claudecode", commands: ["claude", "claude-code"] },
  { name: "Codex", logo: "codex", commands: ["codex"] },
  { name: "GitHub Copilot", logo: "copilot", commands: ["copilot"] },
  { name: "Cursor", logo: "cursor", commands: ["cursor-agent", "agent"], aliases: ["Cursor CLI"] },
  { name: "Gemini CLI", logo: "gemini", commands: ["gemini"] },
  { name: "OpenCode", logo: "opencode", commands: ["opencode"] },
  { name: "OpenClaw", logo: "openclaw-color", commands: ["openclaw"] },
  { name: "Pi", logo: "pi", commands: ["pi"] },
  { name: "Antigravity CLI", logo: "antigravity", commands: ["agy"], aliases: ["Antigravity"] },
  { name: "Kiro CLI", logo: "kiro", commands: ["kiro-cli"], aliases: ["Kiro"] },
  { name: "Factory Droid", logo: "factory", commands: ["droid"], aliases: ["Droid", "Factory"] },
  { name: "Aider", logo: "aider", commands: ["aider"] },
]

// A completed runtime inventory is authoritative, including an empty result.
// Labels and launch commands remain a fallback until a scan is available.
export function agentsOf(sandbox) {
  const labels = sandbox?.labels ?? {}
  const metadata = labels["openshell.console/agents"] || labels["openshell.console/agent"]
  const names = typeof metadata === "string" ? metadata.split(/[,\n]/).map((name) => name.trim()).filter(Boolean) : []
  const executable = Array.isArray(sandbox?.command) ? sandbox.command[0]?.split("/").pop() : null
  const installed = sandbox?.agentInventory?.agents
  const explicit = names.length > 0
  // The generic launch name "agent" needs runtime identity evidence.
  const values = Array.isArray(installed) ? installed : explicit ? names : executable && executable !== "agent" ? [executable] : []
  const agents = values.flatMap((value) => {
    const known = AGENTS.find((agent) => agent.name.toLowerCase() === value.toLowerCase() || agent.commands.includes(value.toLowerCase()) || agent.aliases?.some((alias) => alias.toLowerCase() === value.toLowerCase()))
    if (known) return [{ name: known.name, logo: `/logos/agents/${known.logo}.svg` }]
    return explicit ? [{ name: value, logo: null }] : []
  })
  return agents.filter((agent, index) => agents.findIndex((item) => item.name.toLowerCase() === agent.name.toLowerCase()) === index)
}

export function agentInventoryLabel(sandbox) {
  const inventory = sandbox?.agentInventory
  if (inventory?.status === "checked") return inventory.agents.length ? "Installed agents" : "No supported agents found"
  if (inventory?.checkedAt) return "Last detected agents · scan unavailable"
  if (inventory?.status === "unavailable") return "Agent scan unavailable"
  return "Agent inventory not checked"
}
