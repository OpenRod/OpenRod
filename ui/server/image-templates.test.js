import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { newRecipe, recipeErrors, dockerfileFor } from '../src/lib/image-templates.js'

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'openshell-template-test-'))
process.env.OPENSHELL_IMAGE_TEMPLATE_DIR = directory
const { imageTemplateRoute, readImageTemplate } = await import('./image-templates.js')
after(() => fs.rm(directory, { recursive: true, force: true }))

test('image recipe does not compile launch variables or permissions into an image', () => {
  const recipe = newRecipe({ name: 'Frontend', runtimes: ['node', 'python'], agents: ['codex'], environment: [{ name: 'APP_MODE', value: 'development' }], command: 'codex', policy: { rules: ['allow-all'] } })
  assert.deepEqual(recipeErrors(recipe), {})
  const result = dockerfileFor(recipe)
  assert.match(result, /COPY --from=node:22-bookworm-slim/)
  assert.match(result, /python3 -m venv/)
  assert.match(result, /npm install --global @openai\/codex/)
  assert.match(result, /USER sandbox/)
  assert.doesNotMatch(result, /APP_MODE|development|allow-all/)
})

test('rejects shell options, Dockerfile injection, path traversal, credential variables and credentialed repositories', () => {
  for (const [patch, field] of [
    [{ base: 'ubuntu:24.04\nRUN whoami' }, 'base'],
    [{ packages: ['git;echo nope'] }, 'packages'],
    [{ npm: ['--prefix=/tmp'] }, 'npm'],
    [{ image: '--help', source: 'local' }, 'image'],
    [{ files: [{ path: '../escape', content: 'x' }] }, 'files'],
    [{ environment: [{ name: 'API_KEY', value: 'not-a-real-key' }] }, 'environment'],
    [{ repository: 'https://user:password@example.com/repo' }, 'repository'],
    [{ repository: 'https://example.com/repo\nRUN echo nope' }, 'repository'],
  ]) assert.ok(recipeErrors(newRecipe({ name: 'Test', ...patch }))[field], field)
})

test('accepts pinned package names and quotes shell metacharacters in pip constraints', () => {
  const recipe = newRecipe({ name: 'Python', pip: ['requests>=2.32'], packages: ['git', 'jq=1.7-1'] })
  assert.deepEqual(recipeErrors(recipe), {})
  assert.match(dockerfileFor(recipe), /'requests>=2.32'/)
})

test('starting files use generated context paths and literal COPY destinations', () => {
  const recipe = newRecipe({ name: 'Files', repository: 'https://github.com/example/project.git', files: [{ path: 'config/settings.json', content: '{}' }], setup: 'test -f config/settings.json' })
  assert.match(dockerfileFor(recipe), /\["files\/0","\/sandbox\/project\/config\/settings.json"\]/)
  assert.match(dockerfileFor(recipe), /bash -eu \/tmp\/template-setup.sh/)
})

test('drafts persist independently and discard attempted security fields', async () => {
  const saved = await imageTemplateRoute('POST', ['image-templates'], { recipe: newRecipe({ name: 'Saved draft', policy: { allowAll: true }, template: 'privileged' }) })
  assert.equal(saved.status, 'draft')
  const loaded = await readImageTemplate(saved.id)
  assert.equal(loaded.recipe.name, 'Saved draft')
  assert.equal(loaded.recipe.policy, undefined)
  assert.equal(loaded.recipe.template, undefined)
  assert.equal(loaded.inspection, null)
  await imageTemplateRoute('POST', ['image-templates', saved.id, 'delete'], {})
  await assert.rejects(readImageTemplate(saved.id), /not found/)
})

test('malformed drafts and secret names cannot be saved', async () => {
  for (const recipe of [null, newRecipe({ agents: [null] }), newRecipe({ files: [null] }), newRecipe({ environment: [{ name: 'ACCESS_TOKEN', value: 'fake' }] })]) {
    await assert.rejects(imageTemplateRoute('POST', ['image-templates'], { recipe }))
  }
  await assert.rejects(readImageTemplate('../policy'), /Unknown image template/)
})

test('incomplete recipes fail before a Docker build is attempted', async () => {
  const saved = await imageTemplateRoute('POST', ['image-templates'], { recipe: newRecipe() })
  await assert.rejects(imageTemplateRoute('POST', ['image-templates', saved.id, 'build'], {}), /Give your template a name/)
})

test('an interrupted operation is never reported as available', async () => {
  const saved = await imageTemplateRoute('POST', ['image-templates'], { recipe: newRecipe({ name: 'Interrupted' }) })
  await fs.writeFile(path.join(directory, `${saved.id}.json`), JSON.stringify({ ...saved, status: 'building' }))
  const loaded = await readImageTemplate(saved.id)
  assert.equal(loaded.status, 'failed')
  assert.match(loaded.error, /server stopped/)
})
