import test from 'node:test'
import assert from 'node:assert/strict'
import { readLocationData, unreadSources } from './location-data-reader.js'
const local={id:'local',target:'local',context:'local/a',connected:true},remote={id:'remote',target:'local',context:'ssh/a',connected:true,remote:true}
test('both owners retain colliding resource names and ids',async()=>{
  const sources=await readLocationData([local,remote],['setups'],location=>({setups:async()=>[{id:'same',name:'My setup',owner:location.id}]}))
  assert.deepEqual(sources.map(source=>source.data.setups[0].owner),['local','remote'])
})
test('offline source keeps cached data and is never queried',async()=>{
  const sources=await readLocationData([local,{...remote,connected:false}],['secrets'],location=>{assert.equal(location.id,'local');return {secrets:async()=>({providers:[]})}},[{location:remote,data:{secrets:{providers:[{name:'remote-key'}]}}}])
  assert.equal(sources[1].data.secrets.providers[0].name,'remote-key')
  assert.equal(sources[0].location.connected,true)
})
test('one failed SSH request cannot discard Local results',async()=>{
  const sources=await readLocationData([local,remote],['org'],location=>({org:async()=>{if(location.remote)throw Error('SSH down');return {groups:[{id:'local'}]}}}))
  assert.equal(sources[0].data.org.groups[0].id,'local')
  assert.equal(sources[1].location.connected,false)
})
test('partial method failure retains other current and cached readings',async()=>{
  const sources=await readLocationData([local],['org','activity'],()=>({org:async()=>({groups:[]}),activity:async()=>{throw Error('history unavailable')}}),[{location:local,data:{activity:{events:[{id:'cached'}]}}}])
  assert.deepEqual(sources[0].data.org,{groups:[]})
  assert.equal(sources[0].data.activity.events[0].id,'cached')
  assert.equal(sources[0].location.connected,true)
})
test('a Local read failure and an offline Remote are both reported, not shown as empty',async()=>{
  const sources=await readLocationData([local,{...remote,connected:false}],['secrets'],()=>({secrets:async()=>{throw Error('gateway unreachable')}}))
  const status=unreadSources(sources,['secrets'])
  assert.deepEqual(status.failed.map(source=>[source.location.id,source.error]),[['local','gateway unreachable']])
  assert.deepEqual(status.offline.map(source=>source.location.id),['remote'])
  assert.equal(status.any,true)
  assert.equal(status.unavailable,true)
})
test('an offline Remote beside a readable Local is noted but the page stays available',async()=>{
  const sources=await readLocationData([local,{...remote,connected:false}],['secrets'],()=>({secrets:async()=>({providers:[]})}))
  const status=unreadSources(sources,['secrets'])
  assert.deepEqual(status.offline.map(source=>source.location.id),['remote'])
  assert.equal(status.failed.length,0)
  assert.equal(status.unavailable,false)
})
test('cached readings are not reported as missing, and a clean read reports nothing',async()=>{
  const cached=await readLocationData([{...remote,connected:false}],['secrets'],()=>({}),[{location:remote,data:{secrets:{providers:[]}}}])
  assert.deepEqual(unreadSources(cached,['secrets']),{failed:[],offline:[],any:false,unavailable:false})
  const stale=await readLocationData([local],['secrets'],()=>({secrets:async()=>{throw Error('timed out')}}),[{location:local,data:{secrets:{providers:[]}}}])
  assert.equal(unreadSources(stale,['secrets']).failed.length,1)
  assert.equal(unreadSources(stale,['secrets']).unavailable,false)
  assert.deepEqual(unreadSources([],['secrets']),{failed:[],offline:[],any:false,unavailable:false})
})
test('a source missing the page\'s main reading counts as unread even when a side reading loaded',async()=>{
  const sources=await readLocationData([local],['org','activity'],()=>({org:async()=>{throw Error('gateway unreachable')},activity:async()=>({events:[]})}))
  assert.equal(unreadSources(sources,['org','activity']).unavailable,true)
  const down=await readLocationData([local],['fleetPolicy','org'],()=>({fleetPolicy:async()=>{throw Error('gateway unreachable')},org:async()=>{throw Error('gateway unreachable')}}))
  assert.equal(down[0].error,'gateway unreachable')
  assert.equal(unreadSources(sources,['activity']).unavailable,false)
})
