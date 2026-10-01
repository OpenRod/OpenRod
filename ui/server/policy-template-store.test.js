import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createTemplateStore } from './policy-template-store.js'
import { validateTemplate, templateToPolicy } from './policy.js'
import { BUILTIN_TEMPLATES, composeTemplate } from '../shared/policy-templates.js'

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'policy-store-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const reopen = () => createTemplateStore({ directory, builtins: BUILTIN_TEMPLATES, validate: validateTemplate })
  return { directory, store: reopen(), reopen }
}

test('built-in edits persist and changed endpoints are used by saved combinations', async t => {
  const { store, reopen } = await fixture(t)
  const npm = await store.find('node-packages')
  await store.save({ ...npm, name: 'Internal npm', rules: [{ ...npm.rules[0], endpoints: [{ ...npm.rules[0].endpoints[0], host: 'npm.example.com' }] }] })
  await store.save({ ...BUILTIN_TEMPLATES[0], id: 'project', name: 'Project', accessTemplates: ['node-packages'] })
  const restarted = reopen()
  assert.equal((await restarted.find('node-packages')).name, 'Internal npm')
  const policy = templateToPolicy(composeTemplate(await restarted.find('project'), [], await restarted.list()))
  assert.equal(policy.networkPolicies.npm.endpoints[0].host, 'npm.example.com')
  assert.equal((await restarted.find('node-packages')).kind, 'access')
})

test('bulk deletion persists across reloads and does not resurrect built-in defaults', async t => {
  const { store, reopen } = await fixture(t)
  await store.deleteMany(['locked-down', 'node-packages'])
  const restarted = reopen()
  assert.equal(await restarted.find('locked-down'), null)
  assert.equal(await restarted.find('node-packages'), null)
  assert(!(await restarted.list()).some(item => item.id === 'node-packages'))
  const catalog = await restarted.list()
  assert.throws(() => composeTemplate(BUILTIN_TEMPLATES[0], ['node-packages'], catalog), /valid additional access/)
})

test('referenced additions block the whole deletion unless the dependent policy is selected too', async t => {
  const { store } = await fixture(t)
  await store.save({ ...BUILTIN_TEMPLATES[0], id: 'project', name: 'Project', accessTemplates: ['node-packages'] })
  await assert.rejects(store.deleteMany(['node-packages', 'python-packages']), /Project.*uses a selected policy/)
  assert(await store.find('python-packages'))
  await store.deleteMany(['project', 'node-packages'])
  assert.equal(await store.find('project'), null)
  assert.equal(await store.find('node-packages'), null)
})

test('group references prevent deletion and concurrent edits do not overwrite each other', async t => {
  const { store, directory } = await fixture(t)
  await fs.mkdir(path.join(directory, 'org', 'groups'), { recursive: true })
  await fs.writeFile(path.join(directory, 'org', 'groups', 'dev.json'), JSON.stringify({ id: 'dev', name: 'Development', template: 'locked-down' }))
  await assert.rejects(store.deleteMany(['locked-down', 'github-read']), /Development/)
  assert(await store.find('github-read'))
  const python = await store.find('python-packages'), npm = await store.find('node-packages')
  await Promise.all([store.save({ ...python, name: 'Python downloads' }), store.save({ ...npm, name: 'Node downloads' })])
  assert.equal((await store.find('python-packages')).name, 'Python downloads')
  assert.equal((await store.find('node-packages')).name, 'Node downloads')
})

test('legacy custom files can be edited and deleted without reappearing', async t => {
  const { store, directory, reopen } = await fixture(t)
  await fs.writeFile(path.join(directory, 'existing.json'), JSON.stringify({ ...BUILTIN_TEMPLATES[0], id: 'existing', name: 'Existing' }))
  await store.save({ ...await store.find('existing'), name: 'Edited' })
  assert.equal((await reopen().find('existing')).name, 'Edited')
  await store.deleteMany(['existing'])
  assert.equal(await reopen().find('existing'), null)
  assert.equal(JSON.parse(await fs.readFile(path.join(directory, 'existing.json'), 'utf8')).name, 'Existing')
})
