import test from 'node:test'
import assert from 'node:assert/strict'
import { combinedEgressInventory } from './egress-inventory.js'
import { resourceKey } from './locations.js'
test('same-name sandboxes, hosts and policies remain independent across sources',()=>{
  const sources=[{id:'local',context:'local',remote:false},{id:'remote',context:'remote',remote:true}].map((location,index)=>({location,data:{fleetPolicy:{sandboxes:[{id:'same-id',name:'same-name',rules:[{key:'egress_same-policy',endpoints:[{host:'github.com',access:'read-only',ports:[443]}]}]}]},org:{org:{blocked:index?['denied.example']:[]},policies:[]},activity:{events:[{kind:'audit',sandbox:'same-name',verdict:'allowed',destination:'github.com:443'},{kind:'audit',sandbox:'same-name',verdict:'denied',destination:'denied.example:443',at:'2026-10-06T10:00:00Z'}]}}}))
  const result=combinedEgressInventory(sources)
  assert.equal(result.destinations.length,2)
  assert.deepEqual(result.destinations.map(row=>[row.location.id,row.hits]),[['local',1],['remote',1]])
  assert.equal(result.blocked.length,1)
  assert.equal(result.blocked[0].location.id,'local')
  assert.equal(result.perSandbox.size,2)
  for(const source of sources){const row=result.perSandbox.get(resourceKey({name:'same-name',location:source.location}));assert.equal(row.counts.policy,1);assert.equal(row.blocked,1)}
})
