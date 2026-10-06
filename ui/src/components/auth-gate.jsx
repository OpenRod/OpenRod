import { CloudComputeProvider, LocalComputeProvider, useCompute } from '@/lib/compute'
import { LocalConnect } from './local-connect'
import { LocalReturn } from './local-return'
import { CloudMachine } from './cloud-machine'
import * as React from 'react'
import { initializeApp, getApps } from 'firebase/app'
import { getAuth, GoogleAuthProvider, inMemoryPersistence, setPersistence, signInWithPopup, signOut } from 'firebase/auth'
import { LINK_REQUIRED } from '@/lib/api'
import { CloudSignIn } from './cloud-sign-in'
import { cloudSignInError } from '@/lib/cloud-sign-in-error'

async function authRequest(path, body) {
  const response = await fetch(`/api/auth/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'content-type': 'application/json', 'x-openshell-console': '1' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const value = await response.json()
  if (value.code === LINK_REQUIRED) window.dispatchEvent(new Event(LINK_REQUIRED))
  if (!response.ok) throw Object.assign(new Error(value.error ?? 'Sign-in unavailable'), { code: value.code })
  return value
}
export const useCloudMode = () => useCompute()?.target === 'cloud'
export function CloudAccount() {
  const compute = useCompute()
  if (compute?.localViewer) return null
  return <div className="ml-auto flex items-center gap-3 text-xs"><span className="max-w-40 truncate text-muted-foreground">{compute?.user?.email}</span><button className="underline underline-offset-4" onClick={compute?.logout}>Sign out</button></div>
}

export function AuthGate({ children }) {
  const [config, setConfig] = React.useState(null)
  const [user, setUser] = React.useState(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState('')
  const [linkRequired, setLinkRequired] = React.useState(false)
  const [signingIn, setSigningIn] = React.useState(false)
  React.useEffect(() => {
    let alive = true
    async function load() {
      try {
        const value = await authRequest('config')
        if (!['local', 'cloud'].includes(value.mode)) throw Error('Invalid console configuration')
        if (!alive) return
        setConfig(value)
        if (value.mode === 'cloud') {
          const response = await fetch('/api/auth/me')
          if (response.ok) { const session = await response.json(); if (alive) setUser(session.user) }
          else if (response.status !== 401) { const result = await response.json(); throw Error(result.error ?? 'Authentication unavailable') }
        }
      } catch (e) { if (alive) setError(e.message) }
      finally { if (alive) setLoading(false) }
    }
    load()
    const expired = () => { setUser(null); setError('Your session expired. Sign in again.') }
    const locked = () => setLinkRequired(true)
    window.addEventListener('openrod-session-expired', expired)
    window.addEventListener(LINK_REQUIRED, locked)
    return () => { alive = false; window.removeEventListener('openrod-session-expired', expired); window.removeEventListener(LINK_REQUIRED, locked) }
  }, [])
  async function login() {
    if (signingIn || !config?.firebase) return
    setSigningIn(true); setError('')
    let auth
    try {
      const app = getApps().find(app => app.name === 'openrod-cloud') ?? initializeApp(config.firebase, 'openrod-cloud')
      auth = getAuth(app)
      await setPersistence(auth, inMemoryPersistence)
      const provider = new GoogleAuthProvider()
      provider.setCustomParameters({ prompt: 'select_account' })
      const credential = await signInWithPopup(auth, provider)
      const session = await authRequest('session', { idToken: await credential.user.getIdToken(true) })
      setUser(session.user)
    } catch (reason) {
      setError(cloudSignInError(reason))
    } finally { if (auth) await signOut(auth).catch(() => {}); setSigningIn(false) }
  }
  async function logout() {
    try { await authRequest('logout', {}) } catch (e) { setError(e.message) }
    finally { setUser(null) }
  }
  if (linkRequired) return <main className="grid min-h-screen place-items-center bg-background px-6">
    <section className="w-full max-w-md rounded-xl border border-border bg-card p-8 text-center shadow-sm">
      <h1 className="text-2xl font-semibold tracking-tight">Open the console link</h1>
      <p className="mt-3 text-sm text-muted-foreground">Open the link printed by <code className="rounded bg-muted px-1 py-0.5 font-mono text-foreground">openrod</code> in your terminal. It carries a secret that changes every time the console starts, so open the new link after a restart.</p>
    </section>
  </main>
  if (loading) return <div className="grid min-h-screen place-items-center text-sm text-muted-foreground">Loading OpenRod…</div>
  if (config?.mode === 'local') return <LocalComputeProvider><LocalReturn>{children}</LocalReturn></LocalComputeProvider>
  if (user) return <LocalConnect user={user} logout={logout}><CloudComputeProvider user={user} logout={logout}><CloudMachine key={user.uid} logout={logout}>{children}</CloudMachine></CloudComputeProvider></LocalConnect>
  return <CloudSignIn localConnect={window.location.hash.startsWith('#local-connect=')} error={error} busy={signingIn} available={Boolean(config?.firebase)} onLogin={login} />
}
