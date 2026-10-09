# Changelog

All notable changes to OpenRod are documented here. The project follows [Semantic Versioning](https://semver.org/).

## 0.2.0-rc.4

### Added

- Count explicit usage-sharing declines with one anonymous PostHog event, without saving an identity or collecting location. Closing the prompt sends nothing.

## 0.2.0

### Added

- OpenRod Cloud is available at `https://console.openrod.io`. Connect your Google account from local OpenRod and prepare a dedicated cloud machine to use cloud sandboxes, files, terminals and imports.

### Changed

- Local OpenRod connects to the hosted cloud by default, without requiring `OPENROD_CLOUD_ORIGIN`. Set it to another HTTPS origin to use your own deployment, or leave it explicitly empty to disable Cloud.
- Cloud provisioning shows an active setup indicator, explains that high demand can extend the wait, and says the workspace opens automatically when ready.
- Cloud sign-in and machine setup show the OpenRod Cloud animation with rotating agents, note that high demand can slow them down, and have shorter wait and error messages.

## 0.1.3

### Added

- Optional usage sharing. On first opening, OpenRod asks whether to share usage metrics with PostHog; nothing is sent unless you agree, and never commands, files or names. **Usage & feedback** in the sidebar changes the choice and sends feedback. `OPENROD_TELEMETRY=0` or `DO_NOT_TRACK=1` turns it all off.
- Configuration imports preview groups, network policies, saved MCPs and skills, and template recipes before copying them to another location. Source organization blocks follow imported groups; credential values stay excluded. Persistent jobs report partial results and support cancellation and retries.
- Activity history can be imported separately in bounded batches, retaining source identity and timestamps without copying raw payloads.
- Groundwork for OpenRod Cloud. It isn't available yet, so cloud entry points still say "Coming soon".

### Changed

- Resource pages show Local and Remote resources together. Network, Secrets, Templates, MCPs & Skills, and Activity identify each row's source with consistent chips; Groups retains each resource's source when editing membership or rules.
- Creation and setup import choose a destination explicitly. Edits, deletions, activity pagination, and exports keep their original source, including when resource names or IDs match across machines.
- New Codex sandboxes no longer reach your ChatGPT connectors or hosted plugins unless you turn them on when creating the sandbox; existing sandboxes keep their access. Claude Code sandboxes can turn on your claude.ai connectors the same way.

### Fixed

- Adding a secret to a selected location no longer crashes while credentials are loading.
- A disconnected SSH location no longer blocks Local resource pages or imports, and retained remote inventory no longer requires a persistent banner.
- Reconnecting an SSH location selects the requested host instead of falling back to another configured host.
- Forgetting a remote connection removes its host from the Connections list across restarts; forgotten hosts can be restored explicitly.

## 0.1.2

### Added

- `npx openrod` offers to install OpenShell 0.1.2 when it's missing. It runs the official installer for that release after checking its checksum. On macOS it also installs e2fsprogs and, on a fresh setup, runs sandboxes in OpenShell's VM driver, which works with Docker Desktop's default settings. Without a terminal, it prints the install command.
- The setup screen shows the install command when OpenShell isn't installed.

### Changed

- `npx openrod` opens the console in your browser, so `--open` is no longer needed. Over SSH, in CI, without a display, or when the output isn't a terminal, it only prints the link. `--no-open` always only prints it. The browser it opens gets a one-time code instead of the secret token, so the token never appears in another process's arguments; if that code is used twice, OpenRod warns in the terminal.
- **Add secret** lists only services whose keys the gateway can inject: Claude Code, Codex, Copilot, OpenAI, OpenRouter and GitHub. Secrets already saved for other services keep working.

### Fixed

- On macOS, OpenRod connects OpenShell to the Docker it builds images with, so sandboxes from templates start even when Docker Desktop’s default socket is off.
- A fresh console connects to the local gateway OpenShell is set to, as **Use this computer** would, once it answers. The sidebar no longer says "Not connected" while sandboxes work, and the browser opens after the connection.
- The install prompt asks again when the answer is neither yes nor no, for example a key typed in another keyboard layout.
- New sandbox keeps a name you typed while its defaults are still loading.
- Ingress shows gateway errors with a **Retry** button instead of "No sandboxes yet."

## 0.1.1

### Added

- The New template screen now matches New sandbox.
- Creating a template on an SSH host offers your local MCPs & Skills, as sandbox creation does.
- **Need a VM? Copy agent prompt** in Add SSH connection copies a prompt for your AI agent to create a VM that meets the SSH host requirements.

### Fixed

- First run: Network rules, Groups and Secrets no longer need a sandbox first. The setup screen has a **Use this computer** button that connects the local gateway directly, and a failed connection is shown instead of a silent reload.
- Creating a sandbox no longer requires a group or a network rule. A sandbox without rules starts locked down.
- Docker is listed as a requirement, and Docker problems are reported in one clear sentence instead of a raw `docker info` dump.
- The redundant **VS Code Server** tool choice is gone: Open in VS Code prepares any sandbox. Templates saved with it keep working.
- The `openrod` command explains when Node.js is older than 22.13, and no longer prints the SQLite experimental warning on start.

### Changed

- Firebase is no longer a dependency, so installs are about 3× smaller (115 packages instead of 298) with no audit warnings. Cloud mode returns in a later release.

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
- Groups of sandboxes that share network access, policy-only egress (requests no rule allows are blocked and pending proposals are auto-rejected), ingress services with auto-close timers, and secrets with destination-bound injection.

### MCPs & Skills Setups

- Import MCP servers and Skills from local Codex, Claude Code and Cursor configuration, with secret exclusion and review.
- Prepare npm-based MCPs in disposable sandboxes, bake pinned snapshots into image templates, and install them for nine destination agents.
- Each Setup gets a managed "MCPs & Skills: <name>" egress policy for the sandboxes that use it.

### Activity

- Background collection of gateway logs and platform events into a local SQLite archive, with search, investigation pivots, saved views, JSON export, webhook delivery and reviewed deletion.

### Remote SSH hosts

- Connect a Linux Docker host over SSH and run a persistent second OpenShell gateway there, with automatic or offline runtime installation and opt-in Docker installation on Ubuntu/Debian.
- Combined local and remote inventories with per-resource routing, versioned import of local policies, groups and Setups, and tmux-backed terminals that survive disconnects and laptop sleep.
