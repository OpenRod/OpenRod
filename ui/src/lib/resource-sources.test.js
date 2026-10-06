import test from 'node:test'
import assert from 'node:assert/strict'
import { consolidateResources, applySourceChange, matchingSources } from './resource-sources.js'
const local={id:'local',target:'local',context:'a',connected:true},cloud={id:'cloud',target:'cloud',context:'a',connected:true},remote={id:'remote',target:'local',context:'b',connected:false}
const group={id:'dev',name:'Dev',description:'Build',template:null,outside:'block',location:local}
test('same-named resources collapse across sources, variants are marked and same-source duplicates stay separate',()=>{
 const rows=consolidateResources('groups',[group,{...group,id:'imported-dev',location:cloud,createdAt:'different'},{...group,description:'Different',location:remote},{...group,id:'duplicate'}])
 assert.equal(rows.length,2);assert.equal(rows[0].copies.length,3);assert.equal(rows[0].configurationCount,2)
 assert.deepEqual(rows[0].copies.map(copy=>copy.location.id),['local','cloud','remote'])
})
test('offline primary yields to a connected copy without dropping the offline chip',()=>{
 const rows=consolidateResources('groups',[{...group,location:remote},group]);assert.equal(rows[0].location.id,'local');assert.equal(rows[0].copies.length,2)
})
test('same-name setups share one inventory row while content differences remain explicit',()=>{
 const base={name:'Tools',revision:'r1',location:local,items:[{name:'review',kind:'skill',contentDigest:'contents-1'}]}
 assert.equal(consolidateResources('setups',[base,{...base,revision:'r2',location:cloud}]).length,1)
 assert.equal(consolidateResources('setups',[base,{...base,location:cloud,items:[{name:'review',kind:'skill',contentDigest:'contents-2'}]}])[0].configurationCount,2)
 const old={...base,items:[{name:'review',kind:'skill'}]}
 assert.equal(consolidateResources('setups',[old,{...old,location:cloud,revision:'r2'}])[0].configurationCount,2)
})
test('propagation applies only changed fields, keeps destination identity and unrelated differences',async()=>{
 const target={...group,id:'cloud-dev',description:'Destination description',location:cloud}
 let saved
 await applySourceChange({type:'groups',before:group,args:[{...group,name:'Engineering'}],method:'saveGroup'},target,{org:async()=>({groups:[target]}),saveGroup:async value=>{saved=value}})
 assert.equal(saved.id,'cloud-dev');assert.equal(saved.name,'Engineering');assert.equal(saved.description,'Destination description')
})
test('stale or offline targets never receive writes',async()=>{
 const change={type:'groups',before:group,args:[{...group,name:'New'}],method:'saveGroup'}
 let writes=0
 await assert.rejects(applySourceChange(change,{...group,location:cloud},{org:async()=>({groups:[{...group,description:'Concurrent edit'}]}),saveGroup:async()=>writes++}),/changed/)
 await assert.rejects(applySourceChange(change,{...group,location:remote},{}),/Reconnect/)
 assert.equal(writes,0)
})
test('setup item deletion uses destination item ID and revision',async()=>{
 const item={id:'local-item',kind:'skill',name:'Review',contentDigest:'same'}
 const before={id:'local-setup',name:'Tools',items:[item],revision:'r1',location:local}
 const target={...before,id:'cloud-setup',items:[{...item,id:'cloud-item'}],revision:'r2',location:cloud}
 let args
 await applySourceChange({type:'setups',before,args:[before.id,item.id,before.revision],method:'deleteSetupItem'},target,{setups:async()=>[target],deleteSetupItem:async(...values)=>{args=values}})
 assert.deepEqual(args,['cloud-setup','cloud-item','r2'])
})
test('ambiguous same-name peers are not offered for overwriting',()=>{
 assert.deepEqual(matchingSources(group,[group,{...group,location:cloud},{...group,id:'second',location:cloud}]),[])
})
test('imported rules group by referenced group content, not machine-local IDs',()=>{
 const policy={id:'web',name:'Web',action:'allow',destinations:['example.com'],appliesTo:{everyone:false,groups:['dev'],sandboxes:[],setups:[]}}
 const first={...policy,location:local,sourceOrg:{groups:[group]}}
 const second={...policy,location:cloud,appliesTo:{...policy.appliesTo,groups:['import-dev']},sourceOrg:{groups:[{...group,id:'import-dev'}]}}
 assert.equal(consolidateResources('network',[first,second]).length,1)
 assert.equal(consolidateResources('network',[first,{...second,sourceOrg:{groups:[{...group,id:'import-dev',description:'Changed'}]}}])[0].configurationCount,2)
})
test('rule propagation preserves destination group IDs and unrelated advanced settings',async()=>{
 const before={id:'web',name:'Web',action:'allow',destinations:['example.com'],appliesTo:{everyone:false,groups:['dev'],sandboxes:[],setups:[]},advanced:{ports:[443],programs:['/bin/a']},location:local}
 const target={...before,location:cloud,appliesTo:{...before.appliesTo,groups:['import-dev']},advanced:{ports:[443],programs:['/bin/b']},sourceOrg:{groups:[{...group,id:'import-dev'}]}}
 let saved
 await applySourceChange({type:'network',before,method:'savePolicy',args:[{...before,advanced:{...before.advanced,ports:[80,443]}}]},target,{org:async()=>({policies:[target],groups:[{...group,id:'import-dev'}]}),savePolicy:async value=>{saved=value}})
 assert.deepEqual(saved.appliesTo.groups,['import-dev']);assert.deepEqual(saved.advanced,{ports:[80,443],programs:['/bin/b']})
})

test('mixed-version grammar copies appear once and preserve every source identity', () => {
 const first={id:'a',name:'grammar',revision:'original',items:[{id:'one',name:'grammar-help',kind:'skill',contentDigest:'digest'}],location:local}
 const imported={...first,id:'b',revision:'imported',items:[{id:'two',name:'grammar-help',kind:'skill'}],location:cloud}
 const rows=consolidateResources('setups',[first,imported])
 assert.equal(rows.length,1)
 assert.deepEqual(rows[0].copies.map(copy=>copy.id),['a','b'])
 assert.equal(rows[0].configurationCount,2)
 assert.equal(consolidateResources('setups',[first,{...first,id:'duplicate'}]).length,2)
})
test('opposing network copies stay independently inspectable in a variant row', () => {
 const first={id:'web',name:'Web',action:'allow',location:local}
 const second={...first,id:'cloud-web',action:'block',location:cloud}
 const [row]=consolidateResources('network',[first,second])
 assert.equal(row.configurationCount,2)
 assert.deepEqual(row.copies.map(copy=>copy.action),['allow','block'])
})
test('import bookkeeping does not split identical group definitions', () => {
 const rows=consolidateResources('groups',[group,{...group,id:'imported',location:cloud,localSource:{context:'old',generation:'old'}}])
 assert.equal(rows.length,1)
 assert.equal(rows[0].configurationCount,1)
})
