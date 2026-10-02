// Uses the installed gateway profile, including its required flags and aliases.
export function setupIssue(profile) {
  if ((profile.credentials ?? []).some((c) => c.refresh === true || c.refresh?.strategy)) return 'This profile requires managed credential refresh setup. Configure it with the OpenShell CLI; this form does not yet support its refresh material.'
  if ((profile.credentials ?? []).some((c) => !c.envVars?.length)) return 'This profile has credentials without environment mappings and cannot be configured in this form.'
  return null
}
export function credentialFields(profile) {
  return (profile.credentials ?? []).map((c) => ({ ...c, key: c.envVars?.[0], label: c.description || c.name,
    placeholder: c.name === 'account_id' ? 'Enter account ID' : /token/.test(c.name) ? 'Paste token' : 'Paste API key',
    inputType: c.name === 'account_id' ? 'text' : 'password' }))
}
export function validateSecretCredentials(profile, input) {
  const issue = setupIssue(profile)
  if (issue) throw new Error(issue)
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Credentials must be an object.')
  const definitions = profile.credentials ?? []
  const allowed = new Set(definitions.flatMap((c) => c.envVars ?? []))
  const result = {}
  for (const [key, value] of Object.entries(input)) {
    if (!allowed.has(key)) throw new Error(`${key} is not a credential of this profile.`)
    if (typeof value !== 'string') throw new Error(`${key} must be text.`)
    if (!value) continue
    if (!value.trim() || value !== value.trim() || /[\r\n\x00]/.test(value)) throw new Error(`${key} contains whitespace or line breaks. Paste only the credential value.`)
    if (value.length > 8192) throw new Error(`${key} is too long.`)
    result[key] = value
  }
  for (const c of definitions) {
    const supplied = c.envVars.filter((key) => result[key])
    if (c.required && !supplied.length) throw new Error(`${c.description || c.name} is required.`)
    if (new Set(supplied.map((key) => result[key])).size > 1) throw new Error(`Aliases for ${c.name} must contain the same value.`)
  }
  if (definitions.length && !Object.keys(result).length) throw new Error('Enter at least one credential.')
  return result
}
