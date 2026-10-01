import { discoverOAuthServerInfo } from '@modelcontextprotocol/sdk/client/auth.js'
import { oauthFetch, publicHTTPS } from './setup-http.js'
// Metadata only. The sandbox's own harness owns authorization, tokens and
// refresh. New sign-in hosts are proposed, never silently contacted or granted.
export async function discoverSignIn(item) {
  const allowed = new Set([new URL(item.config.url).hostname, ...item.requirements.filter(r => r.phase === 'auth').map(r => r.host)])
  const pending = new Set()
  let metadata
  try {
    metadata = await discoverOAuthServerInfo(item.config.url, { fetchFn: (url, init = {}) => {
      if (init.method && init.method !== 'GET') throw new Error('Metadata discovery only permits GET')
      return oauthFetch(url, init, allowed, pending)
    } })
  } catch { /* Unknown auth destinations remain explicit proposed requirements. */ }
  const server = metadata?.authorizationServerMetadata
  for (const value of [server?.authorization_endpoint, server?.token_endpoint, server?.registration_endpoint]) {
    if (value) { try { const host = publicHTTPS(value).hostname; if (!allowed.has(host)) pending.add(host) } catch {} }
  }
  const requirements = [...item.requirements]
  const mcpHost = new URL(item.config.url).hostname
  if (!requirements.some(r => r.phase === 'auth' && r.host === mcpHost)) requirements.push({phase:'auth',host:mcpHost,port:443,path:'/.well-known/**',reason:'The agent reads MCP sign-in metadata here; this does not grant access to other API paths.'})
  for (const host of pending) if (!requirements.some(r => r.host === host && r.phase === 'auth')) requirements.push({ phase:'auth',host,port:443,reason:'Sign-in metadata identified this authorization service. The agent needs this access for account connection and refresh.' })
  return { ...item, requirements, auth: {mode:'agent-session',status:'sign-in-required',discovery:server?'metadata-found':'destinations-proposed'} }
}
