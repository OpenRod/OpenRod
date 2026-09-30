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
