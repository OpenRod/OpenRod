import test from 'node:test'
import assert from 'node:assert/strict'
import { importSetup, inactiveItems } from './import-setup.js'
import { PACKAGE_PENDING } from '../../shared/setup-launch.js'

const review = { token: 'original', items: [] }
const ready = { token: 'prepared', items: [{ name: 'tool', issues: [] }] }
function fixture(final = { status: 'complete', review: ready }) {
  const calls = []
  const api = {
    prepareSetup: async (...args) => { calls.push(['prepare', ...args]); return { id: 'job', status: 'running' } },
    setupPreparation: async id => { calls.push(['poll', id]); return { id, ...final } },
    saveSetup: async (...args) => { calls.push(['save', ...args]); return { id: 'saved' } },
  }
  return { api, calls }
}
const options = { wait: async () => {} }
test('one Import prepares, checks and saves the prepared snapshot automatically', async () => {
  const { api, calls } = fixture()
  const updates = []
  const result = await importSetup(api, review, 'Tools', {}, { ...options, onProgress: job => updates.push(job.status) })
  assert.equal(result.status, 'saved')
  assert.deepEqual(calls, [['prepare', 'original', {}], ['poll', 'job'], ['save', 'prepared', 'Tools', true]])
  assert.equal(updates[0], 'running')
})
test('credentials or incompatible items stop automatic saving and retain the prepared review', async () => {
  const attention = { ...ready, items: [{ name: 'tool', issues: ['Connect credentials'] }] }
  const { api, calls } = fixture({ status: 'complete', review: attention })
  let retained
  const result = await importSetup(api, review, 'Tools', {}, { ...options, onReview: value => { retained = value } })
  assert.equal(result.status, 'needs-attention')
  assert.equal(retained, attention)
  assert.ok(!calls.some(([action]) => action === 'save'))
})
test('cancelled, failed and interrupted imports never save', async () => {
  for (const status of ['cancelled', 'failed', 'interrupted']) {
    const { api, calls } = fixture({ status, review: ready, message: 'Stopped' })
    const run = () => importSetup(api, review, 'Tools', {}, options)
    if (status === 'cancelled') assert.equal((await run()).status, 'cancelled')
    else await assert.rejects(run, /Stopped/)
    assert.ok(!calls.some(([action]) => action === 'save'))
  }
})
test('cancellation arriving as checks complete prevents automatic saving', async () => {
  const { api, calls } = fixture()
  assert.equal((await importSetup(api, review, 'Tools', {}, { ...options, isCancelled: () => true })).status, 'cancelled')
  assert.ok(!calls.some(([action]) => action === 'save'))
})
test('resume polls the existing job without repeating preparation', async () => {
  const { api, calls } = fixture()
  await importSetup(api, review, 'Tools', {}, { ...options, resumeJob: { id: 'job', status: 'running' } })
  assert.deepEqual(calls.map(([action]) => action), ['poll', 'save'])
})
test('save failures retain the completed review for a save-only retry', async () => {
  const { api } = fixture()
  api.saveSetup = async () => { throw Error('Save failed') }
  let retained
  await assert.rejects(importSetup(api, review, 'Tools', {}, { ...options, onReview: value => { retained = value } }), /Save failed/)
  assert.equal(retained, ready)
})

const unsupported = { id: 'shadcn', kind: 'mcp', name: 'shadcn', issues: ['“docker” isn’t available inside sandboxes. If this MCP is published on npm, change its command to “npx -y <package>@<version>”.'] }
const pending = { id: 'magicui', kind: 'mcp', name: 'magicui', package: { name: '@magicuidesign/mcp' }, issues: [PACKAGE_PENDING] }
const github = { id: 'github', kind: 'mcp', name: 'github', configuration: { command: 'github-mcp' }, credentialFields: ['API_TOKEN'], issues: ['Connect credentials (API_TOKEN) to use this MCP. They’re kept in the gateway, never in the setup.'] }
const start = (...items) => ({ token: 'original', items })
test('issues known before Import save automatically as inactive items', async () => {
  const { api, calls } = fixture({ status: 'complete', review: { token: 'prepared', items: [unsupported, { ...pending, issues: [] }] } })
  const result = await importSetup(api, start(unsupported, pending), 'Tools', {}, options)
  assert.equal(result.status, 'saved')
  assert.deepEqual(result.inactive, ['shadcn'])
  assert.ok(calls.some(([action]) => action === 'save'))
})
test('an issue that appears during preparation keeps the review open', async () => {
  const failed = { ...pending, issues: ['Preparation failed. Retry this item; no imported code ran on your computer.'] }
  const { api, calls } = fixture({ status: 'complete', review: { token: 'prepared', items: [unsupported, failed] } })
  assert.equal((await importSetup(api, start(unsupported, pending), 'Tools', {}, options)).status, 'needs-attention')
  assert.ok(!calls.some(([action]) => action === 'save'))
})
test('package-pending issues never count as known, in either wording', async () => {
  const legacy = { ...pending, issues: ['Prepare package dependencies in the next step.'] }
  assert.deepEqual(inactiveItems(start(pending, legacy)), [])
  const { api } = fixture({ status: 'complete', review: { token: 'prepared', items: [{ ...pending, issues: [] }] } })
  assert.deepEqual(await importSetup(api, start(pending), 'Tools', {}, options), { status: 'saved', setup: { id: 'saved' }, inactive: [] })
  const stillPending = fixture({ status: 'complete', review: { token: 'prepared', items: [pending] } })
  assert.equal((await importSetup(stillPending.api, start(pending), 'Tools', {}, options)).status, 'needs-attention')
})
test('provided credentials are expected to connect; a connect failure blocks saving', async () => {
  const choices = { github: { secrets: { API_TOKEN: 'value' } } }
  assert.deepEqual(inactiveItems(start(github), {}).map(item => item.name), ['github'])
  assert.deepEqual(inactiveItems(start(github), choices), [])
  assert.deepEqual(inactiveItems(start(github), { github: { useSourceSecrets: true } }), [])
  const skipped = fixture({ status: 'complete', review: { token: 'prepared', items: [github] } })
  assert.deepEqual((await importSetup(skipped.api, start(github), 'Tools', {}, options)).inactive, ['github'])
  const connected = fixture({ status: 'complete', review: { token: 'prepared', items: [{ ...github, credentialFields: [], issues: [] }] } })
  assert.deepEqual((await importSetup(connected.api, start(github), 'Tools', choices, options)).inactive, [])
  const failed = fixture({ status: 'complete', review: { token: 'prepared', items: [{ ...github, issues: [...github.issues, 'Connect API_TOKEN to continue.'] }] } })
  assert.equal((await importSetup(failed.api, start(github), 'Tools', choices, options)).status, 'needs-attention')
  const unchanged = fixture({ status: 'complete', review: { token: 'prepared', items: [github] } })
  assert.equal((await importSetup(unchanged.api, start(github), 'Tools', choices, options)).status, 'needs-attention')
})
test('retried preparation failures block again instead of saving silently', async () => {
  const message = 'Preparation failed. Retry this item; no imported code ran on your computer.'
  const failed = { ...pending, issues: [message], preparationIssues: [message] }
  assert.deepEqual(inactiveItems(start(failed)), [])
  const { api } = fixture({ status: 'complete', review: { token: 'prepared', items: [failed] } })
  assert.equal((await importSetup(api, start(failed), 'Tools', {}, options)).status, 'needs-attention')
})
test('disabled items stay inactive without blocking or being listed', async () => {
  const disabled = { ...unsupported, disabled: true, issues: ['Disabled in the source harness.'] }
  assert.deepEqual(inactiveItems(start(disabled)), [])
  const { api } = fixture({ status: 'complete', review: { token: 'prepared', items: [{ ...disabled, issues: ['Something new'] }] } })
  assert.deepEqual((await importSetup(api, start(disabled), 'Tools', {}, options)).inactive, [])
})
test('polling retries transient errors with backoff and resets after a success', async () => {
  const { api, calls } = fixture()
  let polls = 0
  const poll = api.setupPreparation
  api.setupPreparation = async id => { polls++; if (polls <= 2 || polls === 4) throw Error('Console restarting'); return polls === 3 ? { id, status: 'running' } : poll(id) }
  const waits = []
  const result = await importSetup(api, review, 'Tools', {}, { wait: async ms => { waits.push(ms) } })
  assert.equal(result.status, 'saved')
  assert.deepEqual(waits, [1500, 3000, 4500, 1500, 3000])
  assert.ok(calls.some(([action]) => action === 'save'))
})
test('polling gives up after repeated failures', async () => {
  const { api, calls } = fixture()
  let polls = 0
  api.setupPreparation = async () => { polls++; throw Error('Console unavailable') }
  await assert.rejects(importSetup(api, review, 'Tools', {}, options), /Console unavailable/)
  assert.equal(polls, 20)
  assert.ok(!calls.some(([action]) => action === 'save'))
})
test('the saved setup carries the egress policy the save created', async () => {
  const { api } = fixture()
  const egressPolicy = { id: 'setup-saved', name: 'MCPs & Skills: Tools', created: true, destinations: ['api.github.com'], hosts: [], blocked: [], sync: { applied: [], failed: [] } }
  api.saveSetup = async () => ({ id: 'saved', egressPolicy })
  const result = await importSetup(api, review, 'Tools', {}, options)
  assert.equal(result.status, 'saved')
  assert.deepEqual(result.setup.egressPolicy, egressPolicy)
})
