
export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, canonical(value[key])]))
  return value
}
const omit = (value, keys) => Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)))
const metadata = ['location', 'copies', 'sourceOrg', 'sourceSetups', 'id', 'createdAt', 'updatedAt', 'revision', 'importedAt', 'importSource', 'localSource', 'configurationCount']
export function resourceConfiguration(type, record) {
  if (type === 'network' && record.sourceOrg) {
    const groupRef = id => { const group=record.sourceOrg.groups.find(group=>group.id===id); return group ? resourceConfiguration('groups',group) : {missing:id,source:record.location?.id} }
    const setupRef = id => { const setup=record.sourceSetups?.find(setup=>setup.id===id); return setup ? resourceConfiguration('setups',setup) : {missing:id,source:record.location?.id} }
    const sort = values => values.map(value=>canonical(value)).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)))
    const value=omit(record,metadata)
    return {...value,destinations:sort(value.destinations),appliesTo:{...value.appliesTo,groups:sort(value.appliesTo.groups.map(groupRef)),setups:sort((value.appliesTo.setups ?? []).map(setupRef)),sandboxes:sort(value.appliesTo.sandboxes)},...(value.setup?{setup:{...value.setup,id:setupRef(value.setup.id)}}:{})}
  }
  if (type === 'setups') return { name: record.name, items: record.items.map(item => ({ name: item.name, kind: item.kind, contentDigest: item.contentDigest ?? record.revision })).sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) }
  if (type === 'templates') return { name: record.name, recipe: record.recipe, managed: record.managed, status: record.status, exists: record.exists }
  return omit(record, metadata)
}
export const configurationKey = (type, record) => JSON.stringify(canonical(resourceConfiguration(type, record)))
export function consolidateResources(type, records) {
  const rows = []
  for (const record of records) {
    // Inventory rows group named copies; configuration comparison remains strict
    // for edits and explicitly reports differences instead of hiding copies.
    const key = record.name
      ? JSON.stringify([type, record.name])
      : configurationKey(type, record)
    const row = rows.find(row => row.key === key && !row.copies.some(copy => copy.location?.id === record.location?.id))
    if (row) row.copies.push(record)
    else rows.push({key, copies:[record]})
  }
  return rows.map(({copies}) => ({...(copies.find(copy => copy.location?.connected !== false) ?? copies[0]), copies, configurationCount: new Set(copies.map(copy => configurationKey(type, copy))).size}))
}
export const resourceCopies = record => record?.copies ?? (record ? [record] : [])
export function matchingSources(record, records) {
  return records.filter(candidate => candidate.name === record.name && candidate.location?.id !== record.location?.id && records.filter(other => other.name === candidate.name && other.location?.id === candidate.location?.id).length === 1)
}
function mergeChanged(before, after, destination) {
  if (after && typeof after === 'object' && !Array.isArray(after)) {
    const result={...destination}
    for(const [key,value] of Object.entries(after)) {
      if(JSON.stringify(canonical(before?.[key]))!==JSON.stringify(canonical(value))) result[key]=mergeChanged(before?.[key],value,destination?.[key])
    }
    return result
  }
  return after
}
export async function applySourceChange({ type, before, args, method }, target, api) {
  if (!target.location?.connected) throw new Error('Reconnect this source before applying changes.')
  const list = type === 'setups' ? await api.setups() : type === 'templates' ? await api.imageTemplates() : (await api.org())[type === 'network' ? 'policies' : 'groups']
  const current = (Array.isArray(list) ? list : list.templates ?? []).find(item => (item.id ?? item.name) === (target.id ?? target.name))
  if (!current || configurationKey(type, {...current,sourceOrg:undefined,sourceSetups:undefined}) !== configurationKey(type, {...target,sourceOrg:undefined,sourceSetups:undefined})) throw new Error('This source changed. Reopen it before applying the edit.')
  if (method === 'deleteSetupItem') {
    const removed = before.items.find(item => item.id === args[1])
    const matches = current.items.filter(item => item.name === removed?.name && item.kind === removed?.kind && (removed.contentDigest ? item.contentDigest === removed.contentDigest : current.revision === before.revision))
    if (matches.length !== 1) throw new Error('The matching item differs on this source. Edit it separately.')
    return api.deleteSetupItem(current.id, matches[0].id, current.revision)
  }
  const patch = {}
  const old = type === 'templates' ? before.recipe : before
  for (const [key, value] of Object.entries(args[0])) {
    if (metadata.includes(key) || key === 'isNew') continue
    if (JSON.stringify(canonical(old[key])) !== JSON.stringify(canonical(value))) patch[key] = mergeChanged(old[key],value,(type === 'templates' ? current.recipe : current)[key])
  }
  if (method === 'savePolicy') {
    const org = await api.org()
    const next = {...current, ...patch, id:current.id, isNew:false}
    if (patch.appliesTo) {
      next.appliesTo={...current.appliesTo}
      for(const [key,value] of Object.entries(patch.appliesTo)) {
        if(JSON.stringify(canonical(value))===JSON.stringify(canonical(before.appliesTo[key])))continue
        if(key==='groups') next.appliesTo.groups=value.map(id=>{
          const source=before.sourceOrg?.groups.find(group=>group.id===id)
          const matches=source?org.groups.filter(group=>configurationKey('groups',group)===configurationKey('groups',source)):org.groups.filter(group=>group.id===id)
          if(matches.length!==1)throw new Error('A changed group is missing or ambiguous here. Import or select it separately.')
          return matches[0].id
        })
        else next.appliesTo[key]=value
      }
    }
    if (next.appliesTo.groups.some(id => !org.groups.some(group => group.id === id))) throw new Error('A required group is missing here. Import it first.')
    if (next.appliesTo.setups?.length) {
      const setups = await api.setups()
      if (next.appliesTo.setups.some(id => !setups.some(setup => setup.id === id))) throw new Error('A required setup is missing here. Import it first.')
    }
    return api.savePolicy(next)
  }
  if (method === 'saveGroup') return api.saveGroup({...current, ...patch, id:current.id, isNew:false})
  if (method === 'buildImageTemplate') return api.buildImageTemplate({...current.recipe, ...patch, name:current.name}, true)
  throw new Error('This change must be made separately on each source.')
}
