import * as React from 'react'
import { MessageSquare } from 'lucide-react'
import { analytics } from '@/lib/analytics'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { SidebarMenuButton } from '@/components/ui/sidebar'
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
      <DialogContent className={dialog === 'details' ? 'flex max-h-[calc(100dvh-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-lg' : 'sm:max-w-sm'}>
        {dialog === 'settings' ? <>
          <DialogHeader>
            <DialogTitle>Usage and feedback</DialogTitle>
            <DialogDescription>Share anonymous usage metrics with PostHog ({state.destination}) to improve OpenRod. No commands or project content.</DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-2 text-xs" role="status">
            <span className="text-muted-foreground">Usage sharing</span>
            <Badge variant={state.available && state.sharing ? 'secondary' : 'outline'}>{state.available && state.sharing ? 'On' : 'Off'}</Badge>
          </div>
          {state.available ? <div className="flex flex-wrap justify-end gap-2">
            <Button size="sm" variant="outline" onClick={() => chooseSharing(false)}>Turn sharing off</Button>
            <Button size="sm" className="bg-[var(--action)] text-[var(--action-foreground)] hover:bg-[var(--action)]/90" onClick={() => chooseSharing(true)}>Share anonymous usage</Button>
          </div> : <p className="text-xs text-muted-foreground">Usage sharing is disabled for this console.</p>}
          <div className="flex flex-wrap gap-2 border-t pt-3">
            <Button size="sm" variant="outline" onClick={() => setDialog('feedback')}>Give feedback</Button>
            <Button size="sm" variant="ghost" onClick={() => open('details')}>What is being shared?</Button>
          </div>
        </> : dialog === 'details' ? <UsageDetails destination={state.destination} onClose={() => setDialog(null)} /> : dialog === 'feedback' ? <FeedbackForm canSend={state.available} onClose={() => setDialog(null)} /> : null}
      </DialogContent>
    </Dialog>
  </UsageContext.Provider>
}

export function UsageButton() {
  const open = React.useContext(UsageContext)
  if (!open) return null
  return <SidebarMenuButton size="sm" className="text-muted-foreground" onClick={() => open()}><MessageSquare aria-hidden="true" />Usage &amp; feedback</SidebarMenuButton>
}

export function UsageNotice() {
  const open = React.useContext(UsageContext)
  const state = useUsageState()
  if (!open || !state.available || state.sharing !== null) return null
  return <div role="group" aria-label="Optional usage sharing" className="grid gap-2 border-t border-sidebar-border pt-3">
    <p className="text-xs leading-relaxed text-muted-foreground">Share anonymous metrics via PostHog.</p>
    <Button type="button" variant="outline" size="xs" className="w-full" onClick={() => analytics.setSharing(true)}>Share anonymous usage</Button>
    <div className="flex flex-wrap gap-1">
      <Button type="button" variant="outline" size="xs" onClick={() => analytics.setSharing(false)}>No thanks</Button>
      <Button type="button" variant="ghost" size="xs" className="text-muted-foreground" onClick={() => open('details')}>What is being shared?</Button>
    </div>
  </div>
}

function UsageDetails({ destination, onClose }) {
  return <>
    <DialogHeader className="shrink-0 border-b border-border px-5 py-4 pr-12">
      <DialogTitle>What is being shared?</DialogTitle>
      <DialogDescription className="text-xs">Usage metrics are sent only after you choose to share.</DialogDescription>
    </DialogHeader>
    <dl className="min-h-0 divide-y divide-border overflow-y-auto px-5 text-xs leading-relaxed [&>div]:py-3 [&_dd]:mt-1">
      <div><dt className="text-[10px] font-medium text-muted-foreground">Usage events</dt><dd>Screens opened, connection and sandbox actions, session launches, feature use, and structured success or error categories.</dd></div>
      <div><dt className="text-[10px] font-medium text-muted-foreground">Event metadata</dt><dd>App version, environment, timestamps, random browser and session IDs, predefined options, counts and durations. Sessions expire after 30 minutes of inactivity.</dd></div>
      <div><dt className="text-[10px] font-medium text-muted-foreground">Excluded content</dt><dd>No commands, terminal output, project content, resource names, hosts, paths, credentials, full URLs or raw errors. No session replay or automatic click tracking.</dd></div>
      <div><dt className="text-[10px] font-medium text-muted-foreground">Manual feedback</dt><dd>Only text you explicitly submit, up to 2,000 characters. You can send feedback with usage sharing off; please omit private details.</dd></div>
      <div><dt className="text-[10px] font-medium text-muted-foreground">Delivery</dt><dd>Sent directly to PostHog in the {destination}. PostHog receives network metadata such as your IP address; GeoIP enrichment and person profiles are disabled. Blocked or offline delivery fails silently, with a 3-second timeout, no retries and no stored queue.</dd></div>
      <div><dt className="text-[10px] font-medium text-muted-foreground">Your controls</dt><dd>Turn sharing off in Usage &amp; feedback to clear local IDs. To disable both usage and feedback requests, start OpenRod with <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px] text-foreground">OPENROD_TELEMETRY=0</code>. Previously received events are not deleted.</dd></div>
    </dl>
    <DialogFooter className="mx-0 mb-0 shrink-0 rounded-none px-5 py-3">
      <Button type="button" size="sm" variant="outline" onClick={onClose}>Done</Button>
    </DialogFooter>
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
    <div className="flex flex-wrap justify-end gap-2"><Button type="button" variant="ghost" size="sm" onClick={onClose}>Cancel</Button><Button type="button" variant="outline" size="sm" disabled={!comment.trim()} onClick={copy}>Copy text</Button><Button type="submit" size="sm" className="bg-[var(--action)] text-[var(--action-foreground)] hover:bg-[var(--action)]/90" disabled={!canSend || !comment.trim()}>Send feedback</Button></div>
  </form>
}
