import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { gateway, WORKSPACE, sandboxView } from './gateway.js'
import { listPolicies, blockedByPolicy } from './egress.js'
import { hostMatches } from '../src/lib/egress.js'
import { planSandbox, readOrg, blockedBy } from './org.js'
const fail = (message, status = 400) => Object.assign(new Error(message), { status })
const unavailable = message => Object.assign(fail(message, 503), { preparationUnavailable: true })

export const ARTIFACT_DIR = path.resolve(import.meta.dirname, '../.state/setup-artifacts')
const PACKAGE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:@[a-zA-Z0-9.*^~+_-]+)?$/
export function packageLaunch(command, args = []) {
  if (!['npx', 'npm'].includes(path.basename(command || ''))) return null
  if (!Array.isArray(args) || args.some((v) => typeof v !== 'string')) return null
  const words = [...args]
  if (path.basename(command) === 'npm') { if (!['exec', 'x'].includes(words.shift())) return null }
  while (['-y', '--yes', '--'].includes(words[0])) words.shift()
  const spec = words.shift()
  if (!PACKAGE.test(spec || '') || words.length > 32 || words.some((v) => v.length > 512 || /[\x00-\x1f]/.test(v) || /token|password|secret|api.?key|authorization|cookie|\/Users\/|\/Applications\/|^~\//i.test(v))) return null
  const split = spec.lastIndexOf('@')
  const name = split > 0 ? spec.slice(0, split) : spec
  return { ecosystem: 'npm', name, requested: split > 0 ? spec.slice(split + 1) : 'latest', args: words, registry: 'registry.npmjs.org' }
}
export { packageRuntimeRequirements } from '../shared/setup-launch.js'
export const packageLocation = (artifact) => `/sandbox/.openshell/packages/${artifact.digest}`

// Only official registry metadata is fetched by this process. Package code runs
// exclusively inside a disposable OpenShell sandbox without user credentials.
export async function resolvePackage(plan, fetcher = fetch, signal) {
  if (!PACKAGE.test(plan.name) || !/^[a-zA-Z0-9.*^~+_-]+$/.test(plan.requested)) throw fail('Unsupported package specifier.')
  let response, text
  try {
    const deadline = AbortSignal.timeout(20000)
    response = await fetcher(`https://registry.npmjs.org/${encodeURIComponent(plan.name)}/${encodeURIComponent(plan.requested)}`, { redirect: 'error', signal: signal ? AbortSignal.any([signal, deadline]) : deadline })
    text = await response.text()
  } catch {
    signal?.throwIfAborted()
    throw unavailable('The console cannot reach the npm registry to resolve package metadata. Check registry connectivity before retrying.')
  }
  if (response.status === 429 || response.status >= 500) throw unavailable('The npm registry is temporarily unavailable or rate limiting requests. Retry preparation later.')
  if (!response.ok) throw fail('Package version could not be resolved. Choose an exact version or a published tag.')
  if (text.length > 2_000_000) throw fail('Registry metadata is too large.')
  const value = JSON.parse(text)
  if (value.name !== plan.name || !/^\d+\.\d+\.\d+[a-zA-Z0-9.+-]*$/.test(value.version) || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(value.dist?.integrity || '')) throw fail('Package metadata lacks a verifiable version or integrity hash.')
  const bins = typeof value.bin === 'string' ? { [plan.name.split('/').pop()]: value.bin } : value.bin || {}
  const preferred = plan.name.split('/').pop()
  const bin = bins[preferred] ? preferred : Object.keys(bins).length === 1 ? Object.keys(bins)[0] : null
  if (!bin || !/^[a-zA-Z0-9._-]+$/.test(bin)) throw fail('Package exposes multiple or no executables. A supported launcher adapter is required.')
  return { ...plan, version: value.version, integrity: value.dist.integrity, bin }
}

export async function waitReady(client, name, signal, { attempts = 90, wait = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  let sandbox
  for (let i = 0; i < attempts; i++) {
    signal?.throwIfAborted()
    sandbox = sandboxView((await client.raw.getSandbox({ name, workspaceScope: WORKSPACE })).sandbox)
    if (sandbox.phase === 'ready') return sandbox
    if (['error', 'deleting', 'stopped', 'completed'].includes(sandbox.phase)) break
    await wait(1500)
  }
  signal?.throwIfAborted()
  const config = await client.raw.getSandboxConfig({ name, workspaceScope: WORKSPACE }).catch(() => null)
  const reason = config?.configurationAdmitted
    ? 'The gateway admitted its policy, but the VM did not start. Check the gateway image registry and VM startup logs.'
    : config?.configurationError || sandbox?.problem || 'Check gateway and image registry availability.'
  throw Object.assign(fail(`Preparation sandbox could not start. ${reason}`, 503), { preparationUnavailable: true })
}

export async function checkPreparationRegistry(client, name, signal) {
  const script = "fetch('https://registry.npmjs.org/', {signal:AbortSignal.timeout(10000)}).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
  let result
  try {
    result = await client.sandbox.exec(name, ['/usr/local/bin/node', '-e', script], { noLoginShell: true, timeoutSecs: 15, signal })
  } catch {
    signal?.throwIfAborted()
    throw unavailable('The preparation sandbox registry check could not finish. Check gateway availability before retrying.')
  }
  if (result.exitCode !== 0) throw unavailable('The preparation sandbox started, but cannot reach registry.npmjs.org over HTTPS. Check gateway network connectivity before retrying.')
}

const INSTALL = `const fs=require('fs'),cp=require('child_process'),path=require('path');
const p=JSON.parse(fs.readFileSync(0,'utf8')); const root='/sandbox/package';fs.mkdirSync(root,{recursive:true});
fs.writeFileSync(root+'/package.json',JSON.stringify({private:true,dependencies:{[p.name]:p.version}}));
const options={cwd:root,env:{PATH:'/usr/local/bin:/usr/bin:/bin',HOME:'/sandbox',NODE_EXTRA_CA_CERTS:process.env.NODE_EXTRA_CA_CERTS||'',npm_config_cache:'/sandbox/cache',npm_config_registry:'https://registry.npmjs.org/',npm_config_fetch_retries:'1',npm_config_fetch_retry_mintimeout:'1000',npm_config_fetch_timeout:'30000',npm_config_update_notifier:'false'},encoding:'utf8',timeout:120000,killSignal:'SIGKILL',maxBuffer:2000000};
for(const args of [['install','--package-lock-only','--ignore-scripts','--no-audit','--no-fund'],['ci','--ignore-scripts','--no-audit','--no-fund']]){
 if(args[0]==='ci') { const lock=JSON.parse(fs.readFileSync(root+'/package-lock.json')); for(const [k,v] of Object.entries(lock.packages||{})){if(!k)continue;if(v.link||!v.integrity||!v.resolved||new URL(v.resolved).hostname!=='registry.npmjs.org'||new URL(v.resolved).protocol!=='https:')throw Error('dependency source is not approved');} }
 const r=cp.spawnSync('/usr/local/bin/npm',args,options); if(r.status!==0){const code=(r.stderr||'').match(/npm error code ([A-Z0-9_]+)/)?.[1]||r.error?.code||'UNKNOWN';console.log(JSON.stringify({error:'Package installation failed',code}));process.exit(1);}
}
const pkg=JSON.parse(fs.readFileSync(root+'/node_modules/'+p.name+'/package.json'));if(pkg.version!==p.version)throw Error('Version mismatch');
const lock=JSON.parse(fs.readFileSync(root+'/package-lock.json'));if(lock.packages['node_modules/'+p.name].integrity!==p.integrity)throw Error('Integrity mismatch');
const bin=fs.realpathSync(root+'/node_modules/.bin/'+p.bin);if(!bin.startsWith(root+'/node_modules/'))throw Error('Executable escapes the bundle');
let size=0;function walk(d){for(const n of fs.readdirSync(d)){const f=path.join(d,n),s=fs.lstatSync(f);if(s.isSymbolicLink()){const dest=fs.realpathSync(f);if(!dest.startsWith(root+'/'))throw Error('Link escapes bundle');}else if(s.isDirectory())walk(f);else if(s.isFile()){size+=s.size;if(size>200*1024*1024)throw Error('Package exceeds 200 MB');}else throw Error('Unsupported file');}}walk(root);
console.log(JSON.stringify({bin:bin.slice(root.length+1),bytes:size,node:process.versions.node,arch:process.arch,platform:process.platform,libc:'glibc',lockDigest:require('crypto').createHash('sha256').update(fs.readFileSync(root+'/package-lock.json')).digest('hex')}));`

// npm already retries each download once. Re-running the entire installation
// multiplies an outage across every selected MCP and discards useful diagnostics.
export async function installPackage(client, name, pinned, signal) {
  const deadline = AbortSignal.timeout(250000)
  const bounded = signal ? AbortSignal.any([signal, deadline]) : deadline
  let result
  try {
    result = await client.sandbox.exec(name, ['/usr/local/bin/node', '-e', INSTALL], {
      noLoginShell: true, stdin: Buffer.from(JSON.stringify(pinned)), timeoutSecs: 250, signal: bounded,
    })
  } catch (error) {
    signal?.throwIfAborted()
    if (deadline.aborted) throw unavailable('Package preparation exceeded its time limit. Check gateway and registry availability before retrying.')
    throw unavailable('The gateway interrupted package preparation. Check gateway availability before retrying.')
  }
  let metadata
  try { metadata = JSON.parse(result.stdout.toString()) } catch {}
  if (result.exitCode !== 0) {
    const code = /^[A-Z0-9_]+$/.test(metadata?.code || '') ? metadata.code : 'UNKNOWN'
    if (['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'EAI_AGAIN', 'ENOTFOUND', 'E429', 'E500', 'E502', 'E503', 'E504'].includes(code) || [124, 137, 143].includes(result.exitCode)) {
      throw unavailable(`Package preparation lost registry access or exceeded its time limit (${code}). Check gateway and registry availability before retrying.`)
    }
    throw fail(`Package preparation failed (${code}). Registry access or dependency requirements need review.`)
  }
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw fail('Package preparation returned an invalid result.')
  return metadata
}

export async function buildPackage(plan, { signal, progress = async () => {} } = {}) {
  const org = await readOrg()
  if (blockedBy(org, ['registry.npmjs.org']) || blockedByPolicy(await listPolicies(), {name:'',group:null}, ['registry.npmjs.org'], hostMatches)) throw fail('Organization policy blocks the npm registry.', 403)
  const pinned = await resolvePackage(plan, fetch, signal)
  const { client } = await gateway()
  const name = 'sp-' + randomUUID().slice(0, 12)
  const base = await planSandbox({ name, systemBaseline: true })
  base.policy.networkPolicies = {}
  base.policy.networkPolicies.setup_registry = { name:'setup_registry', binaries:[{path:'/usr/local/bin/node'}],endpoints:[{host:'registry.npmjs.org',port:443,protocol:'rest',access:1,enforcement:1,allowEncodedSlash:true}] }
  let created = false, temporary
  try {
    await progress('Starting isolated package builder')
    await client.sandbox.create({ name, image:'node:22-bookworm-slim', command:['/bin/sleep','infinity'],providers:[],policy:base.policy,labels:{'openshell.console/setup-builder':'true'} });created=true
    await waitReady(client,name,signal)
    const effective=await client.raw.getSandboxConfig({name,workspaceScope:WORKSPACE})
    if(effective.policySource===2)throw fail('Gateway global policy overrides isolated preparation. Ask the administrator for a dedicated preparation gateway.',403)
    // The supervisor's first provider-environment poll replaces synthetic DNS
    // mappings. Start npm after that initial refresh so its DNS cache is fresh.
    await progress('Waiting for the preparation sandbox policy to settle')
    await new Promise((resolve,reject)=>{const done=()=>{signal?.removeEventListener('abort',stop);resolve()};const timer=setTimeout(done,12000);const stop=()=>{clearTimeout(timer);reject(signal.reason)};if(signal?.aborted)stop();else signal?.addEventListener('abort',stop,{once:true})})
    await progress('Checking npm registry connectivity')
    await checkPreparationRegistry(client, name, signal)
    await progress(`Installing ${pinned.name}@${pinned.version} without install scripts`)
    const metadata = await installPackage(client, name, pinned, signal)
    await fs.mkdir(ARTIFACT_DIR,{recursive:true,mode:0o700})
    temporary=path.join(ARTIFACT_DIR,randomUUID()+'.tmp')
    const handle=await fs.open(temporary,'wx',0o600);const digest=createHash('sha256');let bytes=0,exit=null
    try{for await(const event of client.sandbox.execStream(name,['tar','-czf','-','-C','/sandbox/package','.'],{noLoginShell:true,timeoutSecs:120,signal})){
      if(event.stream==='stdout'){bytes+=event.data.length;if(bytes>100*1024*1024)throw fail('Compressed package exceeds 100 MB.');digest.update(event.data);await handle.write(event.data)}
      if(event.type==='exit')exit=event.exitCode
    }}finally{await handle.close()}
    if(exit!==0)throw fail('Could not export the prepared package.')
    const id=digest.digest('hex');await fs.rename(temporary,path.join(ARTIFACT_DIR,id+'.tar.gz'));temporary=null
    await progress('Checking MCP initialization and capability discovery')
    const verifier=await fs.readFile(path.join(import.meta.dirname,'setup-verifier.cjs'),'utf8')
    const check=await client.sandbox.exec(name,['/usr/local/bin/node','-e',verifier],{noLoginShell:true,stdin:Buffer.from(JSON.stringify({config:{command:'/usr/local/bin/node',args:['/sandbox/package/'+metadata.bin,...pinned.args]}})),timeoutSecs:35,signal})
    let verification={status:'unverified',reason:'Initialization check did not finish.'}
    try{verification=JSON.parse(check.stdout.toString())}catch{}
    return { ...pinned,...metadata,digest:id,compressedBytes:bytes,verification,preparedAt:new Date().toISOString() }
  }finally{if(temporary)await fs.rm(temporary,{force:true});if(created)await client.sandbox.delete(name).catch(()=>{})}
}

export async function artifactFile(artifact) {
  if(!/^[a-f0-9]{64}$/.test(artifact?.digest||''))throw fail('Invalid prepared artifact.')
  const file=path.join(ARTIFACT_DIR,artifact.digest+'.tar.gz');const data=await fs.readFile(file)
  if(createHash('sha256').update(data).digest('hex')!==artifact.digest)throw fail('Prepared artifact integrity check failed.',409)
  return {file,data}
}
