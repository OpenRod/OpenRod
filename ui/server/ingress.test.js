import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { OpenShellClient } from '@nvidia/openshell-sdk'

// Real gateway registrations and deadline persistence; the transport holds the
// exposed services so expiration can be observed without opening network ports.
test('expiry closes only its originating gateway and workspace after selection changes', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'openshell-ingress-scope-'))
  const previousConfig = process.env.XDG_CONFIG_HOME
  const previousData = process.env.OPENSHELL_CONSOLE_DATA_DIR
  process.env.XDG_CONFIG_HOME = path.join(root, 'config')
  process.env.OPENSHELL_CONSOLE_DATA_DIR = path.join(root, 'state')
  t.after(async () => {
    if (previousConfig === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = previousConfig
    if (previousData === undefined) delete process.env.OPENSHELL_CONSOLE_DATA_DIR
    else process.env.OPENSHELL_CONSOLE_DATA_DIR = previousData
    await fs.rm(root, { recursive: true, force: true })
  })
  for (const name of ['deadline-one', 'deadline-two']) {
    const directory = path.join(process.env.XDG_CONFIG_HOME, 'openshell', 'gateways', name)
    await fs.mkdir(path.join(directory, 'mtls'), { recursive: true })
    await fs.writeFile(path.join(directory, 'metadata.json'), JSON.stringify({ gateway_endpoint: `https://${name}.example`, auth_mode: 'mtls', is_remote: true }))
    for (const file of ['ca.crt', 'tls.crt', 'tls.key']) await fs.writeFile(path.join(directory, 'mtls', file), 'test transport')
  }
  const services = new Map()
  const serviceKey = (endpoint, request) => JSON.stringify([endpoint, request.workspaceScope.selection.value, request.sandbox, request.name])
  t.mock.method(OpenShellClient, 'connect', async ({ gateway: endpoint }) => ({
    transport: { unary() {}, stream() {} },
    raw: {
      exposeService: async (request) => {
        services.set(serviceKey(endpoint, request), { endpoint: { sandbox: request.sandbox, name: request.name, targetPort: request.targetPort } })
        return { url: `${endpoint}/service` }
      },
      deleteService: async (request) => { services.delete(serviceKey(endpoint, request)); return {} },
      listServices: async (request) => ({ services: [...services.entries()].filter(([key]) => {
        const [gateway, workspace] = JSON.parse(key)
        return gateway === endpoint && workspace === request.workspaceScope.selection.value
      }).map(([, service]) => service) }),
    },
  }))
  const { runWithContext } = await import('./gateway.js')
  const { expose, ingressOverview, sweep } = await import('./ingress.js')
  const contexts = [
    { gateway: 'deadline-one', workspace: 'alpha' },
    { gateway: 'deadline-one', workspace: 'beta' },
    { gateway: 'deadline-two', workspace: 'alpha' },
  ]
  let now = Date.now()
  t.mock.method(Date, 'now', () => now)
  const deadlines = []
  for (const [index, context] of contexts.entries()) {
    deadlines.push(await runWithContext(context, () => expose({ sandbox: 'same-name', name: 'web', port: 8080, closeAfterMinutes: index === 0 ? 5 : 60 })))
  }
  for (const [index, context] of contexts.entries()) {
    const overview = await runWithContext(context, ingressOverview)
    assert.equal(overview.services[0].expiresAt, deadlines[index].expiresAt)
  }
  now += 6 * 60_000
  await runWithContext(contexts[2], () => sweep())
  assert.deepEqual((await runWithContext(contexts[0], ingressOverview)).services, [])
  for (const context of contexts.slice(1)) {
    const overview = await runWithContext(context, ingressOverview)
    assert.deepEqual(overview.services.map(({ sandbox, name }) => ({ sandbox, name })), [{ sandbox: 'same-name', name: 'web' }])
  }
})
