// Sequential requests let each deletion see the preceding policy change,
// including the server's protection for a sandbox's last inherited network rule.
export async function deleteNetworkPolicies(policies, remove) {
  const deleted = [], failed = [], syncFailures = []
  for (const policy of policies) {
    try {
      const result = await remove(policy.id)
      deleted.push(policy.id)
      for (const failure of result.failed ?? []) syncFailures.push({ ...failure, rule: policy.name })
    } catch (error) {
      failed.push({ id: policy.id, name: policy.name, message: error.message })
    }
  }
  return { deleted, failed, syncFailures }
}
