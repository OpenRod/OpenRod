# Opening sandboxes

← [Back to README](../README.md)

A ready sandbox's **Open in** section offers:

- **Terminal**: opens your system terminal (macOS Terminal or Linux `x-terminal-emulator`). Under **Connection options**, **SSH shell** uses real OpenSSH through the gateway's authenticated relay with an owner-only temporary config, **New session** starts a separate shell or agent with `openshell sandbox exec --tty`, and **Attach** reconnects to the sandbox's running terminal when it has one.
- **VS Code** and **Cursor**: run `openshell sandbox connect <name> --editor …`, which adds OpenShell's managed SSH config (one `Include` line in `~/.ssh/config`) and opens the editor over Remote-SSH. The editor must be installed on your computer. **Cursor** is shown only when Cursor is one of the sandbox's agents, because Cursor's remote connection needs Cursor inside the sandbox. **VS Code** is shown on every sandbox. VS Code installs its version-matched server from inside the sandbox when it connects, so the first open allows that download for the sandbox: OpenRod adds the GET-only rule `tool-vscode-server` (`update.code.visualstudio.com` and `vscode.download.prss.microsoft.com`) and, if the sandbox has `wget`, makes it trust OpenShell's CA through `~/.wgetrc`. The download needs `curl` or `wget`, so a sandbox with neither is refused.
- **Browser**: an xterm.js session in a new tab, backed by the gateway's interactive exec rather than OpenSSH.

Commands and terminal tickets stay pinned to the sandbox's gateway and workspace; switching connections never retargets an open session.
