import test from 'node:test'
import assert from 'node:assert/strict'
import { publicItem } from './setup-discovery.js'
test('content identity detects different same-size skill files without disclosing content',()=>{
 const a={kind:'skill',name:'Review',files:[{path:'SKILL.md',content:'alpha'}]}
 const first=publicItem(a),second=publicItem({...a,id:'another',sources:['cursor'],root:'/other',files:[{path:'SKILL.md',content:'bravo'}]})
 assert.notEqual(first.contentDigest,second.contentDigest)
 assert.equal(first.contentDigest,publicItem({...a,id:'another',sources:['cursor'],createdAt:'later'}).contentDigest)
 assert.equal(first.files[0].content,undefined)
})
test('MCP configuration differences and credential bindings affect identity',()=>{
 const base={kind:'mcp',name:'Docs',config:{url:'https://example.com/mcp',env:{MODE:'one'}}}
 assert.notEqual(publicItem(base).contentDigest,publicItem({...base,config:{...base.config,env:{MODE:'two'}}}).contentDigest)
 assert.notEqual(publicItem(base).contentDigest,publicItem({...base,credentialRef:{provider:'different'}}).contentDigest)
 assert.equal(publicItem(base).config,undefined)
})
