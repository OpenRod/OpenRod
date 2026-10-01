import * as React from 'react'
import { createApi } from '@/lib/api'
import { useApi as useComputeApi, useCompute, ScopedComputeProvider } from '@/lib/compute'

const LocationContext = React.createContext(null)

export function LocationProvider({ location, children }) {
  const base = useComputeApi()
  const compute = useCompute()
  // The SaaS serves its owner-routed worker at /api/os. Only the local viewer
  // uses /api/remote/os for cloud locations.
  const target = compute?.localViewer && location?.target ? location.target : base.target
  const scoped = React.useMemo(() => createApi(target, base.signal, location?.context), [target, base.signal, location?.context])
  const value = React.useMemo(() => ({ location, api: scoped }), [location, scoped])
  return <ScopedComputeProvider target={location?.target}><LocationContext.Provider value={value}>{children}</LocationContext.Provider></ScopedComputeProvider>
}

export function useApi() {
  const base = useComputeApi()
  return React.useContext(LocationContext)?.api ?? base
}

export function useLocation() {
  return React.useContext(LocationContext)?.location ?? null
}
