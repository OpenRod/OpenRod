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
  const open = React.useCallback(() => setDialog('settings'), [])
  function chooseSharing(value) {
    analytics.setSharing(value)
    setDialog(null)
  }
  return <UsageContext.Provider value={open}>
    {children}
    <Dialog open={Boolean(dialog)} onOpenChange={value => { if (!value) setDialog(null) }}>
      <DialogContent className="sm:max-w-sm">
        {dialog === 'settings' ? <>
          <DialogHeader>
            <DialogTitle>Usage and feedback</DialogTitle>
            <DialogDescription>Share anonymous usage metrics with PostHog ({state.destination}) to improve OpenRod. No commands or project content.</DialogDescription>
          </DialogHeader>
          <p className="text-xs font-medium" role="status">Usage sharing: {state.available && state.sharing ? 'On' : 'Off'}</p>
          {state.available ? <div className="flex justify-end gap-2">
            <Button size="sm" variant="outline" onClick={() => chooseSharing(false)}>Turn sharing off</Button>
            <Button size="sm" onClick={() => chooseSharing(true)}>Share usage</Button>
          </div> : <p className="text-xs text-muted-foreground">Usage sharing is disabled for this console.</p>}
          <div className="border-t pt-3">
            <Button size="sm" variant="outline" onClick={() => setDialog('feedback')}>Give feedback</Button>
          </div>
        </> : dialog === 'feedback' ? <FeedbackForm canSend={state.available} onClose={() => setDialog(null)} /> : null}
      </DialogContent>
    </Dialog>
  </UsageContext.Provider>
}

export function UsageButton() {
  const open = React.useContext(UsageContext)
  if (!open) return null
  return <Button variant="ghost" size="xs" className="justify-start text-xs text-muted-foreground" onClick={open}><MessageSquare className="size-3" aria-hidden="true" />Usage &amp; feedback</Button>
}

export function UsageNotice() {
  const open = React.useContext(UsageContext)
  const state = useUsageState()
  if (!open || !state.available || state.sharing !== null) return null
  return <div role="group" aria-label="Optional usage sharing" className="pt-1 text-[11px] leading-relaxed text-muted-foreground">
    <p>Share anonymous metrics via PostHog.</p>
    <div className="-ml-1.5 flex gap-1">
      <Button type="button" variant="ghost" size="xs" className="px-1.5 text-[11px] font-normal" onClick={() => analytics.setSharing(true)}>Allow</Button>
      <Button type="button" variant="ghost" size="xs" className="px-1.5 text-[11px] font-normal" onClick={() => analytics.setSharing(false)}>No thanks</Button>
    </div>
  </div>
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
