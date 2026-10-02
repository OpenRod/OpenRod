import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createLocationInventory } from './location-inventory.js'
import { contextKey, contextSelection } from './gateway.js'

const local = { gateway: 'openshell', workspace: 'local-work' }
const remote = { gateway: 'console-ssh-0123456789abcdef01234567', workspace: 'remote-work', host: 'target', status: 'connected', error: null }
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'console-inventory-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const snapshot = { returnContext: local, remote: { ...remote } }
  const errors = new Map()
  const options = {
    directory,
    connections: { locationSnapshot: async () => structuredClone(snapshot) },
    listSandboxes: async () => {
      const context = contextSelection()
      if (errors.has(context.gateway)) throw new Error(errors.get(context.gateway))
      return [{ id: context.gateway === local.gateway ? 'local-id' : 'remote-id', name: 'same-name', phase: 'ready' }]
    },
    listTemplates: async () => [{ name: 'same-template', status: 'ready', image: contextSelection().gateway === local.gateway ? 'local:image' : 'remote:image' }],
  }
  return { options, snapshot, errors, inventory: createLocationInventory(options) }
}

test('same-name resources retain distinct locations and route to their owning workspace', async t => {
  const { inventory } = await fixture(t)
  const result = await inventory.refresh()
  assert.deepEqual(result.sandboxes.map(record => [record.name, record.id, record.location.context]), [
    ['same-name', 'local-id', contextKey(local)], ['same-name', 'remote-id', contextKey(remote)],
  ])
  assert.deepEqual(result.templates.map(record => [record.name, record.image, record.location.workspace]), [
    ['same-template', 'local:image', 'local-work'], ['same-template', 'remote:image', 'remote-work'],
  ])
  assert.deepEqual(await inventory.resolve(contextKey(local)), local)
  assert.deepEqual(await inventory.resolve(contextKey(remote)), { gateway: remote.gateway, workspace: remote.workspace })
  await assert.rejects(inventory.resolve(JSON.stringify(['arbitrary-gateway', 'remote-work'])), { status: 409 })
  await assert.rejects(inventory.resolve(JSON.stringify([remote.gateway, 'other-workspace'])), { status: 409 })
})

test('one failing source preserves the other inventory and remote cached rows are unavailable until recovery', async t => {
  const { inventory, errors } = await fixture(t)
  await inventory.refresh()
  errors.set(remote.gateway, 'Remote RPC failed')
  const partial = await inventory.refresh()
  assert.equal(partial.sandboxes.find(record => !record.location.remote).id, 'local-id')
  assert.deepEqual(partial.sandboxes.find(record => record.location.remote), {
    id: 'remote-id', name: 'same-name', phase: 'ready', location: {
      id: contextKey(remote), context: contextKey(remote), gateway: remote.gateway, workspace: remote.workspace,
      label: 'SSH · target', remote: true, host: 'target', connected: false, error: 'Remote RPC failed',
    },
  })
  await assert.rejects(inventory.resolve(contextKey(remote)), { status: 409 })
  assert.deepEqual(await inventory.resolve(contextKey(local)), local)
  errors.delete(remote.gateway)
  await inventory.refresh()
  assert.deepEqual(await inventory.resolve(contextKey(remote)), { gateway: remote.gateway, workspace: remote.workspace })
  errors.set(local.gateway, 'Local RPC failed')
  const remoteOnly = await inventory.refresh()
  assert.deepEqual(remoteOnly.sandboxes.map(record => record.id), ['remote-id'])
  assert.equal(remoteOnly.locations.find(location => !location.remote).error, 'Local RPC failed')
})

test('disconnected remote inventories survive server reload without querying their dead gateway', async t => {
  const { inventory, options, snapshot } = await fixture(t)
  await inventory.refresh()
  snapshot.remote.status = 'disconnected'
  const queried = []
  const disconnected = createLocationInventory({
    ...options,
    listSandboxes: async () => { queried.push(contextSelection().gateway); return [] },
    listTemplates: async () => { queried.push(contextSelection().gateway); return [] },
  })
  const result = await disconnected.refresh()
  assert.equal(queried.includes(remote.gateway), false, 'dead SSH gateway was queried')
  assert.deepEqual(result.sandboxes.map(record => [record.id, record.location.connected]), [['remote-id', false]])
  assert.deepEqual(result.templates.map(record => [record.image, record.location.connected]), [['remote:image', false]])
  await assert.rejects(disconnected.resolve(contextKey(remote)), { status: 409 })
  assert.deepEqual(await disconnected.resolve(contextKey(local)), local)
})

test('aws-eks is never an inventory source or an allowed resource owner', async t => {
  const { options, snapshot } = await fixture(t)
  snapshot.returnContext = { gateway: 'aws-eks', workspace: 'default' }
  const inventory = createLocationInventory(options)
  assert.deepEqual((await inventory.refresh()).locations.map(location => location.gateway), [remote.gateway])
  await assert.rejects(inventory.resolve(contextKey(snapshot.returnContext)), { status: 409 })
})

test('HTTP explicit owner marker rejects arbitrary locations and does not widen OpenRod Cloud context authorization', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'console-context-authorization-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const moduleUrl = new URL('./api.js', import.meta.url).href
  const securityUrl = new URL('./security.js', import.meta.url).href
  const gatewayUrl = new URL('./gateway.js', import.meta.url).href
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', `
    import { createServer, request as httpRequest } from 'node:http'
    import { once } from 'node:events'
    import { createOpenShellApi } from ${JSON.stringify(moduleUrl)}
    import { createSecurity, cloudConfig } from ${JSON.stringify(securityUrl)}
    import { contextKey } from ${JSON.stringify(gatewayUrl)}
    const other = JSON.stringify(['arbitrary-gateway', 'default'])
    async function run(security, headers = {}) {
      const api = createOpenShellApi({security, token: 'test-launch-token-' + 'x'.repeat(32)})
      const server = createServer((req,res) => security.middleware(req,res,() => api.middleware(req,res)))
      server.listen(0,'127.0.0.1'); await once(server,'listening')
      const origin = 'http://127.0.0.1:' + server.address().port
      try {
        const request = async (path, context, marker) => {
          const req = httpRequest(origin + '/api/os/' + path, {headers:{cookie:'openrod_token_' + server.address().port + '=test-launch-token-' + 'x'.repeat(32), ...headers,
            'x-openshell-context':context, ...(marker ? {'x-openshell-location':'1'} : {})}})
          const response = once(req, 'response'); req.end()
          const [res] = await response
          for await (const chunk of res) {}
          return res.statusCode
        }
        return {
          explicit: await request('sandboxes/same-name', other, true),
          staleDefault: await request('sandboxes/same-name', other, false),
          selected: await request('context', contextKey(), true),
        }
      } finally { await api.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
    }
    const local = await run(createSecurity({mode:'local'}))
    const env = {OPENROD_MODE:'cloud',OPENROD_ORG_ID:'acme',OPENROD_PUBLIC_ORIGIN:'https://acme.example.com',GOOGLE_CLOUD_PROJECT:'example-project',OPENROD_FIREBASE_API_KEY:'key',OPENROD_FIREBASE_AUTH_DOMAIN:'example-project.firebaseapp.com'}
    const auth = {verifySessionCookie:async()=>({uid:'alice',exp:Math.floor(Date.now()/1000)+3600}),getUser:async()=>({uid:'alice',emailVerified:true,providerData:[{providerId:'google.com'}],customClaims:{}})}
    const cloud = await run(createSecurity(cloudConfig(env),auth), {host:'acme.example.com',cookie:'__Host-openrod_session=session'})
    console.log(JSON.stringify({local,cloud}))
  `], {
    env: { ...process.env, XDG_CONFIG_HOME: path.join(root, 'config'), OPENSHELL_CONSOLE_DATA_DIR: path.join(root, 'state'), OPENSHELL_GATEWAY: '', OPENSHELL_WORKSPACE: '', OPENROD_MODE: 'local', OPENSHELL_CONSOLE_SWEEP: '' },
    timeout: 10000,
  })
  assert.deepEqual(JSON.parse(stdout), {
    local: { explicit: 409, staleDefault: 409, selected: 409 },
    cloud: { explicit: 409, staleDefault: 409, selected: 200 },
  })
})
