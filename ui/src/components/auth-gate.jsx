import { CloudComputeProvider, LocalComputeProvider, useCompute } from '@/lib/compute'
import { LocalConnect } from './local-connect'
import { CloudBuildDialog } from './cloud-build-dialog'
import { LocalReturn } from './local-return'
import { CloudMachine } from './cloud-machine'
import * as React from 'react'
import { Cloud } from 'lucide-react'
import { toast } from 'sonner'
import { buttonVariants } from '@/components/ui/button'

async function authRequest(path, body) {
  const response = await fetch(`/api/auth/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'content-type': 'application/json', 'x-openshell-console': '1' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const value = await response.json()
  if (!response.ok) throw new Error(value.error ?? 'Sign-in unavailable')
  return value
}
export const useCloudMode = () => useCompute()?.target === 'cloud'
export function CloudAccount() {
  const compute = useCompute()
  const [open, setOpen] = React.useState(false)
  if (!compute?.localViewer) return <div className="ml-auto flex items-center gap-3 text-xs"><span className="max-w-40 truncate text-muted-foreground">{compute?.user?.email}</span><button className="underline underline-offset-4" onClick={compute?.logout}>Sign out</button></div>
  return <div className="ml-auto flex items-center gap-3 text-xs">
    <label className="flex items-center gap-2"><span className="text-muted-foreground">Compute</span><select aria-label="Compute target" className="rounded-md border bg-background px-2 py-1.5 text-foreground" value={compute.target} onChange={e => e.target.value === 'cloud' && !compute.connected ? setOpen(true) : compute.selectTarget(e.target.value)}><option value="local">Local</option><option value="cloud">Cloud</option></select></label>
    {compute.connected && <><span className="hidden max-w-40 truncate text-muted-foreground sm:block">{compute.user?.email}</span><button className="underline underline-offset-4" onClick={compute.disconnect}>Sign out</button></>}
    {!compute.connected && <button disabled={compute.connecting} onClick={() => compute.connect().catch(e => toast.error('Couldn’t sign in', {description:e.message}))} className={buttonVariants({ size: 'sm', variant: 'outline' })}>{compute.connecting ? 'Signing in…' : 'Sign in'}</button>}
    <button onClick={() => setOpen(true)} className={buttonVariants({ size: 'sm', className: 'gap-2' })}><Cloud aria-hidden="true" />Build in cloud</button>
    <CloudBuildDialog open={open} onOpenChange={setOpen} />
  </div>
}
export function AuthGate({ children }) {
  const [config, setConfig] = React.useState(null)
  const [user, setUser] = React.useState(null)
  const [loading, setLoading] = React.useState(true)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState('')
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
    window.addEventListener('openrod-session-expired', expired)
    return () => { alive = false; window.removeEventListener('openrod-session-expired', expired) }
  }, [])
  async function login() {
    setBusy(true); setError('')
    let auth, sdk
    try {
      const { initializeApp, getApps } = await import('firebase/app')
      sdk = await import('firebase/auth')
      auth = sdk.getAuth(getApps()[0] ?? initializeApp(config.firebase))
      await sdk.setPersistence(auth, sdk.inMemoryPersistence)
      const result = await sdk.signInWithPopup(auth, new sdk.GoogleAuthProvider())
      const session = await authRequest('session', { idToken: await result.user.getIdToken() })
      setUser(session.user ?? null)
    } catch (e) { setError(e.message) }
    finally { if (auth) await sdk.signOut(auth).catch(() => {}); setBusy(false) }
  }
  async function logout() {
    try { await authRequest('logout', {}) } catch (e) { setError(e.message) }
    finally { setUser(null) }
  }
  if (loading) return <div className="grid min-h-screen place-items-center text-sm text-muted-foreground">Loading OpenRod…</div>
  if (config?.mode === 'local') return <LocalComputeProvider><LocalReturn>{children}</LocalReturn></LocalComputeProvider>
  if (user) return <LocalConnect user={user} logout={logout}><CloudComputeProvider user={user} logout={logout}><CloudMachine key={user.uid} logout={logout}>{children}</CloudMachine></CloudComputeProvider></LocalConnect>
  return <main className="grid min-h-screen place-items-center bg-background px-6">
    <section className="w-full max-w-sm rounded-xl border border-border bg-card p-8 text-center shadow-sm">
      <img src="/openrod.svg" alt="OpenRod" className="mx-auto mb-6 h-10 w-10" />
      <h1 className="text-2xl font-semibold tracking-tight">{window.location.hash.startsWith('#local-connect=') ? 'Sign in to OpenRod' : 'Your workspace, in the cloud.'}</h1>
      <p className="mt-3 text-sm text-muted-foreground">{window.location.hash.startsWith('#local-connect=') ? 'Sign in with Google. You’ll return to local OpenRod automatically.' : 'Sign in or create your account with Google. Your workspace runs on your own private machine.'}</p>
      {error && <p role="alert" className="mt-4 text-sm text-destructive">{error}</p>}
      <button disabled={busy || !config} onClick={login} className="mt-6 w-full rounded-lg bg-primary px-4 py-3 text-sm font-medium text-primary-foreground disabled:opacity-50">{busy ? 'Signing in…' : 'Continue with Google'}</button>
      <p className="mt-5 text-xs text-muted-foreground">Running OpenRod locally? No account required.</p>
    </section>
  </main>
}
