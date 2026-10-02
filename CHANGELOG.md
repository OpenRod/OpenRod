# Changelog

All notable changes to OpenRod are documented here. The project follows [Semantic Versioning](https://semver.org/).

## 0.1.0 - initial public release

First public release of OpenRod, a local web console for NVIDIA OpenShell 0.1.2.

### Console and CLI

- `openrod` command that serves the built console on loopback only (default `127.0.0.1:4600`), with `--port`, `--host`, `--open` and `--no-open`.
- Per-launch token: every start prints a one-time `?token=` link that sets an HttpOnly cookie; every API request, event stream and terminal WebSocket requires it, in addition to peer address, Host, Origin and same-origin mutation checks.
- Gateway mTLS credentials and provider secrets stay in the server; the browser never receives them. Uses the existing OpenShell CLI registration and never reconfigures the local gateway.

### Sandboxes and templates

- Virtualized sandbox inventory with status counts, search, filters, owner and uptime, and a detail popup with access graph, rules, activity, files and lifecycle actions.
- New sandbox dialog with location choice, create-time policies, groups, providers, ingress, and a local folder or public git repository to start with.
- Open a ready sandbox in a browser terminal, your system terminal (SSH shell, new session, or attach), VS Code, or Cursor when Cursor is one of the sandbox's agents.
- Image template builder: pick agents (Claude Code, Codex, OpenCode, Gemini CLI, Pi, Cursor, Antigravity, Copilot, Kiro, Factory Droid, Aider), a runtime, packages and setup commands, then build with local Docker; or wrap an existing image.
- Files tab to browse, download and upload sandbox files; installed-agent detection inside ready sandboxes.

### Policy and network

- Reusable egress rules (allow or block) for groups, specific sandboxes or every sandbox, with organization-wide blocked hosts.
- Groups of sandboxes that share network access, approvals for blocked requests, ingress services with auto-close timers, and secrets with destination-bound injection.

### MCPs & Skills Setups

- Import MCP servers and Skills from local Codex, Claude Code and Cursor configuration, with secret exclusion and review.
- Prepare npm-based MCPs in disposable sandboxes, bake pinned snapshots into image templates, and install them for nine destination agents.
- Each Setup gets a managed "MCPs & Skills: <name>" egress policy for the sandboxes that use it.

### Activity

- Background collection of gateway logs and platform events into a local SQLite archive, with search, investigation pivots, saved views, JSON export, webhook delivery and reviewed deletion.

### Remote SSH hosts

- Connect a Linux Docker host over SSH and run a persistent second OpenShell gateway there, with automatic or offline runtime installation and opt-in Docker installation on Ubuntu/Debian.
- Combined local and remote inventories with per-resource routing, versioned import of local policies, groups and Setups, and tmux-backed terminals that survive disconnects and laptop sleep.
