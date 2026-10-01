import test from 'node:test'
import assert from 'node:assert/strict'
import { filesystemPreset, filesystemChoice, availablePolicyId, destinationRule, folderAccess, setFolderAccess } from './policy-editor.js'
import { ruleToProto, validateTemplate, templateToPolicy } from '../../server/policy.js'

test('read-only workspace removes automatic workspace writes while keeping temporary files writable', () => {
  const filesystem = filesystemPreset('read-only')
  const policy = templateToPolicy(validateTemplate({ id: 'read-review', filesystem, rules: [], landlock: 'hard_requirement' }))
  assert.equal(policy.filesystem.includeWorkdir, false)
  assert(policy.filesystem.readOnly.includes('/sandbox'))
  assert(!policy.filesystem.readWrite.some(path => path === '/sandbox' || path === '/'))
  assert(policy.filesystem.readWrite.includes('/tmp'))
  assert.equal(policy.landlock.compatibility, 'hard_requirement')
  assert.equal(filesystemChoice(filesystem), 'read-only')
})

test('custom filesystem permissions are recognized without being replaced by a preset', () => {
  const filesystem = { ...filesystemPreset('standard'), readWrite: ['/tmp', '/dev/null', '/data/results'] }
  const before = structuredClone(filesystem)
  assert.equal(filesystemChoice(filesystem), 'custom')
  assert.deepEqual(filesystem, before)
  const preset = filesystemPreset('standard')
  preset.readWrite.push('/other')
  assert.equal(filesystemChoice(filesystemPreset('standard')), 'standard')
})

test('automatic IDs cannot overwrite existing or hidden built-in policies', () => {
  assert.equal(availablePolicyId('Frontend development', [{ id: 'frontend-development' }]), 'frontend-development-2')
  assert.notEqual(availablePolicyId('Claude subscription', []), 'claude-subscription')
  assert.notEqual(availablePolicyId('Node packages', []), 'node-packages')
  assert.match(availablePolicyId('日本語', []), /^[a-z0-9-]+$/)
  assert(availablePolicyId('a'.repeat(80), []).length <= 48)
})

test('simple destinations compile to enforced HTTPS with explicit program bindings', () => {
  const spec = destinationRule({ host: ' Docs.Example.com ', access: 'read-only', program: 'curl' })
  const { rule } = ruleToProto(spec)
  assert.deepEqual(rule.binaries.map(item => item.path), ['/usr/bin/curl', '/usr/local/bin/curl'])
  assert.equal(rule.endpoints[0].host, 'docs.example.com')
  assert.equal(rule.endpoints[0].port, 443)
  assert.equal(rule.endpoints[0].access, 1)
  assert.equal(rule.endpoints[0].enforcement, 1)
  const duplicate = destinationRule({ host: 'docs.example.com', access: 'read-write', program: 'node' }, [spec])
  assert.notEqual(duplicate.name, spec.name)
  assert.equal(ruleToProto(duplicate).rule.endpoints[0].access, 2)
  for (const host of ['https://docs.example.com/private', 'docs.example.com/path', '*']) {
    assert.throws(() => destinationRule({ host, access: 'read-only', program: 'curl' }), /hostname/)
  }
  assert.throws(() => destinationRule({ host: 'example.com', access: 'full', program: 'curl' }), /Choose read/)
})


test('workspace control replaces exact grants without losing custom folder permissions', () => {
  const original = { ...filesystemPreset('standard'), readWrite: ['/tmp', '/dev/null', '/sandbox', '/data/results'], readOnly: ['/usr', '/data/input'] }
  const readonly = setFolderAccess(original, '/sandbox', 'readOnly')
  assert.equal(readonly.workdir, false)
  assert.equal(folderAccess(readonly, '/sandbox'), 'readOnly')
  assert.deepEqual(readonly.readWrite, ['/tmp', '/dev/null', '/data/results'])
  assert.deepEqual(readonly.readOnly, ['/usr', '/data/input', '/sandbox'])
  assert.equal(templateToPolicy(validateTemplate({ id: 'popup-policy', filesystem: readonly, rules: [] })).filesystem.includeWorkdir, false)
  const writable = setFolderAccess(readonly, '/sandbox', 'readWrite')
  assert.equal(writable.workdir, true)
  assert(!writable.readOnly.includes('/sandbox'))
  assert.equal(folderAccess(writable, '/sandbox'), 'readWrite')
  assert(original.readWrite.includes('/sandbox'))
})

test('folder access reflects ancestor grants and avoids matching sibling path prefixes', () => {
  const fs = { workdir: false, readOnly: ['/sandbox'], readWrite: ['/data'] }
  assert.equal(folderAccess(fs, '/data/results'), 'readWrite')
  assert.equal(folderAccess(fs, '/database'), 'none')
  assert.equal(folderAccess({ ...fs, readWrite: ['/'] }, '/sandbox'), 'readWrite')
  assert.equal(folderAccess(setFolderAccess(fs, '/tmp', 'readWrite'), '/tmp'), 'readWrite')
})
