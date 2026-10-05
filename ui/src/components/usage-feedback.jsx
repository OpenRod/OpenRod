import * as React from 'react'
import { MessageSquare } from 'lucide-react'
import { analytics } from '@/lib/analytics'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'

const UsageContext = React.createContext(null)
export const useUsageState = () => React.useSyncExternalStore(analytics.subscribe, analytics.getSnapshot)

export function UsageProvider({ children }) {
  const state = useUsageState()
  const [dialog, setDialog] = React.useState(null)
  React.useEffect(() => {
    const changed = () => analytics.refresh()
    window.addEventListener('storage', changed)
    window.addEventListener('focus', changed)
    return () => { window.removeEventListener('storage', changed); window.removeEventListener('focus', changed) }
  }, [])
  const open = React.useCallback((next = 'settings') => setDialog(next), [])
  function chooseSharing(value) {
    analytics.setSharing(value)
    setDialog(null)
  }
  return <UsageContext.Provider value={open}>
    {children}
    <Dialog open={Boolean(dialog)} onOpenChange={value => { if (!value) setDialog(null) }}>
      <DialogContent className={dialog === 'details' ? 'max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg' : 'sm:max-w-sm'}>
        {dialog === 'settings' ? <>
          <DialogHeader>
            <DialogTitle>Usage and feedback</DialogTitle>
            <DialogDescription>Share anonymous usage metrics with PostHog ({state.destination}) to improve OpenRod. No commands or project content.</DialogDescription>
          </DialogHeader>
          <p className="text-xs font-medium" role="status">Usage sharing: {state.available && state.sharing ? 'On' : 'Off'}</p>
          {state.available ? <div className="flex flex-wrap justify-end gap-2">
            <Button size="sm" variant="outline" onClick={() => chooseSharing(false)}>Turn sharing off</Button>
            <Button size="sm" onClick={() => chooseSharing(true)}>Share anonymous usage</Button>
          </div> : <p className="text-xs text-muted-foreground">Usage sharing is disabled for this console.</p>}
          <div className="flex flex-wrap gap-2 border-t pt-3">
            <Button size="sm" variant="outline" onClick={() => setDialog('feedback')}>Give feedback</Button>
            <Button size="sm" variant="ghost" onClick={() => open('details')}>What is being shared?</Button>
          </div>
        </> : dialog === 'details' ? <UsageDetails destination={state.destination} /> : dialog === 'feedback' ? <FeedbackForm canSend={state.available} onClose={() => setDialog(null)} /> : null}
      </DialogContent>
    </Dialog>
  </UsageContext.Provider>
}

export function UsageButton() {
  const open = React.useContext(UsageContext)
  if (!open) return null
  return <Button variant="ghost" size="xs" className="justify-start text-xs text-muted-foreground" onClick={() => open()}><MessageSquare className="size-3" aria-hidden="true" />Usage &amp; feedback</Button>
}

export function UsageNotice() {
  const open = React.useContext(UsageContext)
  const state = useUsageState()
  if (!open || !state.available || state.sharing !== null) return null
  return <div role="group" aria-label="Optional usage sharing" className="pt-1 text-[11px] leading-relaxed text-muted-foreground">
    <p>Share anonymous metrics via PostHog.</p>
    <div className="-ml-1.5 flex flex-wrap gap-x-1">
      <Button type="button" variant="ghost" size="xs" className="px-1.5 text-[11px] font-normal" onClick={() => analytics.setSharing(true)}>Share anonymous usage</Button>
      <Button type="button" variant="ghost" size="xs" className="px-1.5 text-[11px] font-normal" onClick={() => analytics.setSharing(false)}>No thanks</Button>
      <Button type="button" variant="ghost" size="xs" className="px-1.5 text-[11px] font-normal" onClick={() => open('details')}>What is being shared?</Button>
    </div>
  </div>
}

function UsageDetails({ destination }) {
  return <>
    <DialogHeader>
      <DialogTitle className="pr-6">What is being shared?</DialogTitle>
      <DialogDescription>Usage metrics are sent only after you choose to share.</DialogDescription>
    </DialogHeader>
    <dl className="grid gap-3 text-xs leading-relaxed text-muted-foreground">
      <div><dt className="font-medium text-foreground">Usage events</dt><dd>Screens opened, connection and sandbox actions, session launches, feature use, and structured success or error categories.</dd></div>
      <div><dt className="font-medium text-foreground">Event metadata</dt><dd>App version, environment, timestamps, random browser and session IDs, predefined options, counts and durations. Sessions expire after 30 minutes of inactivity.</dd></div>
      <div><dt className="font-medium text-foreground">Excluded content</dt><dd>No commands, terminal output, project content, resource names, hosts, paths, credentials, full URLs or raw errors. No session replay or automatic click tracking.</dd></div>
      <div><dt className="font-medium text-foreground">Manual feedback</dt><dd>Only text you explicitly submit, up to 2,000 characters. You can send feedback with usage sharing off; please omit private details.</dd></div>
      <div><dt className="font-medium text-foreground">Delivery</dt><dd>Sent directly to PostHog in the {destination}. PostHog receives network metadata such as your IP address; GeoIP enrichment and person profiles are disabled. Blocked or offline delivery fails silently, with a 3-second timeout, no retries and no stored queue.</dd></div>
      <div><dt className="font-medium text-foreground">Your controls</dt><dd>Turn sharing off in Usage &amp; feedback to clear local IDs. To disable both usage and feedback requests, start OpenRod with <code>OPENROD_TELEMETRY=0</code>. Previously received events are not deleted.</dd></div>
    </dl>
  </>
}

function FeedbackForm({ canSend, onClose }) {
  const [comment, setComment] = React.useState('')
  const prefix = React.useId()
  const copy = () => { try { void navigator.clipboard.writeText(comment).catch(() => {}) } catch { /* optional */ } }
  function submit(event) {
    event.preventDefault()
    analytics.submitFeedback({ prompt: 'general', category: 'general', text: comment })
    onClose()
  }
  return <form onSubmit={submit} className="grid gap-4">
    <DialogHeader><DialogTitle>Give feedback</DialogTitle><DialogDescription>Feedback goes to PostHog. Please omit private details.</DialogDescription></DialogHeader>
    <div className="grid gap-1.5"><Label htmlFor={`${prefix}-text`}>Feedback</Label><Textarea id={`${prefix}-text`} value={comment} onChange={event => setComment(event.target.value)} maxLength={2000} rows={4} /></div>
    <div className="flex justify-end gap-2"><Button type="button" variant="ghost" size="sm" onClick={onClose}>Cancel</Button><Button type="button" variant="outline" size="sm" disabled={!comment.trim()} onClick={copy}>Copy text</Button><Button type="submit" size="sm" disabled={!canSend || !comment.trim()}>Send feedback</Button></div>
  </form>
}
