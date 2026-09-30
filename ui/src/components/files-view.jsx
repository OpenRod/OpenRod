import * as React from "react"
import { AlertTriangle, ChevronRight, Download, File, Folder, FolderGit2, Link2, RefreshCw, Upload, X } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Spinner } from "@/components/ui/spinner"
import { CopyCommand } from "@/components/copy-command"
import { api } from "@/lib/api"
import { relativeTime } from "@/lib/format"
import { projectOf } from "@/lib/sandbox-session"
import { SANDBOX_ROOT, TRANSFER_LIMIT, downloadCommand, formatBytes, uploadCommand } from "@/lib/files"

const RUNNING = new Set(["waiting", "uploading", "cloning"])
const join = (dir, name) => (dir === "/" ? `/${name}` : `${dir}/${name}`)
const isFolder = (entry) => entry.type === "dir" || entry.targetType === "dir"

// Dropped folders arrive as entries that have to be walked; the items must be
// read inside the drop event, before the browser clears them.
function droppedEntries(dataTransfer) {
  const entries = [...(dataTransfer.items ?? [])].map((item) => item.webkitGetAsEntry?.()).filter(Boolean)
  return entries.length ? entries : [...dataTransfer.files]
}

async function collect(dropped) {
  const out = []
  async function walk(entry, prefix) {
    if (entry instanceof window.File) { out.push({ path: entry.name, file: entry }); return }
    if (entry.isFile) {
      out.push({ path: prefix + entry.name, file: await new Promise((resolve, reject) => entry.file(resolve, reject)) })
    } else if (entry.isDirectory) {
      const reader = entry.createReader()
      for (;;) {
        const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject))
        if (!batch.length) break
        for (const child of batch) await walk(child, `${prefix}${entry.name}/`)
      }
    }
  }
  for (const entry of dropped) await walk(entry, "")
  return out
}

function SeedStatus({ seed, onRetry }) {
  if (!seed) return null
  const verb = seed.kind === "folder" ? "Uploading" : "Cloning"
  if (RUNNING.has(seed.state)) {
    return (
      <p className="flex items-center gap-2 border-b border-border bg-muted/30 px-5 py-2 text-xs">
        <Spinner aria-hidden="true" />
        {seed.state === "waiting" ? "Waiting for the sandbox to start, then " + verb.toLowerCase() : verb}
        <span className="min-w-0 truncate font-mono text-[11px]">{seed.source}</span>→<span className="font-mono text-[11px]">{seed.dest}</span>
      </p>
    )
  }
  if (seed.state === "failed") {
    return (
      <div role="alert" className="flex items-start gap-3 border-b border-red-200 bg-red-50/60 px-5 py-2.5 text-xs text-red-700">
        <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="font-medium">{seed.kind === "folder" ? "Upload" : "Clone"} of <span className="font-mono text-[11px]">{seed.source}</span> failed</p>
          <p className="mt-0.5 text-[11px]">{seed.error}</p>
        </div>
        <Button variant="outline" size="sm" onClick={onRetry} className="shrink-0">Retry</Button>
      </div>
    )
  }
  return (
    <p className="flex items-center gap-2 border-b border-border px-5 py-2 text-[11px] text-muted-foreground">
      <FolderGit2 className="size-3.5 shrink-0" aria-hidden="true" />
      Started from <span className="min-w-0 truncate font-mono">{seed.source}</span>
      {seed.files != null && <span>· {seed.files.toLocaleString()} files, {formatBytes(seed.bytes)}</span>}
      <span>→ <span className="font-mono">{seed.dest}</span></span>
    </p>
  )
}

export function FilesView({ sandbox, demo }) {
  const name = sandbox.name
  const ready = sandbox.phase === "ready"
  const project = projectOf(sandbox)
  const [dir, setDir] = React.useState(project ? `${SANDBOX_ROOT}/${project}` : SANDBOX_ROOT)
  const [listing, setListing] = React.useState(null)
  const [error, setError] = React.useState(null)
  const [loading, setLoading] = React.useState(false)
  const [seed, setSeed] = React.useState(null)
  const [dragging, setDragging] = React.useState(false)
  const [upload, setUpload] = React.useState(null)
  const [confirm, setConfirm] = React.useState(null)
  const [downloading, setDownloading] = React.useState(null)
  const inputRef = React.useRef(null)

  const load = React.useCallback(async (target) => {
    setLoading(true)
    try {
      const result = await api.files(name, target)
      setListing(result); setError(null)
      if (result.path !== target) setDir(result.path)
    } catch (e) {
      // The project folder may not exist yet (still uploading) or was removed.
      if (target !== SANDBOX_ROOT && /does not exist/.test(e.message)) { setDir(SANDBOX_ROOT); return }
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [name])

  React.useEffect(() => { if (ready && !demo) load(dir) }, [dir, ready, demo, load])

  // A sandbox started with files reports the upload or clone here until it settles.
  const seedState = seed?.state
  React.useEffect(() => {
    if (demo) return
    let cancelled = false
    let timer
    const poll = async () => {
      try {
        const next = await api.seed(name)
        if (cancelled) return
        setSeed(next)
        if (next && RUNNING.has(next.state)) timer = setTimeout(poll, 2000)
      } catch { /* The files list still works without it. */ }
    }
    if (!seed || RUNNING.has(seedState)) poll()
    return () => { cancelled = true; clearTimeout(timer) }
  }, [name, demo, seedState]) // eslint-disable-line react-hooks/exhaustive-deps

  // Once files land, show them: open the project folder, or re-read this one.
  const previousSeed = React.useRef(null)
  React.useEffect(() => {
    if (RUNNING.has(previousSeed.current) && seedState === "done" && ready) {
      const target = project ? `${SANDBOX_ROOT}/${project}` : dir
      if (target !== dir) setDir(target)
      else load(dir)
    }
    previousSeed.current = seedState
  }, [seedState]) // eslint-disable-line react-hooks/exhaustive-deps

  async function retry() {
    try { setSeed(await api.retrySeed(name)) } catch (e) { toast.error(e.message) }
  }

  async function download(target, label) {
    setDownloading(target)
    const id = toast.loading(`Preparing ${label}…`)
    try {
      const { token, filename, bytes } = await api.prepareDownload(name, target)
      const link = document.createElement("a")
      link.href = `/api/os/downloads/${token}`
      link.download = filename
      document.body.append(link); link.click(); link.remove()
      toast.success(`Downloading ${filename}`, { id, description: formatBytes(bytes) })
    } catch (e) {
      toast.error(e.message, { id })
    } finally {
      setDownloading(null)
    }
  }

  function plan(files) {
    if (!files.length) { toast.error("Nothing to upload. Empty folders are skipped."); return }
    const bytes = files.reduce((sum, item) => sum + item.file.size, 0)
    if (bytes > TRANSFER_LIMIT) { toast.error(`That is ${formatBytes(bytes)}; the console uploads up to ${formatBytes(TRANSFER_LIMIT)}.`, { description: `From a terminal: ${uploadCommand(name, "./my-files", dir)}` }); return }
    if (listing && bytes > listing.free) { toast.error(`The sandbox has ${formatBytes(listing.free)} free; this is ${formatBytes(bytes)}.`); return }
    const top = [...new Set(files.map((item) => item.path.split("/")[0]))]
    const taken = top.filter((entry) => listing?.entries.some((e) => e.name === entry))
    const next = { files, bytes, dir, taken }
    if (taken.length) setConfirm(next)
    else send(next)
  }

  async function send({ files, bytes, dir: target }) {
    setConfirm(null)
    const controller = new AbortController()
    let id
    setUpload({ done: 0, total: files.length, sent: 0, bytes, committing: false, controller })
    try {
      ({ id } = await api.startUpload(name))
      let next = 0
      // A few files at a time: enough to keep the local server busy.
      await Promise.all(Array.from({ length: Math.min(4, files.length) }, async () => {
        while (next < files.length && !controller.signal.aborted) {
          const item = files[next++]
          try {
            await api.uploadFile(name, id, item.path, item.file, controller.signal)
          } catch (e) { controller.abort(); throw e }
          setUpload((u) => u && { ...u, done: u.done + 1, sent: u.sent + item.file.size })
        }
      }))
      setUpload((u) => u && { ...u, committing: true })
      const result = await api.commitUpload(name, id, target)
      toast.success(`Uploaded ${result.files.toLocaleString()} ${result.files === 1 ? "file" : "files"} to ${result.dest}`, { description: formatBytes(result.bytes) })
      if (target === dir) load(dir)
    } catch (e) {
      if (id) api.cancelUpload(name, id).catch(() => {})
      toast.error(controller.signal.aborted && e.name === "AbortError" ? "Upload cancelled." : e.message)
    } finally {
      setUpload(null)
    }
  }

  async function onDrop(event) {
    event.preventDefault()
    setDragging(false)
    if (!ready || upload) return
    const dropped = droppedEntries(event.dataTransfer)
    try { plan(await collect(dropped)) } catch (e) { toast.error(`Could not read the dropped files: ${e.message}`) }
  }

  if (demo) return <p className="p-5 text-sm text-muted-foreground">Files are unavailable for synthetic sandboxes.</p>

  const crumbs = dir.split("/").filter(Boolean).map((part, i, all) => ({ label: part, path: `/${all.slice(0, i + 1).join("/")}` }))
  const entries = listing?.path === dir ? listing.entries : []

  return (
    <div className="relative flex min-h-0 flex-1 flex-col"
      onDragOver={(event) => { if (ready && !upload && Array.from(event.dataTransfer.types).includes("Files")) { event.preventDefault(); setDragging(true) } }}
      onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setDragging(false) }}
      onDrop={onDrop}>
      <SeedStatus seed={seed} onRetry={retry} />

      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-5 py-2">
        <nav aria-label="Folder" className="flex min-w-0 flex-1 items-center gap-0.5 font-mono text-[11px]">
          {crumbs.map((crumb, i) => (
            <React.Fragment key={crumb.path}>
              {i > 0 && <ChevronRight className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />}
              {i === crumbs.length - 1
                ? <span className="truncate px-1 text-foreground" aria-current="page">{crumb.label}</span>
                : <button type="button" onClick={() => setDir(crumb.path)} className="truncate rounded px-1 text-muted-foreground hover:bg-muted hover:text-foreground">{crumb.label}</button>}
            </React.Fragment>
          ))}
        </nav>
        {listing && <span className="text-[11px] text-muted-foreground">{formatBytes(listing.free)} free</span>}
        <Button variant="ghost" size="icon-sm" aria-label="Refresh" disabled={!ready || loading} onClick={() => load(dir)}>
          <RefreshCw className={loading ? "animate-spin" : undefined} aria-hidden="true" />
        </Button>
        <Button variant="outline" size="sm" disabled={!ready || Boolean(downloading)} onClick={() => download(dir, `${dir.split("/").pop()}.tar.gz`)}>
          {downloading === dir ? <Spinner aria-hidden="true" /> : <Download aria-hidden="true" />}Download folder
        </Button>
        <Button variant="outline" size="sm" disabled={!ready || Boolean(upload)} onClick={() => inputRef.current?.click()}>
          <Upload aria-hidden="true" />Upload
        </Button>
        <input ref={inputRef} type="file" multiple hidden
          onChange={(event) => { const files = [...event.target.files].map((file) => ({ path: file.name, file })); event.target.value = ""; plan(files) }} />
      </div>

      {upload && (
        <div className="flex shrink-0 items-center gap-3 border-b border-border bg-muted/30 px-5 py-2 text-xs" role="status">
          <Spinner aria-hidden="true" />
          <span className="flex-1">
            {upload.committing
              ? `Sending ${upload.total.toLocaleString()} ${upload.total === 1 ? "file" : "files"} to ${dir}…`
              : `Reading ${upload.done.toLocaleString()} of ${upload.total.toLocaleString()} files · ${formatBytes(upload.sent)} of ${formatBytes(upload.bytes)}`}
          </span>
          {!upload.committing && <Button variant="ghost" size="sm" onClick={() => upload.controller.abort()}><X aria-hidden="true" />Cancel</Button>}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {!ready ? (
          <p className="p-5 text-sm text-muted-foreground">Start the sandbox to browse its files.</p>
        ) : error ? (
          <p role="alert" className="p-5 text-sm text-destructive">{error}</p>
        ) : !listing ? (
          <p className="p-5 text-sm text-muted-foreground">Loading files…</p>
        ) : (
          <ul aria-label={`Files in ${dir}`} className="divide-y divide-border/60">
            {dir !== SANDBOX_ROOT && (
              <li><button type="button" onClick={() => setDir(dir.slice(0, dir.lastIndexOf("/")) || "/")} className="flex w-full items-center gap-2 px-5 py-1.5 text-left font-mono text-xs text-muted-foreground hover:bg-muted/50">
                <Folder className="size-3.5" aria-hidden="true" />..
              </button></li>
            )}
            {entries.map((entry) => {
              const path = join(dir, entry.name)
              const Icon = entry.type === "link" ? Link2 : isFolder(entry) ? Folder : File
              const label = (
                <>
                  <Icon className={`size-3.5 shrink-0 ${isFolder(entry) ? "text-sky-600" : "text-muted-foreground"}`} aria-hidden="true" />
                  <span className="truncate">{entry.name}</span>
                  {entry.target && <span className="truncate text-muted-foreground">→ {entry.target}</span>}
                </>
              )
              return (
                <li key={entry.name} className="group flex items-center gap-3 px-5 py-1 hover:bg-muted/50">
                  {isFolder(entry)
                    ? <button type="button" onClick={() => setDir(path)} className="flex min-w-0 flex-1 items-center gap-2 py-0.5 text-left font-mono text-xs">{label}</button>
                    : <span className="flex min-w-0 flex-1 items-center gap-2 py-0.5 font-mono text-xs">{label}</span>}
                  <span className="w-16 shrink-0 text-right text-[11px] text-muted-foreground">{entry.size != null ? formatBytes(entry.size) : ""}</span>
                  <span className="hidden w-16 shrink-0 text-right text-[11px] text-muted-foreground sm:block" title={entry.modifiedAt}>{relativeTime(entry.modifiedAt)}</span>
                  <Button variant="ghost" size="icon-sm" aria-label={`Download ${entry.name}`} className="opacity-60 group-hover:opacity-100"
                    disabled={Boolean(downloading) || entry.targetType === "missing"} onClick={() => download(path, isFolder(entry) ? `${entry.name}.tar.gz` : entry.name)}>
                    {downloading === path ? <Spinner aria-hidden="true" /> : <Download aria-hidden="true" />}
                  </Button>
                </li>
              )
            })}
            {!entries.length && <li className="px-5 py-3 text-xs text-muted-foreground">This folder is empty. Drop files here to upload them.</li>}
            {listing.truncated && <li className="px-5 py-2 text-[11px] text-muted-foreground">Showing the first {entries.length.toLocaleString()} entries.</li>}
          </ul>
        )}
      </div>

      <div className="shrink-0 space-y-1.5 border-t border-border bg-muted/20 px-5 py-3">
        <p className="text-[11px] text-muted-foreground">Drop files or folders anywhere here to upload into this folder. Only /sandbox is reachable; symlinks stay links. From a terminal:</p>
        <div className="grid gap-1.5 lg:grid-cols-2">
          <CopyCommand command={uploadCommand(name, "./my-files", dir)} />
          <CopyCommand command={downloadCommand(name, dir, ".")} />
        </div>
      </div>

      {dragging && (
        <div className="pointer-events-none absolute inset-2 flex items-center justify-center rounded-lg border-2 border-dashed border-sky-500 bg-background/85 text-sm">
          Drop to upload into <span className="ml-1 font-mono">{dir}</span>
        </div>
      )}

      <AlertDialog open={Boolean(confirm)} onOpenChange={(open) => { if (!open) setConfirm(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Replace {confirm?.taken.length === 1 ? `“${confirm.taken[0]}”` : `${confirm?.taken.length} items`}?</AlertDialogTitle>
            <AlertDialogDescription>
              {confirm?.taken.length > 1 && <span className="mb-2 block font-mono text-[11px]">{confirm.taken.slice(0, 6).join(", ")}{confirm.taken.length > 6 ? ", …" : ""}</span>}
              Files with the same name in {confirm?.dir} are replaced. Folders are merged: matching files inside are replaced, and nothing is deleted.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => send(confirm)}>Replace</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
