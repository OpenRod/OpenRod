import { randomUUID } from 'node:crypto'
import { gateway, WORKSPACE } from './gateway.js'
import { fail } from './setup-discovery.js'

export async function connectCredentials(item, input = {}, source = {}) {
  if (!item.credentialFields?.length) return item
  const { client } = await gateway()
  const hosts = item.requirements.filter((r) => r.phase === 'runtime')
  if (!hosts.length) throw fail('Enter where this MCP sends its credentials (for example api.github.com), then try the import again.')
  let provider, aliases = {}
  if (input.provider) {
    if (!/^[a-z0-9][a-z0-9-]{0,61}$/.test(input.provider)) throw fail('Choose an existing OpenShell secret.')
    const found = (await client.raw.getProvider({name:input.provider,workspaceScope:WORKSPACE})).provider
    const profile = (await client.raw.getProviderProfile({id:found.type,workspaceScope:WORKSPACE})).profile
    // Existing providers must be endpointless: otherwise attachment grants
    // profile rules before the target-specific approval has been checked.
    if (profile.endpoints?.length) throw fail('Use a dedicated MCP secret. This provider carries unrelated endpoint grants.')
    for (const key of item.credentialFields) {
      const alias = input.aliases?.[key] || key
      if (!Object.hasOwn(found.credentials || {},alias)) throw fail(`The selected secret has no mapping for ${key}.`)
      aliases[key] = alias
    }
    provider = input.provider
  } else {
    const values = { ...(input.useSourceSecrets === true ? source : {}), ...(input.secrets || {}) }
    const credentials = {}, definitions = []
    const suffix = randomUUID().replaceAll('-','').slice(0,16)
    for (const key of item.credentialFields) {
      const value = values[key]
      if (typeof value !== 'string' || !value || value.length > 8192 || /[\r\n\x00]/.test(value)) throw fail(`Connect ${key} to continue.`)
      const alias = `OS_MCP_${suffix.toUpperCase()}_${key.replace(/[^A-Z0-9_]/gi,'_').toUpperCase()}`
      aliases[key]=alias; credentials[alias]=value
      definitions.push({name:key.toLowerCase().replace(/[^a-z0-9_]/g,'_'),description:key,envVars:[alias],required:true})
    }
    provider='mcp-'+suffix
    const profile={id:provider,displayName:`MCP: ${item.name}`,credentials:definitions,endpoints:[],binaries:[],annotations:{'openshell.console/managed':'setup-import'}}
    const imported=await client.raw.importProviderProfiles({workspaceScope:WORKSPACE,profiles:[{profile}],requestId:randomUUID()})
    if(!imported.imported)throw fail('The gateway does not support the required credential profile. No credentials were stored.')
    try{await client.raw.createProvider({workspaceScope:WORKSPACE,requestId:randomUUID(),provider:{metadata:{name:provider},type:provider,profileWorkspace:'default',credentials,config:{}}});

    }
    catch{await client.raw.deleteProvider({name:provider,workspaceScope:WORKSPACE}).catch(()=>{});await client.raw.deleteProviderProfile({id:provider,workspaceScope:WORKSPACE,allowMissing:true}).catch(()=>{});throw fail('The gateway could not store this MCP credential.')}
  }
  const config={...item.config}, env={...(config.env||{})}, headers={...(config.headers||{})}
  for(const [key,alias] of Object.entries(aliases)){
    const binding=item.credentialBindings?.[key]
    const placeholder=`openshell:resolve:env:${alias}`
    if(binding?.header) headers[binding.header]=(binding.prefix||'')+placeholder
    else env[key]=placeholder
  }
  if(Object.keys(env).length)config.env=env
  if(Object.keys(headers).length)config.headers=headers
  return {...item,config,credentialRef:{provider,aliases},credentialFields:[],issues:item.issues.filter(i=>!i.startsWith('Connect credentials'))}
}
