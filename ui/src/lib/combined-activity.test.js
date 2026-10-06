import test from 'node:test'
import assert from 'node:assert/strict'
import { combinedActivityApi } from './combined-activity.js'
const local={id:'local',target:'local',context:'local/a',label:'Local',connected:true},remote={id:'remote',target:'local',context:'ssh/a',label:'SSH · test',connected:true,remote:true}
function fixture() {
  const calls=[]
  const locations=[local,remote]
  const events=Object.fromEntries(locations.map((location,index)=>[location.id,Array.from({length:80},(_,i)=>({id:String(i),sandbox:'same',at:new Date(1700000000000-(i*2+index)*1000).toISOString(),kind:'log',message:location.label}))]))
  const apiFor=location=>({activity:async options=>{calls.push({location:location.id,options});return {events:events[location.id].slice(options.offset,options.offset+options.limit),total:80,snapshot:location.id==='local'?80:160,sandboxes:['same'],agents:['Unknown']}},previewActivityDeletion:async body=>{calls.push({location:location.id,body});return {token:location.id,count:body.ids?.length ?? 80,expiresAt:Date.now()+60000}},deleteActivity:async token=>{calls.push({location:location.id,token});return {deleted:1}}})
  return {api:combinedActivityApi({},()=>locations,apiFor),locations,calls,events}
}
test('combined pages merge by time, pin separate snapshots and use unique row identities',async()=>{
  const {api,calls}=fixture()
  const first=await api.activity({limit:50})
  const second=await api.activity({limit:50,offset:50,snapshot:first.snapshot,now:first.now})
  assert.equal(first.total,160);assert.equal(first.events.length,50);assert.equal(second.events.length,50)
  assert.equal(new Set([...first.events,...second.events].map(event=>event.id)).size,100)
  assert.deepEqual(first.events.slice(0,2).map(event=>event.location.id),['local','remote'])
  assert.ok(calls.some(call=>call.location==='local' && call.options.snapshot===80))
  assert.ok(calls.some(call=>call.location==='remote' && call.options.snapshot===160))
})
test('selected log deletion routes original ids only to the selected source',async()=>{
  const {api,calls}=fixture()
  const result=await api.activity({limit:10})
  calls.length=0
  const plan=await api.previewActivityDeletion({mode:'selected',ids:[result.events.find(event=>event.location.remote).id],query:{}})
  await api.deleteActivity(plan.token)
  assert.deepEqual(calls.map(call=>call.location),['remote','remote'])
  assert.deepEqual(calls[0].body.ids,['0'])
  assert.equal(calls[1].token,'remote')
})
test('cached remote logs remain visible offline while Local queries continue',async()=>{
  const {api,locations,calls}=fixture();await api.activity({limit:10})
  locations[1]={...remote,connected:false};calls.length=0
  const result=await api.activity({limit:10})
  assert.deepEqual([...new Set(result.events.map(event=>event.location.id))],['local','remote'])
  assert.equal(result.events.find(event=>event.location.remote).location.connected,false)
  assert.deepEqual(calls.map(call=>call.location),['local'])
  await assert.rejects(()=>api.previewActivityDeletion({mode:'selected',ids:[result.events.find(event=>event.location.remote).id]}),/Reconnect/)
})
test('all-source export reads beyond the current page',async()=>{
  const {api}=fixture();const result=await api.activity({exportAll:true});assert.equal(result.events.length,160)
})
test('failed remote history cannot block Local activity',async()=>{
  const api=combinedActivityApi({},()=>[local,remote],location=>({activity:async()=>{if(location.remote)throw Error('SSH down');return {events:[{id:'1',at:'2026-10-06T10:00:00Z'}],total:1,snapshot:1}}}))
  assert.equal((await api.activity()).events.length,1)
})
test('retrying a partial deletion never repeats a completed owner',async()=>{
  const calls=[];let fail=true
  const api=combinedActivityApi({},()=>[local,remote],location=>({previewActivityDeletion:async()=>({token:location.id,count:1,expiresAt:Date.now()+60000}),deleteActivity:async()=>{calls.push(location.id);if(location.remote && fail){fail=false;throw Error('temporary failure')}return {deleted:1}}}))
  const plan=await api.previewActivityDeletion({mode:'all'})
  await assert.rejects(()=>api.deleteActivity(plan.token),/temporary/)
  assert.equal((await api.deleteActivity(plan.token)).deleted,2)
  assert.deepEqual(calls,['local','remote','remote'])
})
