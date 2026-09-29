import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { agentProbe, createAgentInventory } from './agent-inventory.js'
import { agentsOf, agentInventoryLabel } from '../src/lib/agents.js'

const exec = promisify(execFile)
const sandbox = { id: 'one', name: 'test', workspace: 'default', phase: 'ready' }
const output = (...agents) => ({ exitCode: 0, stdout: Buffer.from([...agents, 'openshell-agent-scan-complete', ''].join('\n')) })

test('discovers PATH executables and later user installs without running them', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-probe-'))
  try {
    const bin = path.join(home, 'image-bin'), local = path.join(home, '.local/bin')
    await fs.mkdir(bin); await fs.mkdir(local, { recursive: true })
    const install = async (file) => fs.writeFile(file, '#!/bin/sh\nexit 99\n', { mode: 0o755 })
    await install(path.join(bin, 'claude'))
    const probe = async () => (await exec('/bin/sh', ['-c', agentProbe], { env: { HOME: home, PATH: bin } })).stdout.trim().split('\n')
    assert.ok((await probe()).includes('claude'))
    assert.ok(!(await probe()).includes('codex'))
    await install(path.join(local, 'codex'))
    assert.ok((await probe()).includes('codex'))
    await fs.unlink(path.join(local, 'codex'))
    assert.ok(!(await probe()).includes('codex'))
    await fs.writeFile(path.join(local, 'opencode'), 'not executable', { mode: 0o644 })
    assert.ok(!(await probe()).includes('opencode'))
  } finally { await fs.rm(home, { recursive: true, force: true }) }
})

test('coalesces scans, refreshes additions/removals and overrides stale labels', async () => {
  let time = 0, calls = 0, installed = ['claude']
  const inventory = createAgentInventory({ now: () => time, ttl: 20 })
  const client = { sandbox: { exec: async () => { calls++; return output(...installed) } } }
  const [first, same] = await Promise.all([inventory(client, sandbox), inventory(client, sandbox)])
  assert.equal(calls, 1); assert.deepEqual(first, same)
  installed = ['claude', 'codex']; time = 21
  assert.deepEqual((await inventory(client, sandbox)).agents, ['Claude Code', 'Codex'])
  installed = []; time = 42
  const empty = await inventory(client, sandbox)
  assert.deepEqual(agentsOf({ labels: { 'openshell.console/agents': 'claude' }, agentInventory: empty }), [])
  assert.equal(agentInventoryLabel({ agentInventory: empty }), 'No supported agents found')
})

test('failure retains last detected inventory; stopped sandboxes are not executed', async () => {
  let time = 0, fail = false, calls = 0
  const inventory = createAgentInventory({ now: () => time, ttl: 20 })
  const client = { sandbox: { exec: async () => { calls++; if (fail) throw Error('offline'); return output('codex') } } }
  await inventory(client, sandbox)
  time = 21; fail = true
  const unavailable = await inventory(client, sandbox)
  assert.equal(unavailable.status, 'unavailable')
  assert.deepEqual(unavailable.agents, ['Codex'])
  assert.match(agentInventoryLabel({ agentInventory: unavailable }), /Last detected/)
  await inventory(client, { ...sandbox, phase: 'stopped' })
  assert.equal(calls, 2)
  const recreated = await inventory(client, { ...sandbox, id: 'two' })
  assert.equal(recreated.agents, null)
})

test('incomplete exec output is unavailable, never a successful empty inventory', async () => {
  const inventory = createAgentInventory()
  const client = { sandbox: { exec: async () => ({ exitCode: 0, stdout: Buffer.from('claude\n') }) } }
  assert.equal((await inventory(client, sandbox)).status, 'unavailable')
  assert.deepEqual(agentsOf({ command: ['bash', 'codex'], image: 'codex:latest', providers: ['codex'] }), [])
})

test('all supported CLI names normalize to an existing SVG and deduplicate aliases', async () => {
  const { AGENTS } = await import('../src/lib/agents.js')
  for (const agent of AGENTS) {
    const inventory = createAgentInventory()
    const client = { sandbox: { exec: async () => output(...agent.commands) } }
    const detected = agentsOf({ agentInventory: await inventory(client, sandbox) })
    assert.equal(detected.length, 1)
    assert.equal(detected[0].name, agent.name)
    const svg = await fs.readFile(new URL(`../public${detected[0].logo}`, import.meta.url), 'utf8')
    assert.match(svg, /<svg\b/)
    assert.doesNotMatch(svg, /<script\b|<foreignObject\b|\bon\w+=|(?:href|src)=["']https?:/i)
  }
  assert.equal(agentsOf({ labels: { 'openshell.console/agents': 'Antigravity,agy,Kiro,Droid,Aider' } }).length, 4)
  assert.deepEqual(agentsOf({ command: ['agent'] }), [])
})

test('generic agent command requires a Cursor installation target', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-identity-'))
  try {
    const bin = path.join(home, '.local/bin')
    await fs.mkdir(bin, { recursive: true })
    // Expose readlink only; do not pick up the developer machine's agents.
    await fs.symlink('/usr/bin/readlink', path.join(bin, 'readlink'))
    const alias = path.join(bin, 'agent')
    await fs.writeFile(alias, '#!/bin/sh\nexit 99\n', { mode: 0o755 })
    const probe = async () => (await exec('/bin/sh', ['-c', agentProbe], { env: { HOME: home, PATH: bin } })).stdout.trim().split('\n')
    assert.ok(!(await probe()).includes('agent'))
    await fs.unlink(alias)
    const target = path.join(home, '.local/share/cursor-agent/versions/test/cursor-agent')
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, '#!/bin/sh\nexit 99\n', { mode: 0o755 })
    await fs.symlink(target, alias)
    assert.ok((await probe()).includes('agent'))
  } finally { await fs.rm(home, { recursive: true, force: true }) }
})
