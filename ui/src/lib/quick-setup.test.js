import test from 'node:test'
import assert from 'node:assert/strict'
import { QUICK_AGENTS, quickRecipe, matchingQuickTemplate, compatibleProviders, prepareQuickTemplate } from './quick-setup.js'
import { recipeErrors, dockerfileFor } from './image-templates.js'
import { agentAccessRules } from '../../shared/agent-access.js'

const ready = (id, changes = {}) => ({ name: 'saved', managed: true, image: 'local:test', status: 'ready', recipe: quickRecipe(id, 'saved'), ...changes })
test('every offered agent has a valid install recipe and reviewed access rules', () => {
  for (const id of [...QUICK_AGENTS.map((a) => a.id), 'terminal']) {
    const recipe = quickRecipe(id, 'quick-test')
    assert.deepEqual(recipeErrors(recipe), {})
    assert.equal(recipe.agents.length, id === 'terminal' ? 0 : 1)
    assert.equal(agentAccessRules(recipe).length, recipe.agents.length)
    assert.match(dockerfileFor(recipe), /USER sandbox/)
  }
  assert.throws(() => quickRecipe('not-supported'), /supported/)
})
test('reuse requires exact recipe, including environment, extra agents and setup commands', () => {
  const valid = ready('codex')
  assert.equal(matchingQuickTemplate([valid], 'codex'), valid)
  for (const recipe of [
    { ...valid.recipe, agents: ['codex', 'claude'] },
    { ...valid.recipe, setup: 'touch /tmp/extra' },
    { ...valid.recipe, environment: [{ name: 'MODE', value: 'changed' }] },
  ]) assert.equal(matchingQuickTemplate([ready('codex', { recipe })], 'codex'), undefined)
  assert.equal(matchingQuickTemplate([ready('codex', { managed: false })], 'codex'), undefined)
  assert.equal(matchingQuickTemplate([ready('codex', { status: 'building' })], 'codex'), undefined)
})
test('saved credential matching does not treat a network profile as sign-in', () => {
  const providers = [{ name: 'network', type: 'cursor' }, { name: 'claude', type: 'claude-code' }, { name: 'codex', type: 'codex' }]
  assert.deepEqual(compatibleProviders(providers, 'cursor'), [])
  assert.deepEqual(compatibleProviders(providers, 'codex').map((p) => p.name), ['codex'])
})
test('reuse returns without starting a build', async () => {
  const item = ready('codex')
  const result = await prepareQuickTemplate({ imageTemplates: async () => [item], buildImageTemplate: () => assert.fail('unexpected build') }, 'codex')
  assert.equal(result, item)
})
test('preparation waits for build readiness before returning', async () => {
  let recipe, polls = 0
  const api = {
    imageTemplates: async () => recipe ? [{ ...ready('codex'), name: recipe.name, recipe, status: ++polls > 1 ? 'ready' : 'building' }] : [],
    buildImageTemplate: async (value) => { recipe = value; return { status: 'building' } },
  }
  const result = await prepareQuickTemplate(api, 'codex', { wait: async () => {} })
  assert.equal(result.status, 'ready')
  assert.equal(polls, 2)
  assert.deepEqual(recipeErrors(recipe), {})
})
test('build failures and cancellation never return a launchable template', async () => {
  let name
  const api = {
    imageTemplates: async () => name ? [{ name, status: 'failed', error: 'Docker build failed' }] : [],
    buildImageTemplate: async (recipe) => { name = recipe.name; return { status: 'building' } },
  }
  await assert.rejects(prepareQuickTemplate(api, 'terminal', { wait: async () => {} }), /Docker build failed/)
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(prepareQuickTemplate({ imageTemplates: () => assert.fail('unexpected request') }, 'codex', { signal: controller.signal }), { name: 'AbortError' })
})
test('cancellation while a build starts cannot continue into readiness', async () => {
  const controller = new AbortController()
  let tracked
  await assert.rejects(prepareQuickTemplate({
    imageTemplates: async () => [],
    buildImageTemplate: async () => { controller.abort(); return { status: 'building' } },
  }, 'codex', { signal: controller.signal, onBuild: (name) => { tracked = name }, wait: () => assert.fail('must not poll') }), { name: 'AbortError' })
  assert.match(tracked, /^q-codex-/)
})
test('Shell startup keeps the selected agent installed and does not reuse agent startup', async () => {
  for (const agent of QUICK_AGENTS) {
    const shell = quickRecipe(agent.id, 'shell-test', 'shell')
    assert.deepEqual(shell.agents, [agent.id])
    assert.equal(shell.command, '')
    assert.equal(quickRecipe(agent.id).command, agent.command)
    assert.equal(dockerfileFor(shell), dockerfileFor(quickRecipe(agent.id, 'shell-test')))
  }
  assert.equal(matchingQuickTemplate([ready('codex')], 'codex', 'shell'), undefined)
  let built
  const api = {
    imageTemplates: async () => built ? [ready('codex', { name: built.name, recipe: built })] : [ready('codex')],
    buildImageTemplate: async (recipe) => { built = recipe; return { status: 'building' } },
  }
  const result = await prepareQuickTemplate(api, 'codex', { openIn: 'shell', wait: async () => {} })
  assert.equal(result.recipe.command, '')
  assert.deepEqual(result.recipe.agents, ['codex'])
  assert.throws(() => quickRecipe('codex', '', 'custom'), /Choose Shell/)
})
test('composed recipes deduplicate and normalize selection order for reuse', () => {
  const recipe = quickRecipe(['codex', 'claude', 'codex'], 'multi')
  assert.deepEqual(recipe.agents, ['claude', 'codex'])
  assert.equal(recipe.command, '')
  assert.deepEqual(recipeErrors(recipe), {})
  const saved = { name: 'multi', managed: true, image: 'local:multi', status: 'ready', recipe }
  assert.equal(matchingQuickTemplate([saved], ['claude', 'codex']), saved)
  assert.equal(matchingQuickTemplate([saved], ['codex']), undefined)
  assert.equal(agentAccessRules(recipe).length, 2)
  assert.match(dockerfileFor(recipe), /@openai\/codex/)
  assert.match(dockerfileFor(recipe), /install-claude/)
})
test('session selection is separate from composed images and validates installed agents', async () => {
  const { quickSession } = await import('./quick-setup.js')
  const { templateSession, sessionLaunch } = await import('./sandbox-session.js')
  const saved = { managed: true, recipe: quickRecipe(['codex', 'cursor']) }
  for (const id of ['shell', 'codex', 'cursor']) {
    const session = quickSession(['codex', 'cursor'], id)
    assert.equal(session, 'shell')
    assert.equal(templateSession(saved, session), session)
    assert.deepEqual(sessionLaunch(session, []).command, ['/bin/sleep', 'infinity'])
  }
  assert.equal(quickSession(['cursor'], 'cursor'), 'cursor-agent')
  assert.throws(() => quickSession(['codex'], 'claude'), /selected agent/)
  assert.throws(() => templateSession(saved, 'claude'), /included/)
  assert.throws(() => templateSession({ ...saved, managed: false }, 'codex'), /included/)
  assert.equal(templateSession(saved, undefined), 'shell')
  assert.deepEqual(quickRecipe([]).agents, [])
  assert.equal(quickSession([], 'shell'), 'shell')
})

test('adding a second agent overrides any previous agent session with Shell', async () => {
  const { quickSession } = await import('./quick-setup.js')
  assert.equal(quickSession(['codex'], 'codex'), 'codex')
  assert.equal(quickSession(['codex', 'claude'], 'codex'), 'shell')
  assert.equal(quickSession(['codex', 'claude'], 'claude'), 'shell')
  assert.equal(quickSession(['codex', 'claude'], 'shell'), 'shell')
  assert.equal(quickSession(['codex'], 'shell'), 'shell')
})
