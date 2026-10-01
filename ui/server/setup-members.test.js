import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createSetupMembers } from './setup-members.js'

const A = 'a'.repeat(24), B = 'b'.repeat(24)
const identity = (id = 'box-1', gateway = 'https://gateway-a', name = 'web') => ({ name, id, gateway })
const key = ({ gateway, id }) => JSON.stringify([gateway, id])
async function storeFor(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'setup-members-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'state', 'setup-members.json')
  return { file, ...createSetupMembers(file) }
}

test('membership survives restart only for its recorded gateway and immutable sandbox id', async t => {
  const store = await storeFor(t), original = identity(), replacement = identity('box-2'), otherGateway = identity('box-1', 'https://gateway-b')
  await store.setSandboxSetups(original, [A])
  await store.addSandboxSetups(otherGateway, [B])
  await store.addSandboxSetups(replacement, [B])
  const restarted = createSetupMembers(store.file)
  assert.deepEqual(await restarted.readSetupMembers(), { [key(original)]: [A], [key(replacement)]: [B], [key(otherGateway)]: [B] })
  await restarted.forgetSandbox(replacement)
  assert.deepEqual(await restarted.readSetupMembers(), { [key(original)]: [A], [key(otherGateway)]: [B] })
  await restarted.removeSandboxSetups(original, [A])
  assert.deepEqual(await restarted.readSetupMembers(), { [key(otherGateway)]: [B] })
})

test('legacy names and malformed identity records cannot authorize setup access', async t => {
  const store = await storeFor(t), original = identity()
  await fs.mkdir(path.dirname(store.file), { recursive: true })
  await fs.writeFile(store.file, JSON.stringify({ web: [A], [key(original)]: [A, 'invalid'], '["https://gateway-a",""]': [A] }))
  assert.deepEqual(await store.readSetupMembers(), { [key(original)]: [A] })
  await assert.rejects(store.setSandboxSetups({ name: 'web', gateway: original.gateway }, [A]), /sandbox identity/)
  await assert.rejects(store.setSandboxSetups({ name: 'web', id: original.id }, [A]), /sandbox identity/)
})
