import * as React from 'react'
import { api } from '@/lib/api'

const LocationContext = React.createContext(null)

export function LocationProvider({ location, children }) {
  const scoped = React.useMemo(() => location?.context ? api.forContext(location.context) : api, [location?.context])
  const value = React.useMemo(() => ({ location, api: scoped }), [location, scoped])
  return <LocationContext.Provider value={value}>{children}</LocationContext.Provider>
}

export function useApi() {
  return React.useContext(LocationContext)?.api ?? api
}

export function useLocation() {
  return React.useContext(LocationContext)?.location ?? null
}
