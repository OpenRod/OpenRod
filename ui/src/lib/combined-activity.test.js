import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { combinedActivityApi, serverSort } from './combined-activity.js'
import { createActivityStore } from '../../server/activity-store.js'
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
test('failed remote history cannot block Local activity and is named',async()=>{
  const api=combinedActivityApi({},()=>[local,remote],location=>({activity:async()=>{if(location.remote)throw Error('SSH down');return {events:[{id:'1',at:'2026-10-06T10:00:00Z'}],total:1,snapshot:1}}}))
  const result=await api.activity()
  assert.equal(result.events.length,1);assert.deepEqual(result.unavailable,[{label:'SSH · test',error:'SSH down'}])
  assert.deepEqual((await api.activity({exportAll:true})).unavailable,[{label:'SSH · test',error:'SSH down'}])
})
test('export never passes a cached page off as a complete source and names offline sources',async()=>{
  const {api,locations}=fixture();await api.activity({limit:10})
  locations[1]={...remote,connected:false}
  assert.deepEqual((await api.activity({limit:10})).unavailable,[{label:'SSH · test',offline:true}])
  const exported=await api.activity({exportAll:true})
  assert.equal(exported.events.length,80);assert.ok(exported.events.every(event=>event.location.id==='local'))
  assert.deepEqual(exported.unavailable,[{label:'SSH · test',offline:true}])
})
test('deletion review counts each source and names offline ones it skips',async()=>{
  const {api,locations,calls}=fixture()
  assert.deepEqual((await api.previewActivityDeletion({mode:'all'})).sources,[{label:'Local',count:80},{label:'SSH · test',count:80}])
  locations[1]={...remote,connected:false};calls.length=0
  const plan=await api.previewActivityDeletion({mode:'matching',query:{}})
  assert.equal(plan.count,80);assert.deepEqual(plan.sources,[{label:'Local',count:80}]);assert.deepEqual(plan.skipped,['SSH · test'])
  assert.deepEqual(calls.map(call=>call.location),['local'])
})
test('retrying a partial deletion never repeats a completed owner',async()=>{
  const calls=[];let fail=true
  const api=combinedActivityApi({},()=>[local,remote],location=>({previewActivityDeletion:async()=>({token:location.id,count:1,expiresAt:Date.now()+60000}),deleteActivity:async()=>{calls.push(location.id);if(location.remote && fail){fail=false;throw Error('temporary failure')}return {deleted:1}}}))
  const plan=await api.previewActivityDeletion({mode:'all'})
  await assert.rejects(()=>api.deleteActivity(plan.token),/temporary/)
  assert.equal((await api.deleteActivity(plan.token)).deleted,2)
  assert.deepEqual(calls,['local','remote','remote'])
})
function storeWith(events){const store=createActivityStore(':memory:');for(const event of events)store.ingest(event,event.sandbox);return store}
async function readAll(api,sort,limit){
  const events=[];let first
  for(let offset=0;;offset+=limit){const page=await api.activity({limit,offset,sort,...(first?{snapshot:first.snapshot,now:first.now}:{})});first??=page;events.push(...page.events);if(offset+limit>=page.total)return {events,total:page.total}}
}
test('text sorts page like the server, so web-9 and web-10 are neither skipped nor repeated',async()=>{
  const base=Date.parse('2026-10-06T10:00:00Z');let n=0
  const store=storeWith(['web-10','web-9'].flatMap(sandbox=>Array.from({length:30},()=>({id:`e${n}`,sandbox,at:new Date(base-++n*1000).toISOString(),kind:'log',message:sandbox}))))
  const api=combinedActivityApi({},()=>[local],()=>({activity:async options=>store.query(options)}))
  const sort={key:'sandbox',direction:'asc'}
  const first=await api.activity({limit:50,sort}),second=await api.activity({limit:50,offset:50,sort,snapshot:first.snapshot,now:first.now})
  const server=store.query({limit:50,sort}),next=store.query({limit:50,offset:50,sort,snapshot:server.snapshot,now:server.now})
  assert.deepEqual(first.events.map(event=>event.originalId),server.events.map(event=>event.id))
  assert.deepEqual(second.events.map(event=>event.originalId),next.events.map(event=>event.id))
  assert.equal(new Set([...first.events,...second.events].map(event=>event.id)).size,60)
})
test('merged pages keep each source in server order for mixed-case, numeric and non-ASCII values',async()=>{
  const sandboxes=['web-10','web-9','Web-2','WEB-1','web_1','agent-2','agent-10','10','9','é','e','\uFF01','😀']
  const severities=['HIGH','high','Med','Not reported','ınfo','critical','LOW'],destinations=['10.0.0.5:8080','10.0.0.12:443','Example.com:443','example.com:80','_internal:1']
  const make=seed=>storeWith(Array.from({length:60},(_,i)=>({id:`${seed}-${i}`,sandbox:sandboxes[(i*7+seed)%sandboxes.length],at:new Date(1790000000000+(i%5)*1000).toISOString(),kind:'log',severity:severities[(i+seed)%severities.length],destination:destinations[(i*3+seed)%destinations.length],message:String(i)})))
  const stores={local:make(0),remote:make(1)}
  const api=combinedActivityApi({},()=>[local,remote],location=>({activity:async options=>stores[location.id].query(options)}))
  for(const key of ['sandbox','destination','severity','time','source'])for(const direction of ['asc','desc']){
    const sort={key,direction},{events,total}=await readAll(api,sort,7)
    assert.equal(total,120);assert.equal(events.length,120);assert.equal(new Set(events.map(event=>event.id)).size,120,`${key} ${direction}`)
    for(const [id,store] of Object.entries(stores))assert.deepEqual(events.filter(event=>event.location.id===id).map(event=>event.originalId),store.query({sort,limit:500}).events.map(event=>event.id),`${key} ${direction} ${id}`)
  }
})
test('value order matches SQLite json_extract ordering with BINARY collation',()=>{
  const values=['web-10','web-9','Web-2','web-9','web_1','é','e','\uFF01','😀','',null,7,10,2.5,true]
  const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE t (id TEXT, fields TEXT)')
  values.forEach((value,i)=>db.prepare('INSERT INTO t VALUES (?, ?)').run(`k${i}`,JSON.stringify({sandbox:value})))
  const rows=values.map((value,i)=>({key:`k${i}`,event:{originalId:`k${i}`},values:{sandbox:value}}))
  for(const direction of ['ASC','DESC'])assert.deepEqual(serverSort(rows,{key:'sandbox',direction:direction.toLowerCase()}).map(row=>row.key),db.prepare(`SELECT id FROM t ORDER BY json_extract(fields, '$.sandbox') ${direction}, id ASC`).all().map(row=>row.id))
})
