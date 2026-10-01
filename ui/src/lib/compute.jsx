import * as React from 'react'
import { createApi } from './api.js'
import { COMPUTE_KEY, initialComputeTarget, setComputeTarget, advanceComputeOwner, setCloudOwner } from './compute-target.js'
import { CLOUD_ORIGIN, localCloudRequest, waitForCloudReady, createLocalSignInAttempt } from './local-cloud.js'

const ComputeContext = React.createContext(null)
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
  const value = { target: 'cloud', localViewer: false, nativeActions: false, user, logout }
  // The cloud console's workspace API is already owner-routed at /api/os.
  return <ComputeContext.Provider value={value}><ComputeSession target="local">{children}</ComputeSession></ComputeContext.Provider>
}
function CloudReadyGate({ children, status, onStatus, onCancel }) {
  const [ready, setReady] = React.useState(status.machine?.status === 'ready')
  const [machine, setMachine] = React.useState(status.machine)
  const [error, setError] = React.useState('')
  const [retry, setRetry] = React.useState(0)
  React.useEffect(() => {
    if (ready) return
    const controller = new AbortController()
    setError('')
    waitForCloudReady(() => localCloudRequest('machine'), { signal: controller.signal, onProgress: value => { setMachine(value.machine); onStatus(value) } })
      .then(() => setReady(true)).catch(e => { if (e.name !== 'AbortError') setError(e.message) })
    return () => controller.abort()
  }, [retry, ready, onStatus])
  if (ready) return children
  return <main className="grid min-h-screen place-items-center px-6"><section className="max-w-sm text-center">
    <img src="/openrod.svg" alt="OpenRod" className="mx-auto mb-6 h-10 w-10" />
    <h1 className="text-2xl font-semibold">Preparing your private machine…</h1>
    <p role="status" className="mt-3 text-sm text-muted-foreground">{machine?.message || 'Your account has one dedicated machine. Its first start can take several minutes.'}</p>
    {error && <><p role="alert" className="mt-4 text-sm text-destructive">{error}</p><button className="mt-4 text-sm underline" onClick={() => setRetry(n => n + 1)}>Try again</button></>}
    <button className="mt-6 block w-full text-xs underline" onClick={onCancel}>Use local compute</button>
    <a href={CLOUD_ORIGIN} target="_blank" rel="noopener noreferrer" className="mt-4 block text-xs underline">Open cloud console</a>
  </section></main>
}
export function LocalComputeProvider({ children }) {
  const [target, setTarget] = React.useState(() => initialComputeTarget(window.location.href, window.sessionStorage))
  const [status, setStatus] = React.useState(null)
  const [error, setError] = React.useState('')
  const [connecting, setConnecting] = React.useState(false)
  const [createRequested, requestCreate] = React.useState(false)
  const pending = React.useRef(null)
  const sessionOwner = React.useRef({uid:null,revision:0})
  setComputeTarget(target)
  setCloudOwner(status?.connected ? status.owner : null)
  React.useEffect(() => {
    let alive = true
    localCloudRequest('status').then(value => { if (alive) setStatus(value) }).catch(e => { if (alive) { setError(e.message); setStatus({ connected: false }) } })
    const expired = () => { setStatus({ connected: false }); setError('Your cloud connection expired. Connect again to continue.') }
    window.addEventListener('openrod-session-expired', expired)
    return () => { alive = false; window.removeEventListener('openrod-session-expired', expired); pending.current?.cancel('Cloud connection cancelled.') }
  }, [])
  React.useEffect(() => {
    if (!status?.connected || !status.expires) return
    const expires = typeof status.expires === 'number' ? status.expires : Date.parse(status.expires)
    if (!Number.isFinite(expires)) return
    const timer = setTimeout(() => { setStatus({ connected: false }); setError('Your cloud connection expired. Connect again to continue.') }, Math.max(0, expires - Date.now()))
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
    if (pending.current) throw new Error('A cloud sign-in is already open.')
    const popup = window.open('about:blank', '_blank', 'popup,width=520,height=720')
    if (!popup) throw new Error('Allow popups to connect your local OpenRod to cloud.')
    const attempt = createLocalSignInAttempt({ popup, origin: window.location.origin })
    // Ownership is synchronous: Cancel can stop even a delayed /start request.
    pending.current = attempt
    setConnecting(true); setError('')
    try {
      const value = await attempt.promise
      if (pending.current !== attempt) throw new Error('Cloud sign-in was cancelled.')
      setCloudOwner(value.owner)
      setStatus(value)
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
    try { await localCloudRequest('disconnect', {}); setStatus({ connected: false }); selectTarget('local') }
    catch (e) { if ([401,403].includes(e.status)) { setStatus({connected:false}); selectTarget('local') }; setError(e.message) }
  }
  sessionOwner.current = advanceComputeOwner(sessionOwner.current, status?.connected ? status.user?.uid : null)
  const ownerScope = sessionOwner.current.revision
  const sessionKey = `${target}:${ownerScope}`
  const value = { target, localViewer: true, nativeActions: target === 'local' || Boolean(status?.connected), user: status?.user, connected: Boolean(status?.connected), connecting, error, connect, disconnect, selectTarget, createRequested, requestCreate, cancelConnect: () => cancelConnect() }
  return <ComputeContext.Provider value={value}>
    {target === 'cloud' && !status?.connected ? <main className="grid min-h-screen place-items-center px-6"><section className="max-w-sm text-center">
      <img src="/openrod.svg" alt="OpenRod" className="mx-auto mb-6 h-10 w-10" />
      <h1 className="text-2xl font-semibold">Connect your cloud workspace</h1>
      <p className="mt-3 text-sm text-muted-foreground">Sign in with Google to control your private cloud machine from local OpenRod.</p>
      {error && <p role="alert" className="mt-4 text-sm text-destructive">{error}</p>}
      <button disabled={status === null || connecting} className="mt-6 rounded-lg bg-primary px-4 py-3 text-sm text-primary-foreground disabled:opacity-50" onClick={() => connect().catch(() => {})}>{status === null ? 'Checking connection…' : connecting ? 'Connecting…' : 'Continue with Google'}</button>
      <button className="mt-4 block w-full text-xs underline" onClick={() => { cancelConnect(); selectTarget('local') }}>Use local compute</button>
    </section></main> : target === 'cloud' ? <CloudReadyGate key="cloud" status={status} onStatus={setStatus} onCancel={() => selectTarget('local')}><ComputeSession key={sessionKey} target={target} ownerScope={ownerScope}>{children}</ComputeSession></CloudReadyGate> : <ComputeSession key={sessionKey} target={target} ownerScope={ownerScope}>{children}</ComputeSession>}
  </ComputeContext.Provider>
}
