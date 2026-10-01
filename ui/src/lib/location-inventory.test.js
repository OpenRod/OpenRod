import test from 'node:test'
import assert from 'node:assert/strict'
import { mergeLocationInventories } from './location-inventory.js'
import { resourceKey } from './locations.js'

test('identical local, SSH, and cloud sandbox identities stay bound to their source', () => {
  const inventory = (context, remote = false) => ({ locations: [{ context, connected: true, remote }], sandboxes: [{ id: 'same-id', name: 'demo', location: { context } }], templates: [{ name: 'same-template', location: { context } }] })
  const combined = mergeLocationInventories([
    { target: 'local', inventory: inventory('["gateway","default"]') },
    { target: 'local', inventory: inventory('["ssh","default"]', true) },
    { target: 'cloud', inventory: inventory('["gateway","default"]') },
  ])
  assert.equal(combined.sandboxes.length, 3)
  assert.equal(new Set(combined.sandboxes.map(resourceKey)).size, 3)
  assert.deepEqual(combined.sandboxes.map(row => row.location.target), ['local', 'local', 'cloud'])
  assert.equal(combined.sandboxes[2].location.label, 'Cloud')
  assert.equal(combined.templates[2].location.context, '["gateway","default"]')
})
test('unowned records are excluded and unavailable cached locations stay unavailable', () => {
  const result = mergeLocationInventories([{ target: 'cloud', inventory: { locations: [{ context: 'owner', connected: false }], sandboxes: [{ name: 'old', location: { context: 'owner' } }, { name: 'unowned' }] } }])
  assert.deepEqual(result.sandboxes.map(row => row.name), ['old'])
  assert.equal(result.sandboxes[0].location.connected, false)
})

import {copyCloudSandboxToLocal} from './local-cloud.js'
test('cloud workspace import uses only the local destination and waits for its runnable result',async()=>{
 const calls=[],bundle={version:1,files:[]},cloud={cloudExport:async name=>{calls.push(['export',name]);return {bundle,warning:'Reconnect agents'}}},local={target:'local',importCloud:async value=>{calls.push(['import',value]);return {name:'local-copy'}}}
 const result=await copyCloudSandboxToLocal(cloud,local,'demo')
 assert.equal(result.name,'local-copy');assert.equal(result.warning,'Reconnect agents');assert.deepEqual(calls,[['export','demo'],['import',bundle]])
 await assert.rejects(copyCloudSandboxToLocal(cloud,{...local,target:'cloud'},'demo'),/local/)
})
