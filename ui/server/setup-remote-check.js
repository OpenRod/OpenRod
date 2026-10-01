import fs from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { gateway, contextSelection, runWithContext } from './gateway.js'
import { planSandbox, readOrg, blockedBy } from './org.js'
import { listPolicies, blockedByPolicy } from './egress.js'
import { hostMatches } from '../src/lib/egress.js'
import { waitReady } from './setup-packages.js'
import { fail } from './setup-discovery.js'
const verifier = await fs.readFile(new URL('./setup-verifier.cjs', import.meta.url), 'utf8')
export function checkRemote(item, signal) {
  return runWithContext(contextSelection(), () => checkInContext(item, signal))
}

async function checkInContext(item, signal) {
  const url = new URL(item.config.url)
  const org = await readOrg(), policies = await listPolicies()
  if (blockedBy(org, [url.hostname]) || blockedByPolicy(policies, {name:'',group:null}, [url.hostname], hostMatches)) throw fail('Organization policy blocks this MCP.',403)
  const { client, workspace, workspaceScope } = await gateway(), name = 'sc-' + randomUUID().slice(0,12)
  if (item.credentialRef) {
    const provider = (await client.raw.getProvider({name:item.credentialRef.provider,workspaceScope})).provider
    const profile = (await client.raw.getProviderProfile({id:provider.type,workspaceScope})).profile
    if (!profile || profile.endpoints.length) throw fail('Reconnect a dedicated MCP credential; the profile changed.')
  }
  const base = await planSandbox({name,systemBaseline:true})
  base.policy.networkPolicies = { setup_check: {name:'setup_check',binaries:[{path:'/usr/local/bin/node'}],endpoints:[{host:url.hostname,port:Number(url.port||443),path:url.pathname,protocol:'rest',enforcement:1,access:2,...(item.credentialRef?{credentialBinding:{provider:item.credentialRef.provider}}:{})}]} }
  let created = false
  try {
    await client.sandbox.create({name,workspace,image:'node:22-bookworm-slim',command:['/bin/sleep','infinity'],providers:item.credentialRef?[item.credentialRef.provider]:[],policy:base.policy,labels:{'openshell.console/setup-check':'true'}});created=true
    await waitReady(client,name,signal,{workspace})
    const effective = await client.raw.getSandboxConfig({name,workspaceScope})
    if (effective.policySource === 2) throw fail('Global gateway policy prevents an isolated connection check.',403)
    const result = await client.sandbox.exec(name,['node','-e',verifier],{workspace,noLoginShell:true,stdin:Buffer.from(JSON.stringify({config:item.config})),timeoutSecs:35,signal})
    try { return JSON.parse(result.stdout.toString()) } catch { return {status:'unverified',reason:'Connection check could not complete.'} }
  } finally { if(created) await client.sandbox.delete(name,{workspace}).catch(()=>{}) }
}
