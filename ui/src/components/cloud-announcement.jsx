import * as React from 'react'
import { X } from 'lucide-react'
import confetti from 'canvas-confetti'
import { Button } from '@/components/ui/button'

const DISMISSED_KEY = 'openrod:cloud-announcement:v1:dismissed'
let announcementRequest
let dismissedThisVisit = false

function claimAnnouncement() {
  // Share the request across StrictMode effects and page remounts.
  announcementRequest ??= fetch('/api/os/announcements/cloud', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-openshell-console': '1' },
    body: '{}',
  }).then(response => response.ok ? response.json() : { show: false }).catch(() => ({ show: false }))
  return announcementRequest
}

export function CloudAnnouncement() {
  const [dismissed, setDismissed] = React.useState(true)
  const canvasRef = React.useRef(null)

  React.useEffect(() => {
    if (import.meta.env.DEV && new URLSearchParams(window.location.search).get('preview') === 'cloud-announcement') {
      setDismissed(false)
      return
    }
    let active = true
    claimAnnouncement().then(({ show }) => {
      let previouslyDismissed = dismissedThisVisit
      try { previouslyDismissed ||= localStorage.getItem(DISMISSED_KEY) === 'true' } catch {}
      if (active) setDismissed(!show || previouslyDismissed)
    })
    return () => { active = false }
  }, [])

  // Magic UI's scoped canvas pattern keeps the celebration inside the banner.
  React.useEffect(() => {
    if (dismissed || !canvasRef.current) return
    const celebration = confetti.create(canvasRef.current, { resize: true })
    const options = {
      particleCount: 35, spread: 75, startVelocity: 16, gravity: 0.45,
      ticks: 160, scalar: 0.65, disableForReducedMotion: true,
      colors: ['#4c88df', '#e6b75a', '#95bde0', '#c0a3e8'],
    }
    celebration({ ...options, angle: 65, origin: { x: 0.1, y: 1 } })
    celebration({ ...options, angle: 115, origin: { x: 0.9, y: 1 } })
    return () => celebration.reset()
  }, [dismissed])

  function dismiss() {
    dismissedThisVisit = true
    setDismissed(true)
    try { localStorage.setItem(DISMISSED_KEY, 'true') } catch { /* Still dismiss for this visit. */ }
  }

  if (dismissed) return null

  return (
    <section aria-label="OpenRod Cloud announcement" className="sticky top-0 z-20 flex min-h-12 shrink-0 items-center justify-center overflow-hidden border-b border-blue-900/10 bg-[#e4eeff] py-2 pl-4 pr-12 text-[#234c88] dark:border-blue-200/10 dark:bg-[#1c3050] dark:text-[#d5e5ff]">
      <canvas ref={canvasRef} aria-hidden="true" className="pointer-events-none absolute inset-0 size-full" />
      <div className="relative flex items-center gap-2.5 text-[13px] leading-5">
        <img src="/openrod.png" alt="OpenRod" className="size-7 shrink-0 object-contain" />
        <p><span className="opacity-75">New in OpenRod:</span>{' '}<strong className="font-semibold">Meet OpenRod Cloud!</strong></p>
      </div>
      <Button variant="ghost" size="icon-sm" onClick={dismiss} aria-label="Dismiss OpenRod Cloud announcement" className="absolute right-2 top-1/2 -translate-y-1/2 text-current hover:bg-blue-950/10 hover:text-current dark:hover:bg-white/10 focus-visible:ring-blue-600">
        <X aria-hidden="true" className="size-3.5" />
      </Button>
    </section>
  )
}
