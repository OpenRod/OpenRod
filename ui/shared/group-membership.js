export const GROUP_LABEL = 'openshell.console/group'
export const GROUP_LABEL_PREFIX = 'openshell.console/group-'

// Accept the original single-group format when reading saved state or requests.
export function groupIds(value) {
  if (value == null) return []
  const ids = Array.isArray(value) ? value : [value]
  if (ids.some((id) => typeof id !== 'string' || !id)) throw new Error('Groups must be a list of group IDs.')
  return [...new Set(ids)]
}

export function groupsFromLabels(labels = {}) {
  const ids = Object.entries(labels).filter(([key, value]) => key.startsWith(GROUP_LABEL_PREFIX) && value === 'true').map(([key]) => key.slice(GROUP_LABEL_PREFIX.length))
  return ids.length ? ids : groupIds(labels[GROUP_LABEL])
}

// One label per group avoids the size and character limits of label values.
export function labelsForGroups(value) {
  return Object.fromEntries(groupIds(value).map((id) => [`${GROUP_LABEL_PREFIX}${id}`, 'true']))
}

export function groupsOf(sandbox, members, groups) {
  const ids = Object.hasOwn(members, sandbox.name) ? groupIds(members[sandbox.name]) : groupsFromLabels(sandbox.labels)
  return ids.filter((id) => groups.some((g) => g.id === id))
}

export function changeGroups(current, requested, mode = 'replace') {
  const ids = groupIds(requested)
  if (mode === 'add') return groupIds([...groupIds(current), ...ids])
  if (mode === 'remove') return groupIds(current).filter((id) => !ids.includes(id))
  if (mode === 'replace') return ids
  throw new Error('Unknown membership operation.')
}
