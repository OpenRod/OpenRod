// Shared by the Files tab, New sandbox and the server's file routes.

export const SANDBOX_ROOT = "/sandbox"
// One transfer, either way. The microVM disk is about 4 GB in total.
export const TRANSFER_LIMIT = 1024 ** 3

export function formatBytes(bytes) {
  if (bytes == null || !Number.isFinite(bytes)) return "-"
  if (bytes < 1024) return `${bytes} B`
  const units = ["KB", "MB", "GB", "TB"]
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++ }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

export function shellQuote(value) {
  return /^[\w@%+=:,./~-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`
}

// The same transfers from a terminal. A leading ~/ stays unquoted so the shell expands it.
const localArg = (local) => (local.startsWith("~/") ? `~/${shellQuote(local.slice(2))}` : shellQuote(local))
export const uploadCommand = (sandbox, local, dest = SANDBOX_ROOT) => `openshell sandbox upload ${shellQuote(sandbox)} ${localArg(local)} ${shellQuote(dest)}`
export const downloadCommand = (sandbox, remote, local = ".") => `openshell sandbox download ${shellQuote(sandbox)} ${shellQuote(remote)} ${localArg(local)}`
