import { userInfo } from 'node:os'
import { identityContext } from './security.js'

// This local console has no per-browser login. Attribute launches to its
// configured operator, or the OS account running the server, never request data.
export function sandboxIdentityLabels() {
  const identity = identityContext.getStore()
  if (identity) return { 'openshell.console/created-by': identity.uid, 'openshell.console/owner': identity.uid, 'openrod/org': identity.org }
  const operator = process.env.OPENSHELL_CONSOLE_OPERATOR?.trim() || userInfo().username
  return {
    'openshell.console/created-by': operator,
    'openshell.console/owner': operator,
  }
}
