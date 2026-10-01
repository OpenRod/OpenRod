import catalog from './setup-targets.json' with { type: 'json' }

export const SETUP_AGENTS = catalog
export const SETUP_TARGETS = catalog.filter(agent => agent.config && agent.skills)
export const setupTarget = id => SETUP_TARGETS.find(agent => agent.id === id)
export const setupTargetsFor = ids => ids.filter(id => Boolean(setupTarget(id)))
export function validateSetupTargets(targets) {
  if (!Array.isArray(targets) || !targets.length || targets.length > SETUP_TARGETS.length || new Set(targets).size !== targets.length) throw new Error('Choose one or more supported agents for this Setup.')
  for (const id of targets) if (!setupTarget(id)) throw new Error(catalog.find(agent => agent.id === id)?.reason || 'Unknown Setup agent.')
  return targets
}
