import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {spawnSync} from 'node:child_process'
const script=path.resolve(import.meta.dirname,'../../deploy/gcp/configure-docker.py')
const expected={'data-root':'/var/lib/openrod/docker',ipv6:false,dns:['8.8.8.8','8.8.4.4']}
test('fresh and existing GCP Docker configuration uses public DNS and retains the metadata boundary',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'openrod-docker-config-')),file=path.join(dir,'daemon.json')
 try{
  for(const current of [null,{'data-root':'/var/lib/openrod/docker',ipv6:false},expected]){
   await rm(file,{force:true});if(current)await writeFile(file,JSON.stringify(current))
   const result=spawnSync('python3',[script,file],{encoding:'utf8'})
   assert.equal(result.status,0,result.stderr)
   assert.deepEqual(JSON.parse(await readFile(file,'utf8')),expected)
  }
  for(const current of [{...expected,ipv6:true},{...expected,'data-root':'/another/disk'},{...expected,dns:['169.254.169.254']},{...expected,hosts:['tcp://0.0.0.0:2375']}]){
   await writeFile(file,JSON.stringify(current))
   const result=spawnSync('python3',[script,file],{encoding:'utf8'})
   assert.notEqual(result.status,0)
   assert.deepEqual(JSON.parse(await readFile(file,'utf8')),current)
  }
 }finally{await rm(dir,{recursive:true,force:true})}
})
