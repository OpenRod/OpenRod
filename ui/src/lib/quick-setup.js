import { AGENTS, RUNTIMES, newRecipe, buildFingerprint } from './image-templates.js'
import { agentAccessFor, TOOL_ACCESS } from '../../shared/agent-access.js'

export const QUICK_AGENTS = AGENTS.filter((agent) => !agentAccessFor({ source: 'build', agents: [agent.id] }).unsupported.length)
export function normalizeQuickAgents(value) {
  const ids = Array.isArray(value) ? value : value === 'terminal' ? [] : [value]
  if (ids.some((id) => !QUICK_AGENTS.some((agent) => agent.id === id))) throw new Error('Choose a supported agent.')
  return QUICK_AGENTS.filter((agent) => ids.includes(agent.id)).map((agent) => agent.id)
}

export function quickSession(ids, openIn) {
  const selected = normalizeQuickAgents(ids)
  if (selected.length !== 1 || openIn === 'shell') return 'shell'
  const agent = QUICK_AGENTS.find((agent) => agent.id === openIn && selected.includes(agent.id))
  if (!agent) throw new Error('Choose Shell or a selected agent.')
  return agent.command
}

export const QUICK_TOOLS = RUNTIMES.filter((tool) => TOOL_ACCESS[tool.id])
export function quickRecipe(agentId, name = '', openIn = 'agent', withSetups = false, setups = [], tools = []) {
  if (!['agent', 'shell'].includes(openIn)) throw new Error('Choose Shell or the selected agent.')
  if (tools.some((id) => !TOOL_ACCESS[id])) throw new Error('Choose a supported tool.')
  const runtimes = [...((withSetups || setups.length) ? ['python', 'node'] : []), ...QUICK_TOOLS.filter((tool) => tools.includes(tool.id)).map((tool) => tool.id)]
  const agents = normalizeQuickAgents(agentId)
  const agent = QUICK_AGENTS.find((item) => item.id === agents[0])
  // Composed images are independent of which session opens on connection.
  return newRecipe({ name, agents, runtimes, setups: setups.map(s => s.id), setupRevisions: Object.fromEntries(setups.map(s => [s.id, s.revision])), command: Array.isArray(agentId) || openIn === 'shell' ? '' : agent?.command || '' })
}

export function matchingQuickTemplate(items, agentId, openIn = 'agent', withSetups = false, setups = [], tools = []) {
  const expected = quickRecipe(agentId, '', openIn, withSetups, setups, tools)
  return items.find((item) => item.managed && item.status === 'ready' && item.image && item.build === buildFingerprint(expected) &&
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

export async function prepareQuickTemplate(api, agentId, { openIn = 'agent', withSetups = false, setups = [], tools = [], signal, onProgress = () => {}, onBuild = () => {}, onBuildUpdate = () => {}, wait = pause } = {}) {
  const check = () => { if (signal?.aborted) throw new DOMException('Preparation cancelled.', 'AbortError') }
  check()
  const items = await api.imageTemplates()
  check()
  const existing = matchingQuickTemplate(items, agentId, openIn, withSetups, setups, tools)
  if (existing) { onBuildUpdate(existing); return existing }
  const ids = normalizeQuickAgents(agentId)
  const label = ids.length > 1 ? 'agents' : ids[0] || 'terminal'
  const name = `q-${label.slice(0, 9)}-${crypto.randomUUID().slice(0, 6)}`
  onProgress('Preparing environment… First-time setup can take a few minutes.')
  const job = await api.buildImageTemplate(quickRecipe(agentId, name, openIn, withSetups, setups, tools))
  onBuild(name)
  onBuildUpdate({ ...job, name })
  check()
  if (job.status === 'failed') throw new Error(job.error || 'Environment build failed.')
  for (let attempt = 0; attempt < 900; attempt++) {
    await wait(2000, signal)
    check()
    const current = (await api.imageTemplates()).find((item) => item.name === name)
    check()
    if (!current) throw new Error('The environment build disappeared. Check Templates and try again.')
    onBuildUpdate(current)
    if (current.status === 'failed') throw new Error(current.error || 'Environment build failed.')
    if (current.status === 'ready') return current
  }
  throw new Error('The build is still running. Check Templates before trying again.')
}

export async function prepareQuickSetups(api, ids, accessReview, { signal, expectedRevisions = {}, onProgress = () => {}, wait = pause } = {}) {
  const check = () => { if (signal?.aborted) throw new DOMException('Preparation cancelled.', 'AbortError') }
  check()
  if (!ids.length) return { setups: [], accessReview: null }
  const saved = await api.setups()
  const setups = []
  const review = accessReview ? {} : null
  for (const id of ids) {
    check()
    const source = saved.find(s => s.id === id)
    if (!source || (accessReview && accessReview[id] !== source.revision) || (expectedRevisions[id] && expectedRevisions[id] !== source.revision)) throw new Error('A selected Setup changed. Reopen the dialog and review it again.')
    onProgress(`Preparing MCP packages for ${source.name}…`)
    let job
    try {
      job = await api.prepareLaunchSetup(id, source.revision)
      for (let attempt = 0; job.status === 'running' && attempt < 900; attempt++) {
        check()
        onProgress(job.message || `Preparing ${source.name}…`)
        await wait(2000, signal)
        check()
        job = await api.setupPreparation(job.id)
      }
      check()
      if (job.status !== 'complete' || !job.setup) throw new Error(job.message || 'Package preparation did not finish. Retry creation.')
      setups.push(job.setup)
      if (review) review[job.setup.id] = job.setup.revision
    } catch (error) {
      if (job?.id && job.status === 'running') await api.cancelSetupPreparation(job.id).catch(() => {})
      throw error
    }
  }
  return { setups, accessReview: review }
}
