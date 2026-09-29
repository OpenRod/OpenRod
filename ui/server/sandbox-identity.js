import { userInfo } from 'node:os'

// This local console has no per-browser login. Attribute launches to its
// configured operator, or the OS account running the server, never request data.
export function sandboxIdentityLabels() {
  const operator = process.env.OPENSHELL_CONSOLE_OPERATOR?.trim() || userInfo().username
  return {
    'openshell.console/created-by': operator,
    'openshell.console/owner': operator,
  }
}
