# OpenRod

[![CI](https://github.com/OpenRod/OpenRod/actions/workflows/ci.yml/badge.svg)](https://github.com/OpenRod/OpenRod/actions/workflows/ci.yml) [![npm](https://img.shields.io/npm/v/openrod)](https://www.npmjs.com/package/openrod) [![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

OpenRod is an open-source web console for [NVIDIA OpenShell](https://github.com/NVIDIA/OpenShell). It runs on your own computer, talks to your OpenShell gateway with the gateway's mTLS credentials held server-side, and gives you one place to create and manage sandboxes and image templates, open agent sessions in the browser or your terminal, edit network and egress policy, bring your MCP servers and Skills into sandboxes, and review sandbox activity. It can also run a second, persistent gateway on a Linux machine you reach over SSH, so long-running agent work continues while your laptop sleeps.

OpenRod is an independent community project. It is **not affiliated with, endorsed by, or supported by NVIDIA**. "NVIDIA" and "OpenShell" are used only to describe compatibility.

## Prerequisites

- **Node.js 22.13 or newer** (with npm). The activity archive uses Node's built-in SQLite.
- **macOS (Apple Silicon) or Linux.** Native terminal launch supports macOS Terminal and Linux `x-terminal-emulator`.
- **OpenShell 0.1.2**: the `openshell` CLI and a local gateway registered with it. OpenRod is built against the OpenShell 0.1.2 SDK; other releases may not be compatible.
- **OpenSSH and OpenSSL** on your computer, for native SSH sessions and remote hosts.
- Optional, for remote work: an SSH host as described in [Remote SSH hosts](#remote-ssh-hosts).

## Quick start

### 1. Install OpenShell and its local gateway

Follow NVIDIA's [OpenShell installation guide](https://docs.nvidia.com/openshell/latest/about/installation) and [support matrix](https://docs.nvidia.com/openshell/latest/about/support-matrix). The upstream installer sets up the CLI and a local gateway, and registers that gateway with the CLI. Pin the release OpenRod supports:

```bash
curl -LsSf https://raw.githubusercontent.com/NVIDIA/OpenShell/main/install.sh | OPENSHELL_VERSION=v0.1.2 sh
openshell sandbox create --name demo   # optional: confirms the gateway works
```

Gateway registrations live in `~/.config/openshell/gateways/<name>/` (or `$XDG_CONFIG_HOME/openshell/...`). OpenRod reads them from there; you never paste keys into the browser. Only HTTPS/mTLS registrations are supported. If `openshell` is not on your `PATH`, set `OPENSHELL_BIN` to its full path.

### 2. Run OpenRod

```bash
npx openrod --open
```

or install it globally:

```bash
npm install -g openrod
openrod --open
```

Options:

```text
--port <number>  HTTP port from 1 to 65535 (default: 4600)
--host <host>    Loopback only: 127.0.0.1 (default), localhost, or ::1
--open           Open the console in your default browser
--no-open        Do not open a browser (default)
--help, -h       Show help
--version, -v    Show the installed version
```

### 3. Open the link it prints

Every start generates a new random secret and prints:

```text
OpenRod console (open this link): http://127.0.0.1:4600/?token=<secret>
```

Open that exact link (`--open` does it for you). The page stores the secret in an HttpOnly cookie for that port and reloads without the token in the address bar, so a bookmark of `http://127.0.0.1:4600/` keeps working until the console restarts. After a restart, or in another browser or profile, the page asks you to *open the link printed in your terminal*: copy the new link from the terminal where OpenRod is running. Treat the link like a password; anyone who has it while OpenRod runs can use your gateway credentials.

### 4. Connect your gateway

On **Sandboxes**, click **New sandbox**. In **Where should it run?**, choose **This computer**; it shows the name of your registered local gateway (or *No local gateway running* if OpenRod cannot find one). OpenRod connects it, picks an accessible workspace (your previous one, otherwise `default`), saves the selection in `~/.config/openshell/console-context.json` (separately from the CLI's active gateway) and starts collecting activity. A fresh console never connects or collects on its own.

From here, **New sandbox** creates a sandbox, and a ready sandbox can be opened in the browser terminal, in your own terminal over SSH, or in VS Code (when **VS Code Server** was chosen at creation) and Cursor (when Cursor is one of the sandbox's agents).

## Remote SSH hosts

**New sandbox → Where should it run? → Remote machine** connects a Linux machine you reach over SSH. OpenRod runs a **persistent second OpenShell gateway** in Docker on that host, and shows its sandboxes and templates alongside your local ones. Your existing local gateway is never reconfigured.

Requirements:

- A concrete `Host` alias in `~/.ssh/config` (aliases in `Include` files are discovered too; wildcard patterns are not selectable) with trusted key-based access. SSH uses your configuration, keys, agent and jump hosts, with strict host-key verification; OpenRod never accepts unknown host keys or prompts for passwords.
- A native **Linux amd64/arm64 host with a running rootful Docker Engine** whose socket the SSH user can use without an interactive sudo prompt, plus Python 3. Docker Desktop, rootless Docker, and Docker contexts pointing at another machine are not supported. Docker socket access is effectively root on that host.
- An `openshell-gateway` 0.1.2 executable locally. If none is installed, OpenRod downloads the pinned [official release](https://github.com/NVIDIA/OpenShell/releases/tag/v0.1.2) for Apple Silicon macOS or arm64/x64 Linux, verifies its SHA-256 digest, and installs it under its private data directory (requires `tar`, no sudo).

Steps:

1. Click **New sandbox**, choose **Remote machine**, and pick an SSH alias. Listing hosts does not open SSH connections or install anything.
2. Click **Connect**. The host does not need OpenShell installed: OpenRod reuses matching runtime images and, if they are missing, offers **Download on host** or **Upload** of an offline `docker save` package (see below). If Docker itself is absent on Ubuntu or Debian with systemd, connection pauses for **Install Docker and continue** approval: this needs root or passwordless sudo, installs the distribution `docker.io` package, enables its service, and adds the SSH user to the root-equivalent `docker` group. Existing or broken Docker installations are never replaced or repaired; other distributions need manual setup. A failed installation can leave package, service, or group changes behind.
3. Once ready, **Sandboxes** and **Templates** show both locations, marked **Local** or **SSH · host-alias**. **New sandbox** chooses its location explicitly; **Use template** inherits the template's location. **Disconnect** in the sidebar closes the local SSH tunnels.

The remote gateway has its own database, certificates, providers and sandbox inventory. It runs with `--restart unless-stopped`, binds to remote loopback, and is reached only through SSH forwarding. Only one remote host is connected at a time. When a sandbox is created on the SSH host, your local network-policy templates, egress rules, MCPs & Skills, and Groups are offered as versioned snapshots; secret values, local sandbox memberships and sandbox-specific grants are not copied. **Build an image** for an SSH host builds with Docker on your computer for the host's architecture and loads the result over the SSH tunnel, so local Docker is needed only for image builds and upload packages.

### Uploading a runtime package

Use a trusted, uncompressed `docker save` archive containing the sandbox, supervisor, and gateway images for the version and architecture shown in the dialog. On a networked Docker computer, for an amd64 host and OpenShell 0.1.2:

```bash
docker pull --platform linux/amd64 ghcr.io/nvidia/openshell/sandbox:0.1.2
docker pull --platform linux/amd64 ghcr.io/nvidia/openshell/supervisor:0.1.2
docker pull --platform linux/amd64 ghcr.io/nvidia/openshell/gateway:0.1.2
docker save --output openshell-runtime-0.1.2-linux-amd64.tar \
  ghcr.io/nvidia/openshell/sandbox:0.1.2 \
  ghcr.io/nvidia/openshell/supervisor:0.1.2 \
  ghcr.io/nvidia/openshell/gateway:0.1.2
```

Use `linux/arm64` for an arm64 host. Select the resulting `.tar` with **Upload**. The console stages at most 4 GiB in a private temporary file, streams it to `docker load` over SSH, verifies the sandbox, supervisor and gateway tags/platforms, and removes the staged file. Gateway startup additionally verifies the gateway image against its pinned digest and platform. It does not execute an installer script from the archive. Remote download pulls the runtime images directly on the host.

Workload images are separate from these runtime images. **Build an image** uses Docker on your computer, targets the selected SSH host’s architecture, then automatically loads the result onto that host through its existing SSH tunnel. The console verifies the engine identity, image ID, and platform before registering the template in the originating gateway/workspace. Local Docker must be running and support the target architecture; no registry is required. **Use an existing image** instead checks the selected remote engine or pulls the reference there. Adding MCP/Skill bundles to an existing remote image imports its base locally under a temporary build-owned tag, without overwriting local user tags. Temporary archives are removed; published images remain on their engines until explicitly removed.

### Disconnecting and reconnecting

**Disconnect** closes the local SSH tunnels. Stopping the console server, shutting down your computer, or putting it to sleep does not stop the remote Docker gateway or persistent terminal sessions. Reconnect to the same SSH host and reopen the same terminal to reattach. The remote machine must remain running; an agent waiting for your input still waits. Stopping/deleting its sandbox or exiting the agent ends its work. Existing images must include `tmux`; console-built images include it automatically. Recreate older sandboxes through the console to receive the required `/dev/ptmx` and `/dev/pts` filesystem grants. MCP OAuth login terminals are short-lived and are not persistent agent sessions.

Gateway state is retained separately for each SSH alias/Docker-engine identity. Reconnecting to the same engine reuses its state and keys. Repointing an alias to a different engine does not reuse the old engine's sandbox records. An SSH failure is shown explicitly; no automatic reconnect or installation retry runs.

Your original local gateway continues independently. Selecting it does not stop an already-running remote gateway; use **Disconnect** when you want that remote connection closed. After a console restart, choose the SSH host and connect again to reattach to its running remote gateway.

## Opening sandboxes

A ready sandbox's **Open in** section offers:

- **Terminal**: opens your system terminal (macOS Terminal or Linux `x-terminal-emulator`). Under **Connection options**, **SSH shell** uses real OpenSSH through the gateway's authenticated relay with an owner-only temporary config, **New session** starts a separate shell or agent with `openshell sandbox exec --tty`, and **Attach** reconnects to the sandbox's running terminal when it has one.
- **VS Code** and **Cursor**: run `openshell sandbox connect <name> --editor …`, which adds OpenShell's managed SSH config (one `Include` line in `~/.ssh/config`) and opens the editor over Remote-SSH. The editor must be installed on your computer. **Cursor** is shown only when Cursor is one of the sandbox's agents, because Cursor's remote connection needs Cursor inside the sandbox. **VS Code** is shown only when **VS Code Server** was chosen under **Tools** (Quick setup) or as a template technology: VS Code installs its version-matched server from inside the sandbox when it connects, so that choice allows GET downloads from `update.code.visualstudio.com` and `vscode.download.prss.microsoft.com` (rule `tool-vscode-server`) and makes `wget` trust OpenShell's CA. Without it, VS Code stops at "Setting up SSH host".
- **Browser**: an xterm.js session in a new tab, backed by the gateway's interactive exec rather than OpenSSH.

Commands and terminal tickets stay pinned to the sandbox's gateway and workspace; switching connections never retargets an open session.

## Troubleshooting

| Symptom | Next step |
| --- | --- |
| No SSH hosts | Add a concrete `Host my-host` entry to the console account's `~/.ssh/config`, then refresh. |
| Host key or authentication rejected | Run `ssh my-host` yourself, verify the host's identity, and configure a usable key or agent. The console does not accept unknown keys or prompt for passwords. |
| Docker missing or inaccessible | Install/start Docker Engine on the Linux host and grant the SSH user socket access. Docker access is effectively host-administrator authority. |
| Runtime still missing after upload | Supply both exact version tags for the detected architecture, using a trusted `docker save` archive. |
| SSH forwarding failed | Enable TCP and Unix-socket forwarding for this SSH account. Ensure the reported remote loopback port is not already in use. |
| Another console owns the connection | Disconnect or stop that console before connecting here. |
| Local gateway missing | Start and register your existing local gateway using the OpenShell CLI, then refresh. Only HTTPS/mTLS registrations are offered. |
| Gateway executable missing | Install `openshell-gateway` 0.1.2 locally and ensure it is on OpenRod's `PATH`, or let **Connect** download the pinned release. |
| Sandbox is not Ready | Inspect its conditions. A successful SSH/runtime connection does not prove a workload image or sandbox policy can start successfully. |


## What is saved and what runs

Both the OpenShell CLI and OpenRod use `CONFIG_DIR = $XDG_CONFIG_HOME/openshell`, otherwise `~/.config/openshell`. Set `XDG_CONFIG_HOME` before launching either program to use another configuration location. Native and copied commands explicitly preserve this location. `STATE_DIR` means `OPENSHELL_CONSOLE_DATA_DIR`, otherwise `$XDG_STATE_HOME/openshell-console` or `~/.local/state/openshell-console`.

| Action / data | Persistent effect |
| --- | --- |
| **This computer** | Reads the existing registration, discovers an accessible workspace, saves `CONFIG_DIR/console-context.json`, and starts activity collection. Does not change the original gateway service. |
| **Remote machine → Connect** | Probes the selected host. Once runtime images are available, creates isolated state under `STATE_DIR/remote-gateways/console-ssh-<hash>/`, registers a distinct local mTLS endpoint under `CONFIG_DIR/gateways/`, and starts the persistent remote Docker gateway and local SSH tunnels. |
| Runtime installation | **Download on host** pulls missing runtime images on the host; **Upload** instead loads a trusted Docker-save archive. Uploaded packages are temporary. Docker itself is installed only after explicit approval. |
| Activity and policies | Stored per gateway/workspace in `STATE_DIR/contexts/<scope-hash>/`: `activity.sqlite`, `activity-delivery.sqlite`, and `policies/` (including organization rules and memberships). SQLite companion files can exist alongside databases. |
| Remote inventory cache | `STATE_DIR/remote-gateways/last-location.json` remembers local/SSH locations; `last-inventory.json` retains the last remote sandbox/template metadata and recipes. These private snapshots survive disconnect/restart but do not restart SSH or authorize disconnected actions. |
| Retention and delivery | Activity has no automatic expiry. No webhook destination is created automatically. Previously configured enabled deliveries may resume on activation/restart and continue sending their original context's pending events after switching. Credentials in the delivery database are not encrypted at rest. |
| Service auto-close | Previously configured deadlines in `STATE_DIR/ingress.json` can resume on activation/restart and close services in their originating context. Switching contexts does not cancel them. |
| Legacy checkout policies | A one-time copy into scoped state is allowed only for the original local loopback `openshell/default` registration. Other registrations do not inherit them. Legacy `ui/.state` activity databases remain untouched, not reassigned. Installed packages exclude checkout policies and runtime databases. |
| Organization policy sweep | Off by default. `OPENSHELL_CONSOLE_SWEEP=1` enables background reconciliation only for the startup context; switching does not retarget it. Explicit policy edits still apply immediately. |
| Native SSH | Private temporary config/directory, normally deleted when SSH exits. Direct SSH does not edit `~/.ssh/config`; the separate editor integration may install managed SSH configuration. |

Switching selection pauses the old activity collector; it does not erase its archive. Stopping the console stops its collectors, delivery workers, deadline enforcement, and local SSH tunnels—not the original gateway or the remote Docker gateway and its workloads. Inspecting another SSH host is not a global pause for an already active console.

## Security model

- **Your gateway authority, on your machine.** OpenRod can do anything the selected gateway credentials allow: create and delete sandboxes, run commands, transfer files and change policy. Remote hosts also use your SSH and Docker authority there. The mTLS keys and provider secrets stay in the Node server; the browser never receives them.
- **Loopback only.** The server binds to `127.0.0.1` (or `localhost`/`::1`) and refuses other addresses. Do not put it behind a reverse proxy, map its port out of a container, or expose it on a LAN. There is no user login or multi-user authorization.
- **Per-launch token.** Every API request, event stream and terminal WebSocket must carry the HttpOnly cookie set by the `?token=` link, compared in constant time. Requests are also checked for peer address, Host, Origin and fetch metadata, and changes require a same-origin POST with a custom header.
- **Local data is not a vault.** Activity history and webhook credentials are stored unencrypted in the state directory. Protect your account, disk and backups.

Read [SECURITY.md](SECURITY.md) for the full threat model and how to report a vulnerability.

## Development

```bash
cd ui
npm ci
npm run dev        # Vite dev server; prints http://127.0.0.1:4600/?token=… below Vite's URLs
npm test           # server and library tests (node --test)
npm run build      # production frontend in ui/dist
npm run start:local -- --port 4601 --open   # run the built console like the installed CLI
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the verification checklist and release steps, and [ui/README.md](ui/README.md) for feature and architecture details. MCP and Skill Setups are described in [ui/SETUPS.md](ui/SETUPS.md).

## License

[Apache License 2.0](LICENSE). Third-party libraries, fonts, and the vendored OpenShell SDK keep their own licenses; see [third-party notices](ui/THIRD_PARTY_NOTICES.md). The license grants no trademark rights.

OpenRod is not affiliated with, endorsed by, or supported by NVIDIA. NVIDIA and OpenShell are trademarks of NVIDIA Corporation.
