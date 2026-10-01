import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { exportTransfer, importTransfer, resolveDestinationGroups } from './cloud-transfer.js'
import { contextKey, runWithContext } from './gateway.js'
import { RECIPE_ANNOTATION, newRecipe } from '../src/lib/image-templates.js'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { policyDirectory } from './paths.js'
import { validatePolicy } from './egress.js'
import { planSandbox } from './org.js'

const origin = { gateway: 'owner-gateway', workspace: 'team' }

test('cloud export reads the sandbox, files and recipe in the requested workspace', async () => {
  const client = {
    raw: { getSandbox: async input => {
      assert.deepEqual(input.workspaceScope, { selection: { case: 'workspace', value: 'team' } })
      return { sandbox: { metadata: { name: 'demo' }, createdFromWorkloadTemplate: { name: 'app' }, spec: { template: { image: 'openshell-template/app:built' } }, status: { phase: 2 } } }
    } },
    sandbox: { async *execStream(_name, argv, options) {
      assert.equal(options.workspace, 'team')
      yield { stream: 'stdout', data: Buffer.from(argv[2].includes('find ') ? '/sandbox/main.js\0' : 'main.js\0' + Buffer.from('hello').toString('base64') + '\0false\0') }
      yield { type: 'exit', exitCode: 0 }
    } },
    sandboxTemplates: { get: async (_name, options) => {
      assert.equal(options.workspace, 'team')
      return { metadata: { name: 'app', annotations: { [RECIPE_ANNOTATION]: JSON.stringify(newRecipe({ name: 'app', setups: ['a'.repeat(24)] })) } }, spec: { workload: { image: 'openshell-template/app:built' } } }
    } },
  }
  const result = await runWithContext(origin, () => exportTransfer({ name: 'demo' }, { connect: async () => ({ client, workspace: 'team', workspaceScope: { selection: { case: 'workspace', value: 'team' } } }) }))
  assert.deepEqual(result.bundle.recipe.setups, [])
  assert.deepEqual(result.bundle.recipe.setupRevisions, {})
  assert.match(result.warning, /Reconnect saved MCP/)
})

test('transfer groups use destination policy and reject ambiguity or invalid policy before rebuilding', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'transfer-policy-'))
  const previousDirectory = process.env.OPENSHELL_CONSOLE_DATA_DIR
  process.env.OPENSHELL_CONSOLE_DATA_DIR = directory
  try {
    await runWithContext(origin, async () => {
      const policyRoot = await policyDirectory()
      await fs.mkdir(path.join(policyRoot, 'org/groups'), { recursive: true })
      await fs.mkdir(path.join(policyRoot, 'egress'), { recursive: true })
      for (const id of ['one', 'two', 'uncovered']) await fs.writeFile(path.join(policyRoot, 'org/groups', id + '.json'), JSON.stringify({ id }))
      const writeRule = async id => fs.writeFile(path.join(policyRoot, 'egress', id + '.json'), JSON.stringify(validatePolicy({ id, name: id, action: 'allow', destinations: ['example.com'], appliesTo: { groups: [id] } })))
      const bundle = { version: 1, launch: { name: 'demo', image: 'ubuntu:24.04', session: 'shell' }, recipe: newRecipe({ name: 'app' }), files: [] }
      const request = extra => Readable.from([JSON.stringify({ ...bundle, ...extra })])
      const effects = []
      const operations = {
        rebuild: async () => { effects.push('rebuild'); return 'imported' },
        createSandbox: async spec => {
          // Exercise the same required-group plan used by normal provisioning.
          const plan = await planSandbox({ name: spec.name, groups: spec.groups, requireGroup: true })
          assert.deepEqual(plan.groups, spec.groups)
          assert.ok(plan.policy.networkPolicies['egress_' + spec.groups[0]])
          effects.push('create')
          return { name: spec.name }
        },
        waitReady: async () => {},
      }
      await assert.rejects(importTransfer(request(), operations), /Add a network rule to a destination group/)
      assert.deepEqual(effects, [])
      await writeRule('one')
      assert.deepEqual(await resolveDestinationGroups({ name: 'imported' }), ['one'])
      await importTransfer(request(), operations)
      assert.deepEqual(effects, ['rebuild', 'create'])
      effects.length = 0
      await writeRule('two')
      await assert.rejects(importTransfer(request(), operations), /Choose a destination group/)
      for (const destinationGroups of [[], ['missing'], ['uncovered']]) await assert.rejects(importTransfer(request({ destinationGroups }), operations))
      assert.deepEqual(effects, [])
      await importTransfer(request({ destinationGroups: ['two'] }), operations)
      assert.deepEqual(effects, ['rebuild', 'create'])
      effects.length = 0
      // Preflight also applies organization blocking of recipe agent access.
      await fs.writeFile(path.join(policyRoot, 'org/organization.json'), JSON.stringify({ blocked: ['api.anthropic.com'] }))
      await assert.rejects(importTransfer(request({ destinationGroups: ['one'] }), operations), /organization blocks/)
      assert.deepEqual(effects, [])
      await assert.rejects(planSandbox({ name: 'ordinary', requireGroup: true }), /Choose at least one group/)
    })
    await runWithContext({ gateway: 'other-destination', workspace: 'team' }, async () => {
      await assert.rejects(resolveDestinationGroups({ name: 'imported', destinationGroups: ['one'] }), /Unknown group/)
    })
  } finally {
    if (previousDirectory === undefined) delete process.env.OPENSHELL_CONSOLE_DATA_DIR
    else process.env.OPENSHELL_CONSOLE_DATA_DIR = previousDirectory
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test('import retains the destination context throughout rebuild, create, readiness and upload', async () => {
  const recipe = newRecipe({ name: 'app' })
  const bundle = { version: 1, launch: { name: 'demo', image: 'ubuntu:24.04', session: 'shell' }, recipe, files: [{ path: 'main.js', data: Buffer.from('hello').toString('base64') }] }
  const expected = JSON.stringify([origin.gateway, origin.workspace]), calls = []
  const record = async step => {
    calls.push(step)
    assert.equal(contextKey(), expected)
    await runWithContext({ gateway: 'other', workspace: 'elsewhere' }, async () => { await Promise.resolve(); assert.notEqual(contextKey(), expected) })
    assert.equal(contextKey(), expected)
  }
  await runWithContext(origin, () => importTransfer(Readable.from([JSON.stringify(bundle)]), {
    resolveGroups: async () => { await record('groups'); return ['destination'] },
    rebuild: async () => { await record('rebuild'); return 'imported-template' },
    createSandbox: async spec => { assert.deepEqual(spec.groups, ['destination']); await record('create'); return { name: 'copied' } },
    waitReady: async () => record('ready'),
    upload: async () => record('upload'),
  }))
  assert.deepEqual(calls, ['groups', 'rebuild', 'create', 'ready', 'upload'])
})
