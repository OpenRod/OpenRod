import { groupIds } from './group-membership.js'

// Shared by launch previews and the server. Legacy global/per-sandbox rules
// remain readable, but do not satisfy the required group policy assignment.
export function groupNetworkPolicies(policies = [], group) {
  const ids = groupIds(group)
  return policies.filter((p) => !p.appliesTo.everyone && p.appliesTo.groups.some((id) => ids.includes(id)))
}

export function assertPolicyGroup(policy, groups) {
  const to = policy.appliesTo
  if (to.everyone || to.sandboxes.length || !to.groups.length) throw new Error('Choose at least one group for this network rule.')
  if (to.groups.some((id) => !groups.some((g) => g.id === id))) throw new Error('Unknown group.')
}

// Groups are optional; a sandbox without group rules starts locked down.
// Cloud transfers still ask for a group with a network rule.
export function assertSandboxGroup(group, groups, policies, requireRule = false) {
  const ids = groupIds(group)
  if (requireRule && !ids.length) throw new Error('Choose at least one group for this sandbox.')
  if (ids.some((id) => !groups.some((g) => g.id === id))) throw new Error('Unknown group.')
  if (requireRule && !groupNetworkPolicies(policies, group).length) throw new Error('Add a network rule to at least one selected group before creating or updating a sandbox.')
}

export function assertPolicyCoverage(before, after, memberships) {
  for (const group of memberships) {
    if (groupNetworkPolicies(before, group).length && !groupNetworkPolicies(after, group).length) {
      throw new Error('This is the last network rule inherited by a sandbox. Add another rule or update its groups first.')
    }
  }
}
