// Where a sandbox runs, as a person thinks of it. Gateways report SSH hosts as
// `remote`; a cloud gateway will report `placement: "cloud"` once it ships.
export const PLACEMENTS = {
  local: { id: 'local', label: 'Local', hint: 'Runs on this computer' },
  remote: { id: 'remote', label: 'Remote', hint: 'Runs on an SSH host' },
  cloud: { id: 'cloud', label: 'Cloud', hint: 'Runs on a cloud machine' },
}

export const placementOf = (location) => PLACEMENTS[location?.placement]?.id ?? (location?.remote ? 'remote' : 'local')
