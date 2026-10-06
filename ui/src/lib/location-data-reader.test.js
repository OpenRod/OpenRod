import test from 'node:test'
import assert from 'node:assert/strict'
import { readLocationData } from './location-data-reader.js'
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
