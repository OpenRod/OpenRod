import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MAX_RECIPE_BYTES, RECIPE_ANNOTATION, newRecipe, recipeErrors, dockerfileFor, storedRecipe } from '../src/lib/image-templates.js'
import { imageTemplateRoute, templateView } from './image-templates.js'

test('image recipe does not compile launch variables or permissions into an image', () => {
  const recipe = newRecipe({ name: 'frontend', runtimes: ['node', 'python'], agents: ['codex'], environment: [{ name: 'APP_MODE', value: 'development' }], command: 'codex', policy: { rules: ['allow-all'] } })
  assert.deepEqual(recipeErrors(recipe), {})
  const result = dockerfileFor(recipe)
  assert.match(result, /COPY --from=node:22-bookworm-slim/)
  assert.match(result, /python3 -m venv/)
  assert.match(result, /npm install --global @openai\/codex/)
  assert.match(result, /USER sandbox/)
  assert.doesNotMatch(result, /APP_MODE|development|allow-all/)
})

test('the default recipe installs Claude Code and starts in it', () => {
  const recipe = newRecipe({ name: 'app' })
  assert.deepEqual(recipeErrors(recipe), {})
  assert.equal(recipe.command, 'claude')
  assert.match(dockerfileFor(recipe), /claude\.ai\/install\.sh/)
})

test('rejects names OpenShell would refuse, shell options, Dockerfile injection, credential variables and credentialed repositories', () => {
  for (const [patch, field] of [
    [{ name: 'Frontend App' }, 'name'],
    [{ name: '-app' }, 'name'],
    [{ name: 'a-name-longer-than-19' }, 'name'],
    [{ base: 'ubuntu:24.04\nRUN whoami' }, 'base'],
    [{ packages: ['git;echo nope'] }, 'packages'],
    [{ image: '--help', source: 'image' }, 'image'],
    [{ environment: [{ name: 'API_KEY', value: 'not-a-real-key' }] }, 'environment'],
    [{ repository: 'https://user:password@example.com/repo' }, 'repository'],
    [{ repository: 'https://example.com/repo\nRUN echo nope' }, 'repository'],
  ]) assert.ok(recipeErrors(newRecipe({ name: 'test', ...patch }))[field], field)
})

test('the stored recipe fits in one gateway annotation and leaves environment to the template', () => {
  const recipe = newRecipe({ name: 'app', environment: [{ name: 'MODE', value: 'dev' }], setup: 'npm ci' })
  const stored = storedRecipe(recipe)
  assert.equal(stored.name, undefined)
  assert.equal(stored.environment, undefined)
  assert.equal(stored.setup, 'npm ci')
  assert.ok(recipeErrors(newRecipe({ name: 'app', setup: 'x'.repeat(5999), packages: Array.from({ length: 80 }, (_, i) => `package-${i}-${"x".repeat(40)}`) })).setup)
  assert.ok(new TextEncoder().encode(JSON.stringify(storedRecipe(newRecipe({ name: 'app', setup: 'x'.repeat(5000) })))).length <= MAX_RECIPE_BYTES)
})

test('templates read back from the gateway restore the recipe, and CLI templates stay launch-only', () => {
  const stored = storedRecipe(newRecipe({ name: 'app', repository: 'https://github.com/example/project.git', command: 'codex', agents: ['codex'] }))
  const view = templateView({ metadata: { name: 'app', annotations: { [RECIPE_ANNOTATION]: JSON.stringify(stored) } }, spec: { workload: { image: 'openshell-template/app:1', environment: { MODE: 'dev' } } } })
  assert.equal(view.managed, true)
  assert.equal(view.recipe.name, 'app')
  assert.equal(view.recipe.command, 'codex')
  assert.equal(view.recipe.repository, 'https://github.com/example/project.git')
  assert.deepEqual(view.recipe.environment, [{ name: 'MODE', value: 'dev' }])
  const cli = templateView({ metadata: { name: 'from-cli' }, spec: { workload: { image: 'ghcr.io/example/box:1' } } })
  assert.equal(cli.managed, false)
  assert.equal(cli.recipe.source, 'image')
  assert.equal(cli.recipe.command, '')
})

test('invalid recipes and secret names fail before Docker or the gateway is touched', async () => {
  for (const recipe of [null, newRecipe(), newRecipe({ name: 'app', agents: [null] }), newRecipe({ name: 'app', environment: [{ name: 'ACCESS_TOKEN', value: 'fake' }] })]) {
    await assert.rejects(imageTemplateRoute('POST', ['image-templates'], { recipe }))
  }
  await assert.rejects(imageTemplateRoute('POST', ['image-templates', '../policy', 'delete'], {}), /Unknown image template/)
})

test('every agent choice generates an installer and its required runtime', async () => {
  const { AGENTS } = await import('../src/lib/image-templates.js')
  assert.equal(AGENTS.length, 11)
  assert.equal(AGENTS.filter((a) => a.featured).length, 4)
  for (const agent of AGENTS) {
    const recipe = newRecipe({ name: agent.name, agents: [agent.id] })
    assert.deepEqual(recipeErrors(recipe), {})
    const dockerfile = dockerfileFor(recipe)
    if (agent.npm) {
      assert.ok(dockerfile.includes(agent.npm))
      assert.match(dockerfile, /COPY --from=node:22-bookworm-slim/)
    } else if (agent.install) {
      assert.ok(dockerfile.includes(`RUN ${agent.install} && command -v ${agent.command}`))
      assert.ok(dockerfile.indexOf(`RUN ${agent.install}`) > dockerfile.indexOf('USER sandbox'))
    } else assert.ok(dockerfile.includes(agent.id === 'aider' ? 'aider-chat' : 'https://claude.ai/install.sh'))
  }
})

test('custom agent install scripts persist and remain separate from Dockerfile instructions', async () => {
  const command = 'printf "%s\\n" "hello"\n# FROM must not become a Dockerfile directive\nexport AGENT_TEST=1'
  const saved = await imageTemplateRoute('POST', ['image-templates'], { recipe: newRecipe({ name: 'Custom agent', customAgentInstall: command }) })
  const loaded = await readImageTemplate(saved.id)
  assert.equal(loaded.recipe.customAgentInstall, command)
  const dockerfile = dockerfileFor(loaded.recipe)
  assert.match(dockerfile, /COPY --chown=1000:1000 custom-agents.sh/)
  assert.match(dockerfile, /RUN bash -euo pipefail \/tmp\/custom-agents.sh/)
  assert.ok(dockerfile.indexOf('RUN bash -euo') > dockerfile.indexOf('USER sandbox'))
  assert.ok(!dockerfile.includes('AGENT_TEST'))
  assert.ok(!dockerfileFor(newRecipe()).includes('custom-agents.sh'))
})

test('custom install command rejects malformed and oversized values', async () => {
  for (const value of [42, 'x'.repeat(12001), 'echo\0bad']) {
    assert.ok(recipeErrors(newRecipe({ name: 'Custom', customAgentInstall: value })).customAgentInstall)
  }
  await assert.rejects(imageTemplateRoute('POST', ['image-templates'], { recipe: newRecipe({ name: 'Custom', customAgentInstall: {} }) }), /Invalid customAgentInstall/)
})
