// Keep the command in an AppleScript string, never in simulated keystrokes.
export function macTerminalScript(command) {
  const escaped = command.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r/g, '\\r').replace(/\n/g, '\\n')
  return `tell application "Terminal"
  if (count of windows) is 0 then
    do script "${escaped}"
    activate
    return
  end if
  -- Native tab groups can expose the new tab through a different window.
  -- Snapshot terminal device strings across all windows before requesting it.
  set oldTTYs to {}
  repeat with terminalWindow in windows
    repeat with terminalTab in tabs of terminalWindow
      set end of oldTTYs to (tty of terminalTab) as text
    end repeat
  end repeat
  set miniaturized of front window to false
  activate
end tell
tell application "System Events" to tell process "Terminal"
  set frontmost to true
  repeat 30 times
    if frontmost then exit repeat
    delay 0.1
  end repeat
  if not frontmost then error "Terminal could not be brought to the front."
end tell
delay 0.2
tell application "System Events" to tell process "Terminal" to key code 17 using command down
repeat 80 times
  tell application "Terminal"
    repeat with terminalWindow in windows
      repeat with candidate in tabs of terminalWindow
        set candidateTTY to (tty of candidate) as text
        if candidateTTY is not "" and candidateTTY is not in oldTTYs then
          do script "${escaped}" in candidate
          return
        end if
      end repeat
    end repeat
  end tell
  delay 0.1
end repeat
-- The shortcut may have succeeded even if discovery times out. Never open
-- another session as a fallback after asking Terminal for a tab.
error "Could not identify the requested Terminal tab. No additional window was opened."`
}

// Concurrent requests must not discover and attach to each other's new tabs.
export function createTerminalQueue() {
  let pending = Promise.resolve()
  return (launch) => {
    const result = pending.then(launch)
    pending = result.catch(() => {})
    return result
  }
}

export function terminalLaunchError(error, stderr = '') {
  if (error.killed) return 'Terminal took too long to respond. Check the new tab before trying again.'
  const detail = stderr.trim() || error.message
  if (detail.includes('-1743')) return 'macOS denied terminal automation. Allow the app running the console to control Terminal and System Events in System Settings → Privacy & Security → Automation.'
  if (detail.includes('-1719') || /not allowed to send keystrokes|assistive access/i.test(detail)) return 'macOS denied creating a Terminal tab. Enable Accessibility for the app running the console in System Settings → Privacy & Security → Accessibility.'
  return `Could not open Terminal: ${detail}`
}
