import { AGENTS, newRecipe } from './image-templates.js'
import { agentAccessFor } from '../../shared/agent-access.js'

export const QUICK_AGENTS = AGENTS.filter((agent) => !agentAccessFor({ source: 'build', agents: [agent.id] }).unsupported.length)
export function quickRecipe(agentId, name = '') {
  const agent = QUICK_AGENTS.find((item) => item.id === agentId)
  if (!agent && agentId !== 'terminal') throw new Error('Choose a supported agent.')
  // Sessions open on connection; the server keeps the sandbox alive independently.
  return newRecipe({ name, agents: agent ? [agent.id] : [], command: agent?.command || '' })
}

export function matchingQuickTemplate(items, agentId) {
  const expected = quickRecipe(agentId)
  return items.find((item) => item.managed && item.status === 'ready' && item.image &&
    JSON.stringify(newRecipe({ ...item.recipe, name: '' })) === JSON.stringify(expected))
}

export function compatibleProviders(providers, agentId) {
  // Match credential integrations explicitly; a generic network profile is not sign-in.
  const types = { claude: ['claude-code'], codex: ['codex'] }[agentId] || []
  return providers.filter((provider) => types.includes(provider.type))
}

const pause = (ms, signal) => new Promise((resolve, reject) => {
  const cancel = () => { clearTimeout(timer); reject(new DOMException('Preparation cancelled.', 'AbortError')) }
  const timer = setTimeout(() => { signal?.removeEventListener('abort', cancel); resolve() }, ms)
  signal?.addEventListener('abort', cancel, { once: true })
  if (signal?.aborted) cancel()
})

export async function prepareQuickTemplate(api, agentId, { signal, onProgress = () => {}, onBuild = () => {}, wait = pause } = {}) {
  const check = () => { if (signal?.aborted) throw new DOMException('Preparation cancelled.', 'AbortError') }
  check()
  const items = await api.imageTemplates()
  check()
  const existing = matchingQuickTemplate(items, agentId)
  if (existing) return existing
  const name = `q-${agentId.slice(0, 9)}-${crypto.randomUUID().slice(0, 6)}`
  onProgress('Preparing environment… First-time setup can take a few minutes.')
  const job = await api.buildImageTemplate(quickRecipe(agentId, name))
  onBuild(name)
  check()
  if (job.status === 'failed') throw new Error(job.error || 'Environment build failed.')
  for (let attempt = 0; attempt < 900; attempt++) {
    await wait(2000, signal)
    check()
    const current = (await api.imageTemplates()).find((item) => item.name === name)
    check()
    if (!current) throw new Error('The environment build disappeared. Check Templates and try again.')
    if (current.status === 'failed') throw new Error(current.error || 'Environment build failed.')
    if (current.status === 'ready') return current
  }
  throw new Error('The build is still running. Check Templates before trying again.')
}
