# OpenShell Console

A local web console for OpenShell sandboxes on your computer or a remote SSH machine.

Choose an SSH alias, connect, and install the remote OpenShell runtime only if it is missing. Your existing local gateway stays untouched. The console runs a **persistent second gateway on the SSH host** for remote workloads. Remote agent terminals use reattachable tmux sessions, so work continues while your computer sleeps. This is an independent community project, not an NVIDIA-supported product.

## Before you start

- **Node.js 22.13+** and npm.
- **OpenShell CLI 0.1.2** on your computer for CLI-backed actions. For SSH connections, the console reuses an installed `openshell-gateway`, or automatically downloads gateway 0.1.2 into its private data directory. Automatic installation supports Apple Silicon macOS and arm64/x64 Linux, requires `tar`, and verifies the pinned [official release](https://github.com/NVIDIA/OpenShell/releases/tag/v0.1.2) SHA-256 digest before running it. No sudo or existing-gateway changes are needed.
- **OpenSSH and OpenSSL** locally. Native terminal launch supports macOS Terminal and Linux `x-terminal-emulator`.
- For remote work: a concrete `Host` alias in `~/.ssh/config`, trusted key-based SSH access, and a native **Linux amd64/arm64 host with a running rootful Docker Engine**. The SSH user must have read/write access to its Unix socket without an interactive sudo prompt. Docker Desktop, rootless Docker, and Docker contexts targeting a different machine are not supported by the managed SSH topology. Python 3 is also required on the host.

The remote machine does not need OpenShell installed. The console checks for sandbox, supervisor and gateway images matching the pinned release and downloads missing images, or accepts your runtime package. If Docker itself is genuinely absent on Ubuntu or Debian with systemd, connection pauses for **Install Docker and continue** approval. This requires root or passwordless sudo, installs the distribution `docker.io` package and dependencies, enables its service, and grants the SSH user root-equivalent Docker group access. Existing or broken Docker installations are not replaced or repaired automatically; other distributions require manual setup. A Docker daemon on your workstation is not required just to connect.

## Run from source

```bash
git clone https://github.com/ilaigold/openshell-viewer.git
cd openshell-viewer/ui
npm ci
npm run build
npm run start:local -- --open
```

The console prints a link such as `http://127.0.0.1:4600/?token=…`; open that exact link (`--open` does it for you). For development, use `npm run dev` instead; it prints the same kind of link below Vite's own URLs.

`npm run start:local` runs the loopback-only CLI and accepts `--port`, `--open`,
and `--no-open`. `npm start` runs the environment-configured local/cloud server;
see the [cloud deployment guide](deploy/gcp/README.md) for that entry point.

## Install a built package

The repository can produce an installable package; these instructions do not assume a package has already been published to npm.

```bash
cd ui
npm ci
npm pack
npm install --global ./openshell-console-0.1.0.tgz
openshell-console --open
```

`openshell-console` serves the built frontend and the same HTTP, SSE, and WebSocket APIs used in development. Vite is not a runtime dependency. Options:

```text
--port <number>       Default: 4600
--host <loopback>     Default: 127.0.0.1; non-loopback binds are refused
--open               Open the browser
--no-open            Do not open the browser (default)
--help
--version
```

Use `OPENSHELL_BIN` if the CLI is not on `PATH`.

### Opening the console

Every start generates a new random secret and prints `OpenRod console (open this link): http://127.0.0.1:<port>/?token=<secret>`. Opening that link stores the secret in an HttpOnly cookie for that port and reloads the page without the token in the address bar. A bookmark of `http://127.0.0.1:<port>/` keeps working until the console restarts.

After a restart, or in another browser or profile, the page says *Open the link printed by `openrod` in your terminal*: copy the new link from the terminal where the console is running. Treat the link like a password; anyone who has it while the console runs can use your gateway credentials.

## Set up a connection

1. On **Sandboxes**, click **Connect machine** beside **New sandbox**. The location filter starts at **All locations**.
2. Choose an SSH alias, or switch to **Local registered gateway** to return to your existing gateway.
3. Leave **Missing OpenShell runtime → Download automatically** selected, or choose **Upload package** for an offline Docker-save archive.
4. Click **Connect**. SSH uses your configuration, keys, agent and jump host, with strict host-key verification. The console detects the runtime, reuses existing images, and downloads missing images automatically. Upload mode instead waits for your package. Simply listing hosts does not install anything.
   If Docker is missing, review the proposed system changes and approve installation, or close without installing. After approval, a fresh SSH session verifies access before runtime preparation continues in your chosen download/upload mode. Failed installation can leave package, service, or group changes on the host.
5. Once ready, the console selects the connection and reloads. **Sandboxes** and **Templates** show both your local gateway and the SSH machine. **New sandbox** chooses its location explicitly; **Use template** inherits the template's location.

Aliases in `Include` files are discovered too. Wildcard and negated `Host` patterns are not selectable destinations. Host settings are resolved by OpenSSH, not translated into a separate connection form.

The second gateway has its own database, certificates, providers and sandbox inventory on the remote host. It runs as a Docker container with `--restart unless-stopped`, binds to remote loopback, and uses host-local Docker. SSH forwards its authenticated API to your computer; a separate Docker tunnel supports image builds. Only one remote host is connected to the console at a time; switching hosts closes the previous viewer connection without stopping its gateway or work.

When **New sandbox** targets SSH, your local network-policy templates, egress rules, MCPs & Skills, and Groups are offered automatically alongside remote settings. Imports are versioned snapshots: local changes create new identities and existing remote sandboxes retain their policy and membership. Local sandbox memberships and sandbox-specific grants are excluded. Rules for everyone are scoped to the imported groups. Secret values are not copied: credentialed MCPs show the required destination sign-in or credential setup. Prepared npm bundles are copied with digest verification, or rebuilt for a different remote CPU architecture.

### Local and remote inventories

- Rows are marked **Local** or **SSH · host-alias**. Filter either inventory by location; identical names on different gateways remain separate resources.
- Details, terminals, files, policy changes, template builds and bulk actions use each resource's owning gateway/workspace, not the most recently selected connection.
- Creation uses the chosen location and automatically imports local network templates, Groups, and Setups for SSH destinations. Workload-image templates and provider secrets remain location-specific.
- After disconnect, the last remote inventory remains visible with **Disconnected** markers and disabled actions. Local resources remain usable. Reconnect to refresh remote state; cached status is not a live health check.
- Other standalone pages keep the selected connection. Navigation from a resource's details preserves its location for related Network, Activity and Secrets pages.

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

Use `linux/arm64` for an arm64 host. Select the resulting `.tar` in **Upload package**. The console stages at most 4 GiB in a private temporary file, streams it to `docker load` over SSH, verifies the sandbox, supervisor and gateway tags/platforms, and removes the staged file. Gateway startup additionally verifies the gateway image against its pinned digest and platform. It does not execute an installer script from the archive. Remote download pulls the runtime images directly on the host.

Workload images are separate from these runtime images. **Build an image** uses Docker on your computer, targets the selected SSH host’s architecture, then automatically loads the result onto that host through its existing SSH tunnel. The console verifies the engine identity, image ID, and platform before registering the template in the originating gateway/workspace. Local Docker must be running and support the target architecture; no registry is required. **Use an existing image** instead checks the selected remote engine or pulls the reference there. Adding MCP/Skill bundles to an existing remote image imports its base locally under a temporary build-owned tag, without overwriting local user tags. Temporary archives are removed; published images remain on their engines until explicitly removed.

### Disconnecting and reconnecting

**Disconnect from remote** closes the local SSH tunnels. Stopping the console server, shutting down your computer, or putting it to sleep does not stop the remote Docker gateway or persistent terminal sessions. Reconnect to the same SSH host and reopen the same terminal to reattach. The remote machine must remain running; an agent waiting for your input still waits. Stopping/deleting its sandbox or exiting the agent ends its work. Existing images must include `tmux`; console-built images include it automatically. Recreate older sandboxes through the console to receive the required `/dev/ptmx` and `/dev/pts` filesystem grants. MCP OAuth login terminals are short-lived and are not persistent agent sessions.

Gateway state is retained separately for each SSH alias/Docker-engine identity. Reconnecting to the same engine reuses its state and keys. Repointing an alias to a different engine does not reuse the old engine's sandbox records. An SSH failure is shown explicitly; no automatic reconnect or installation retry runs.

Your original local gateway continues independently. Selecting it does not stop an already-running remote gateway; use **Disconnect** when you want that remote connection closed. After a console restart, choose the SSH host and connect again to reattach to its running remote gateway.

### Terminal and workspace behavior

- **Open in browser** uses SDK interactive exec, not OpenSSH.
- **SSH shell → Open SSH in terminal** uses real OpenSSH through the selected gateway's authenticated sandbox relay.
- **Exec new**, **Attach**, **Copy command**, **Show SSH config**, and editor integration remain available. Attach requires a canonical TTY.
- Commands and terminal tickets remain pinned to gateway/workspace. Switching the console does not retarget existing sessions; disconnecting the viewer detaches remote tmux sessions without ending the agent. Local interactive exec retains its existing lifecycle.
- Workspace selection is automatic: reuse the prior accessible workspace, otherwise use `default` or the first returned workspace. There is no workspace chooser.

Gateway precedence remains `OPENSHELL_GATEWAY` → saved console selection → CLI/default suggestion. Environment variables pin their respective fields; remove `OPENSHELL_GATEWAY` and restart to select an SSH host. With no saved selection or gateway pin, host discovery does not start activity collection. Successful connection saves the console selection separately from the CLI's active gateway.

### Troubleshooting

| Symptom | Next step |
| --- | --- |
| No SSH hosts | Add a concrete `Host my-host` entry to the console account's `~/.ssh/config`, then refresh. |
| Host key or authentication rejected | Run `ssh my-host` yourself, verify the host's identity, and configure a usable key or agent. The console does not accept unknown keys or prompt for passwords. |
| Docker missing or inaccessible | Install/start Docker Engine on the Linux host and grant the SSH user socket access. Docker access is effectively host-administrator authority. |
| Runtime still missing after upload | Supply both exact version tags for the detected architecture, using a trusted `docker save` archive. |
| SSH forwarding failed | Enable TCP and Unix-socket forwarding for this SSH account. Ensure the reported remote loopback port is not already in use. |
| Another console owns the connection | Disconnect or stop that console before connecting here. |
| Local gateway missing | Start and register your existing local gateway using the OpenShell CLI, then refresh. Only supported local HTTPS/mTLS registrations appear in the normal connection picker. |
| Gateway executable missing | Install `openshell-gateway` 0.1.2 locally and ensure it is on the console server's `PATH`. |
| Sandbox is not Ready | Inspect its conditions. A successful SSH/runtime connection does not prove a workload image or sandbox policy can start successfully. |


## What is saved and what runs

Both the OpenShell CLI and console use `CONFIG_DIR = $XDG_CONFIG_HOME/openshell`, otherwise `~/.config/openshell`. Set `XDG_CONFIG_HOME` before launching either program to use another configuration location. Native and copied commands explicitly preserve this location. `STATE_DIR` means `OPENSHELL_CONSOLE_DATA_DIR`, otherwise `$XDG_STATE_HOME/openshell-console` or `~/.local/state/openshell-console`.

| Action / data | Persistent effect |
| --- | --- |
| **Connect → Local** | Reads the existing registration, discovers an accessible workspace, saves `CONFIG_DIR/console-context.json`, and starts activity collection. Does not change the original gateway service. |
| **Connect → SSH** | Probes the selected host. Once runtime images are available, creates isolated state under `STATE_DIR/remote-gateways/console-ssh-<hash>/`, registers a distinct local mTLS endpoint under `CONFIG_DIR/gateways/`, and starts the persistent remote Docker gateway and local SSH tunnels. |
| Runtime installation | **Connect** downloads missing runtime images by default; **Upload package** instead waits for a trusted Docker-save archive. Uploaded packages are temporary. No remote gateway, cloud cluster, or privileged Docker installation. |
| Activity and policies | Stored per gateway/workspace in `STATE_DIR/contexts/<scope-hash>/`: `activity.sqlite`, `activity-delivery.sqlite`, and `policies/` (including organization rules and memberships). SQLite companion files can exist alongside databases. |
| Remote inventory cache | `STATE_DIR/remote-gateways/last-location.json` remembers local/SSH locations; `last-inventory.json` retains the last remote sandbox/template metadata and recipes. These private snapshots survive disconnect/restart but do not restart SSH or authorize disconnected actions. |
| Retention and delivery | Activity has no automatic expiry. No webhook destination is created automatically. Previously configured enabled deliveries may resume on activation/restart and continue sending their original context's pending events after switching. Credentials in the delivery database are not encrypted at rest. |
| Service auto-close | Previously configured deadlines in `STATE_DIR/ingress.json` can resume on activation/restart and close services in their originating context. Switching contexts does not cancel them. |
| Legacy checkout policies | A one-time copy into scoped state is allowed only for the original local loopback `openshell/default` registration. Other registrations do not inherit them. Legacy `ui/.state` activity databases remain untouched, not reassigned. Installed packages exclude checkout policies and runtime databases. |
| Organization policy sweep | Off by default. `OPENSHELL_CONSOLE_SWEEP=1` enables background reconciliation only for the startup context; switching does not retarget it. Explicit policy edits still apply immediately. |
| Native SSH | Private temporary config/directory, normally deleted when SSH exits. Direct SSH does not edit `~/.ssh/config`; the separate editor integration may install managed SSH configuration. |

Switching selection pauses the old activity collector; it does not erase its archive. Stopping the console stops its collectors, delivery workers, deadline enforcement, and managed remote gateway/tunnels—not the original gateway, remote containers, or cloud billing. Inspecting another SSH host is not a global pause for an already active console.

Credentials stay server-side. Treat the console as having the operator's gateway authority. Keep it on loopback; do not proxy it publicly or expose it on a LAN. There is no browser-user login or multi-tenant authentication layer. Activity and webhook credentials are sensitive local data, not an immutable audit log or encrypted credential vault. Protect the operator account and backups.

See [SECURITY.md](SECURITY.md) for the trust boundary, and [ui/README.md](ui/README.md) for feature details, retention/deletion behavior, and transport architecture.

## Development and releases

See [CONTRIBUTING.md](CONTRIBUTING.md) for checks and release packaging. CI exercises the local contracts and build on macOS and Linux; it does not provision AWS resources. Remote transport acceptance requires a real OpenShell gateway and is a separate manual check.

## License

[Apache License 2.0](LICENSE). Third-party libraries, fonts, and the vendored OpenShell SDK retain their own licenses and notices; see [third-party notices](ui/THIRD_PARTY_NOTICES.md). The Apache license does not grant trademark rights.
