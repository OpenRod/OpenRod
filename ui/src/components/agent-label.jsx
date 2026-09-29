import { Bot } from "lucide-react"

export function AgentLabel({ agent = { name: "Not reported" } }) {
  return <span className="inline-flex min-w-0 max-w-full items-center gap-1.5 align-middle" title={`AI agent: ${agent.name}`}>
    {agent.logo ? <img src={agent.logo} alt="" className="size-3.5 shrink-0 object-contain" /> : <Bot aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" strokeWidth={1.5} />}
    <span className="truncate">{agent.name}</span>
  </span>
}

export function AgentList({ agents = [], status = "Agent inventory not checked" }) {
  if (!agents.length) return <span className="text-muted-foreground">{status}</span>
  return <span title={status} className="flex min-w-0 flex-col items-start gap-1.5">
    {agents.map((agent) => <AgentLabel key={agent.name} agent={agent} />)}
  </span>
}
