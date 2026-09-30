// Keep the command in an AppleScript string, never in simulated keystrokes.
export function macTerminalScript(command) {
  const escaped = command.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r/g, '\\r').replace(/\n/g, '\\n')
  return `tell application "Terminal"
  do script "${escaped}"
  activate
end tell`
}

export function terminalLaunchError(error, stderr = '') {
  if (error.killed) return 'Terminal took too long to respond. Check the new window before trying again.'
  const detail = stderr.trim() || error.message
  if (detail.includes('-1743')) return 'macOS denied terminal automation. Allow the app running the console to control Terminal in System Settings → Privacy & Security → Automation.'
  return `Could not open Terminal: ${detail}`
}
