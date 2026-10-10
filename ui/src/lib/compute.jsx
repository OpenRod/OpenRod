import * as React from 'react'
import { createApi } from './api.js'
import { COMPUTE_KEY, setComputeTarget, advanceComputeOwner, setCloudOwner } from './compute-target.js'
import { CLOUD_ORIGIN } from './cloud-origin.js'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { localCloudRequest, waitForCloudReady, prepareCloudMachine, createLocalSignInAttempt } from './local-cloud.js'

const ComputeContext = React.createContext(null)
// Set by Disconnect: the next sign-in picks a Google account instead of
// reusing the cloud console's existing session.
const CHOOSE_ACCOUNT_KEY = 'openrod-cloud-choose-account'
const storedFlag = { get: () => { try { return localStorage.getItem(CHOOSE_ACCOUNT_KEY) === '1' } catch { return false } }, set: on => { try { on ? localStorage.setItem(CHOOSE_ACCOUNT_KEY, '1') : localStorage.removeItem(CHOOSE_ACCOUNT_KEY) } catch {} } }
const ApiContext = React.createContext(null)
export const useCompute = () => React.useContext(ComputeContext)
export function useApi() {
  const value = React.useContext(ApiContext)
  if (!value) throw new Error('useApi outside ComputeSession')
  return value
}
export function ScopedComputeProvider({ target, children }) {
  const parent = useCompute()
  const value = React.useMemo(() => target && parent?.localViewer ? { ...parent, target, nativeActions: target === 'local' || Boolean(parent.connected) } : parent, [parent, target])
  return <ComputeContext.Provider value={value}>{children}</ComputeContext.Provider>
}
export function ComputeSession({ target, ownerScope, children }) {
  const session = React.useMemo(() => {
    const controller = new AbortController()
    return { controller, generation: 0, api: createApi(target, controller.signal) }
  }, [target, ownerScope])
  React.useEffect(() => {
    const generation = ++session.generation
    return () => queueMicrotask(() => { if (generation === session.generation) session.controller.abort() })
  }, [session])
  return <ApiContext.Provider value={session.api}>{children}</ApiContext.Provider>
}
export function CloudComputeProvider({ children, user, logout }) {
  setComputeTarget('cloud')
  const value = { target: 'cloud', localViewer: false, nativeActions: false, user, logout, connected: true, available: true }
  // The cloud console's workspace API is already owner-routed at /api/os.
  return <ComputeContext.Provider value={value}><ComputeSession target="local">{children}</ComputeSession></ComputeContext.Provider>
}
function CloudReadyGate({ children, status, onStatus, onCancel }) {
  const [ready, setReady] = React.useState(status.machine?.status === 'ready')
  const [machine, setMachine] = React.useState(status.machine)
  const [error, setError] = React.useState('')
  const [retry, setRetry] = React.useState(0)
  const [requested, setRequested] = React.useState(false)
  React.useEffect(() => {
    if (ready) return
    const controller = new AbortController()
    setError('')
    localCloudRequest('machine', requested ? {} : undefined, { signal: controller.signal }).then(value => { if (value.machine?.status === 'none') { setMachine(value.machine); return null }; return waitForCloudReady(() => localCloudRequest('machine', undefined, { signal: controller.signal }), { signal: controller.signal, onProgress: value => { setMachine(value.machine); onStatus(value) } }) })
      .then(value => { if (value) setReady(true) }).catch(e => { if (e.name !== 'AbortError') setError(e.message) })
    return () => controller.abort()
  }, [retry, ready, onStatus, requested])
  if (ready) return children
  return <main className="grid min-h-screen place-items-center px-6"><section className="max-w-sm text-center">
    <h1 className="text-2xl font-semibold">{machine?.status === "none" ? "Start OpenRod Cloud" : "Starting your cloud machine…"}</h1>
    <p role="status" className="mt-3 text-sm text-muted-foreground">{machine?.message || 'Your account has one dedicated machine. Its first start can take several minutes.'}</p>
    {machine?.status === 'none' && !error && <Button className="mt-5" onClick={() => setRequested(true)}>Start cloud machine</Button>}
    {error && <><p role="alert" className="mt-4 text-sm text-destructive">{error}</p><button className="mt-4 text-sm underline" onClick={() => { setRequested(true); setRetry(n => n + 1) }}>Try again</button></>}
    <button className="mt-6 block w-full text-xs underline" onClick={onCancel}>Use local compute</button>
    {CLOUD_ORIGIN && <a href={CLOUD_ORIGIN} target="_blank" rel="noopener noreferrer" className="mt-4 block text-xs underline">Open cloud console</a>}
  </section></main>
}
export function LocalComputeProvider({ children }) {
  // Local OpenRod remains the combined shell. Resource URLs carry their own
  // destination; legacy saved global targets must not route the whole app.
  const [target, setTarget] = React.useState('local')
  const [status, setStatus] = React.useState(null)
  const [error, setError] = React.useState('')
  const [connecting, setConnecting] = React.useState(false)
  const [createRequested, requestCreate] = React.useState(false)
  const pending = React.useRef(null)
  // Cloud setup outlives the location dialog that starts it: sign-in and a
  // first machine start can take minutes, so the dialog may close meanwhile.
  const [cloudSetup, setCloudSetup] = React.useState(null)
  const [setupWatchers, setSetupWatchers] = React.useState(0)
  const setupRun = React.useRef(null)
  const refresh = React.useCallback(async (signal) => {
    const value = await localCloudRequest('status', undefined, { signal })
    setStatus(current => ({ ...current, ...value }))
    setError(value.error ?? '')
    return value
  }, [])
  const sessionOwner = React.useRef({uid:null,revision:0})
  setComputeTarget(target)
  setCloudOwner(status?.connected ? status.owner : null)
  React.useEffect(() => {
    let alive = true
    localCloudRequest('status').then(value => { if (alive) { setStatus(value); setError(value.error ?? '') } }).catch(e => { if (alive) { setError(e.message); setStatus({ connected: false, available: false }) } })
    const expired = () => { setStatus(current => ({ ...current, connected: false, machine: null })); setError('Your cloud connection expired. Connect again to continue.') }
    window.addEventListener('openrod-session-expired', expired)
    return () => { alive = false; window.removeEventListener('openrod-session-expired', expired); pending.current?.cancel('Cloud connection cancelled.'); setupRun.current?.controller.abort() }
  }, [])
  React.useEffect(() => {
    if (!status?.connected || !status.expires) return
    const expires = typeof status.expires === 'number' ? status.expires : Date.parse(status.expires)
    if (!Number.isFinite(expires)) return
    const timer = setTimeout(() => { setStatus(current => ({ ...current, connected: false, machine: null })); setError('Your cloud connection expired. Connect again to continue.') }, Math.max(0, expires - Date.now()))
    return () => clearTimeout(timer)
  }, [status])
  function selectTarget(next) {
    if (!['local', 'cloud'].includes(next)) return
    try { sessionStorage.setItem(COMPUTE_KEY, next) } catch {}
    const url = new URL(window.location.href)
    url.searchParams.delete('target')
    url.hash = ''
    window.history.replaceState(null, '', url)
    window.dispatchEvent(new HashChangeEvent('hashchange'))
    setTarget(next)
  }
  async function connect() {
    if (status?.connected) return status
    if (!status?.available) throw new Error(status?.reason || 'OpenRod Cloud is not configured on this computer.')
    if (pending.current) throw new Error('A cloud sign-in is already open.')
    const popup = window.open('about:blank', '_blank', 'popup,width=760,height=720')
    if (!popup) throw new Error('Allow popups to connect your local OpenRod to cloud.')
    const attempt = createLocalSignInAttempt({ popup, origin: window.location.origin, cloud: status.origin || CLOUD_ORIGIN, chooseAccount: storedFlag.get() })
    // Ownership is synchronous: Cancel can stop even a delayed /start request.
    pending.current = attempt
    setConnecting(true); setError('')
    try {
      const value = await attempt.promise
      if (pending.current !== attempt) throw new Error('Cloud sign-in was cancelled.')
      setCloudOwner(value.owner)
      storedFlag.set(false)
      setStatus(current => ({ ...current, ...value }))
      return value
    } catch (error) {
      if (pending.current === attempt) setError(error.message)
      throw error
    } finally {
      if (pending.current === attempt) { pending.current = null; setConnecting(false) }
    }
  }
  function cancelConnect(message = 'Cloud connection cancelled.') {
    const attempt = pending.current
    if (!attempt) return
    // Retire this owner immediately so an older rejection cannot clear a new one.
    pending.current = null
    setConnecting(false); setError(message)
    return attempt.cancel(message)
  }

  async function disconnect() {
    storedFlag.set(true)
    try { const value = await localCloudRequest('disconnect', {}); setStatus(value); selectTarget('local') }
    catch (e) { if ([401,403].includes(e.status)) { setStatus(current => ({ ...current, connected: false, machine: null })); selectTarget('local') }; setError(e.message); throw e }
  }
  async function prepare({ signal, onProgress } = {}) {
    signal?.throwIfAborted()
    const connection = connect()
    const attempt = pending.current
    const cancel = () => { if (attempt && pending.current === attempt) cancelConnect() }
    signal?.addEventListener('abort', cancel, { once: true })
    let connected
    try { connected = await connection } finally { signal?.removeEventListener('abort', cancel) }
    signal?.throwIfAborted()
    const owner = connected.owner
    const update = value => {
      if (value.owner !== owner) throw new Error('Your cloud account changed. Choose the destination again.')
      setStatus(current => ({ ...current, ...value })); onProgress?.(value)
    }
    return prepareCloudMachine({ owner, signal, onProgress: update })
  }
  function startCloudSetup() {
    if (setupRun.current) return
    const run = { controller: new AbortController() }
    setupRun.current = run
    const set = patch => { if (setupRun.current === run) setCloudSetup(current => ({ ...current, ...patch })) }
    setCloudSetup({ stage: status?.connected ? 'preparing' : 'signing-in', error: null })
    prepare({ signal: run.controller.signal, onProgress: value => set({ stage: 'preparing', machine: value.machine }) })
      .then(() => { set({ stage: 'ready' }); refresh().catch(() => {}) })
      .catch(reason => { if (reason.name === 'AbortError' || run.controller.signal.aborted) { if (setupRun.current === run) setCloudSetup(null) } else set({ stage: 'failed', error: reason.message }) })
      .finally(() => { if (setupRun.current === run) setupRun.current = null })
  }
  function cancelCloudSetup() {
    const run = setupRun.current
    setupRun.current = null
    run?.controller.abort()
    setCloudSetup(null)
  }
  function dismissCloudSetup() { if (!setupRun.current) setCloudSetup(null) }
  // While a location dialog shows the setup, the background notice stays hidden.
  const watchCloudSetup = React.useCallback(() => { setSetupWatchers(n => n + 1); return () => setSetupWatchers(n => n - 1) }, [])
  sessionOwner.current = advanceComputeOwner(sessionOwner.current, status?.connected ? status.user?.uid : null)
  const ownerScope = sessionOwner.current.revision
  const sessionKey = `${target}:${ownerScope}`
  const value = { target, status, available: Boolean(status?.available), checking: status === null, refresh, prepare, localViewer: true, nativeActions: target === 'local' || Boolean(status?.connected), user: status?.user, connected: Boolean(status?.connected), connecting, error, connect, disconnect, selectTarget, createRequested, requestCreate, cancelConnect: () => cancelConnect(), cloudSetup, cloudSetupWatched: setupWatchers > 0, startCloudSetup, cancelCloudSetup, dismissCloudSetup, watchCloudSetup }
  return <ComputeContext.Provider value={value}>
    {target === 'cloud' && !status?.connected ? <main className="grid min-h-screen place-items-center px-6"><section className="max-w-sm text-center">
      <h1 className="text-2xl font-semibold">Connect your cloud workspace</h1>
      <p className="mt-3 text-sm text-muted-foreground">Sign in with Google to control your private cloud machine from local OpenRod.</p>
      {error && <p role="alert" className="mt-4 text-sm text-destructive">{error}</p>}
      <Button disabled={!status?.available || connecting} className="mt-6" onClick={() => connect().catch(() => {})}>{connecting && <Spinner />}{status === null ? 'Checking connection…' : connecting ? 'Connecting…' : 'Continue with Google'}</Button>
      {status && !status.available && <p role="status" className="mt-3 text-xs text-muted-foreground">{status.reason || 'OpenRod Cloud is not configured on this computer.'}</p>}
      <button className="mt-4 block w-full text-xs underline" onClick={() => { cancelConnect(); selectTarget('local') }}>Use local compute</button>
    </section></main> : target === 'cloud' ? <CloudReadyGate key={`cloud:${ownerScope}`} status={status} onStatus={setStatus} onCancel={() => selectTarget('local')}><ComputeSession key={sessionKey} target={target} ownerScope={ownerScope}>{children}</ComputeSession></CloudReadyGate> : <ComputeSession key={sessionKey} target={target} ownerScope={ownerScope}>{children}</ComputeSession>}
  </ComputeContext.Provider>
}
