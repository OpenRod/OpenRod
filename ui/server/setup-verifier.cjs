// Runs inside the sandbox. Never calls tools/call, prompts/get or resources/read.
const fs=require('fs'),cp=require('child_process'),readline=require('readline');
const input=JSON.parse(fs.readFileSync(0,'utf8'));
let child,session,version='2025-03-26',next=1;
const pending=new Map();
const config=input.config;
let credentialMissing=false;
for(const area of ['env','headers'])for(const [key,value] of Object.entries(config[area]||{})){config[area][key]=value.replace(/openshell:resolve:env:([A-Za-z0-9_]+)/g,(_,alias)=>{const handle=process.env[alias];if(!handle?.startsWith('openshell:resolve:env:')){credentialMissing=true;return ''}return handle})}
const output=(v)=>process.stdout.write(JSON.stringify(v)+'\n');
const timeout=setTimeout(()=>{finish({status:'unverified',reason:'MCP did not respond within 25 seconds.'})},25000);
let finished=false;
function finish(result){if(finished)return;finished=true;clearTimeout(timeout);if(child){try{process.kill(-child.pid,'SIGKILL')}catch{child.kill('SIGKILL')}}output(result);process.exit(0)}
async function remote(message){
 const headers={'content-type':'application/json',accept:'application/json, text/event-stream',...config.headers};
 if(session)headers['Mcp-Session-Id']=session;
 if(message.method!=='initialize')headers['MCP-Protocol-Version']=version;
 const response=await fetch(config.url,{method:'POST',headers,body:JSON.stringify(message),redirect:'error',signal:AbortSignal.timeout(15000)});
 if(response.status===401||response.status===403)throw Error('AUTH');
 if(!response.ok)throw Error('HTTP');
 if(response.headers.get('mcp-session-id'))session=response.headers.get('mcp-session-id');
 if(message.id===undefined){await response.body?.cancel();return}
 let text='';const reader=response.body.getReader();
 try{while(true){const {value,done}=await reader.read();if(done)break;text+=Buffer.from(value).toString();if(text.length>1000000)throw Error('SIZE');
   if((response.headers.get('content-type')||'').includes('text/event-stream')){for(const block of text.split(/\r?\n\r?\n/).slice(0,-1)){const data=block.split(/\r?\n/).filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trim()).join('\n');if(!data)continue;try{const parsed=JSON.parse(data);if(parsed.id===message.id)return parsed}catch{}}}
 }}finally{await reader.cancel().catch(()=>{})}
 return JSON.parse(text)
}
function local(message){if(message.id===undefined){child.stdin.write(JSON.stringify(message)+'\n');return Promise.resolve()}
 return new Promise((resolve,reject)=>{pending.set(message.id,{resolve,reject});child.stdin.write(JSON.stringify(message)+'\n')})
}
async function request(method,params,notification=false){const id=notification?undefined:next++;const value=await(config.url?remote:local)({jsonrpc:'2.0',...(id===undefined?{}:{id}),method,...(params===undefined?{}:{params})});if(value?.error)throw Error('RPC');return value?.result}
(async()=>{
 if(credentialMissing){finish({status:'needs-credentials',reason:'Gateway credential handles are not available. Reconnect or reapply after the provider loads.'});return}
 if(!config.url){child=cp.spawn(config.command,config.args||[],{cwd:'/sandbox',detached:true,env:{PATH:process.env.PATH,HOME:'/sandbox',NODE_EXTRA_CA_CERTS:process.env.NODE_EXTRA_CA_CERTS||'',...config.env},stdio:['pipe','pipe','pipe']});
 let bytes=0;child.stdout.on('data',chunk=>{bytes+=chunk.length;if(bytes>1000000)finish({status:'unverified',reason:'MCP response exceeded the inspection limit.'})});child.stderr.resume();
 readline.createInterface({input:child.stdout}).on('line',line=>{try{const v=JSON.parse(line),p=pending.get(v.id);if(p){pending.delete(v.id);p.resolve(v)}}catch{}});
 child.on('error',()=>finish({status:'unverified',reason:'MCP executable could not start.'}));child.on('exit',()=>{if(pending.size)finish({status:'unverified',reason:'MCP exited before completing initialization.'})})}
 const init=await request('initialize',{protocolVersion:version,capabilities:{},clientInfo:{name:'openshell-setup-check',version:'1.0.0'}});
 if(!init||!['2024-11-05','2025-03-26','2025-06-18','2025-11-25'].includes(init.protocolVersion))throw Error('VERSION');
 version=init.protocolVersion;await request('notifications/initialized',undefined,true);
 let tools=[],moreToolsPossible=false;if(init.capabilities?.tools){const listed=await request('tools/list',{});if(!Array.isArray(listed?.tools)||listed.tools.length>1000)throw Error('TOOLS');moreToolsPossible=Boolean(listed.nextCursor);tools=listed.tools.map(t=>String(t.name).slice(0,100))}
 finish({status:'connected',protocolVersion:version,toolCount:tools.length,tools,moreToolsPossible,toolCallsVerified:false,checkedAt:new Date().toISOString()})
})().catch(e=>finish({status:e.message==='AUTH'?'needs-sign-in':'unverified',reason:e.message==='AUTH'?'The MCP requires sign-in or additional account permissions.':'MCP initialization or capability discovery failed. Check access, dependencies and authentication.'}));
