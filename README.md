# OpenShell Console

A local web console for discovering, inspecting, and connecting to OpenShell-managed sandboxes, including remote Kubernetes pods.

The console runs on your workstation. SSH reaches the sandbox through OpenShell's gateway and authenticated supervisor relay; it does not expose pod port 22. This is an independent community project, not an NVIDIA-supported product.

## Before you start

The console connects to infrastructure you already have. **Your gateway administrator** deploys and secures OpenShell, creates or grants access to a workspace and a sandbox, and provides the gateway endpoint and an approved mTLS client bundle (`ca.crt`, `tls.crt`, `tls.key`) through a secure channel. If a private tunnel is required, they also provide its Kubernetes context, namespace, service, and port. **You** install the local tools, register that connection, check it, and explicitly activate it.

- **Node.js 22.13+** and npm to run the console.
- **OpenShell CLI 0.1.2** (the verified CLI/gateway version). Follow the [upstream installation guidance](https://docs.nvidia.com/openshell/latest/about/installation) or your administrator's CLI distribution instructions. The upstream all-in-one installer also starts a local gateway; that is not required to connect to an existing one.
- **OpenSSH** (`ssh`) for a real native SSH shell. One-click launch uses macOS Terminal or Linux `x-terminal-emulator`; other environments can copy the command.
- **kubectl and authorized cluster access only if you use a Kubernetes tunnel.** AWS CLI, Helm, and a cloud account are not general console prerequisites.
- An existing **HTTPS, mTLS-compatible gateway** and a **Ready OpenShell sandbox** with a shell. You can use an existing CLI registration or create one manually below. OIDC, edge/browser-authenticated, and plaintext HTTP registrations are unsupported. Arbitrary Kubernetes pods are not supported.

Docker is **not required to connect**. It is used for optional local image builds. A remote cluster must be able to pull its workload images from a registry; a local Docker tag is not automatically uploaded.

## Run from source

```bash
git clone https://github.com/ilaigold/openshell-viewer.git
cd openshell-viewer/ui
npm ci
npm run build
npm start -- --open
```

Open http://127.0.0.1:4600. For development, use `npm run dev` instead.

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

## Set up a connection

1. Start the console and open **Set up connection** in the sidebar. It shows the detected tools and actual configuration/state paths. Setup displays commands for you to inspect and run in your own terminal; it does **not** install tools, provision infrastructure, start tunnels, register gateways, or accept certificate uploads/pasted secrets.
2. Choose an **existing registration**, or follow [Register a new gateway](#register-a-new-gateway) below, then click **Refresh registrations**. The CLI's active gateway is only a suggestion on a fresh console.
3. Click **Check connection**. This reads the named registration, checks the mTLS files and certificate validity/key match, then makes a real list-workspaces request. It does not save a selection, write configuration/databases, start collection, execute anything in a sandbox, or change remote resources. Tool checks also distinguish gateway access from native SSH readiness.
4. Choose a workspace returned by the gateway. Review the activation disclosure and click **Use gateway**. The server revalidates the gateway/workspace, saves your selection, and starts normal console activity collection. See [What is saved and what runs](#what-is-saved-and-what-runs).
5. Open a **Ready** sandbox and choose **SSH shell → Open SSH in terminal**. Run `hostname` and `pwd` to confirm the actual remote shell, then `exit`. A passing connection check proves gateway/workspace access, not that a sandbox is ready or that an SSH shell has already been opened.

**Fresh run:** with no saved console selection and no `OPENSHELL_GATEWAY`, the console does not automatically connect or collect. **Check connection** is an explicit read-only diagnostic; **Use gateway** starts the active connection and collection. A saved selection or an environment-pinned gateway reconnects on restart without repeating this first-run step.

### Register a new gateway

Skip this section if your administrator already installed a working CLI registration. Never replace an existing registration just to make it appear in the console.

For a private Kubernetes gateway, first run the administrator-provided tunnel command in a separate terminal. This example has placeholders; replace them with the supplied values:

```bash
kubectl --context CONTEXT --namespace NAMESPACE \
  port-forward --address 127.0.0.1 svc/SERVICE 18080:8080
```

Keep that terminal running. `https://127.0.0.1:18080` is the **local end of the tunnel**, not local sandbox compute. Do not use `--address 0.0.0.0` or expose the gateway publicly.

For a loopback endpoint (a local gateway or the tunnel above), save the administrator's original bundle in a private directory outside the registration directory. The three filenames must be `ca.crt`, `tls.crt`, and `tls.key`. Then review and run this block, changing `name`, `endpoint`, and `bundle`:

```bash
(
  set -eu
  umask 077
  name='team-gateway'
  endpoint='https://127.0.0.1:18080'
  bundle='/absolute/path/to/administrator-provided-bundle'
  config_dir="${XDG_CONFIG_HOME:-$HOME/.config}/openshell"
  target="$config_dir/gateways/$name"
  cli="${OPENSHELL_BIN:-openshell}"

  # Refuse any existing registration directory, including a symlink.
  if [ -e "$target" ] || [ -L "$target" ]; then
    printf '%s\n' 'Name already exists. Choose a new name; do not overwrite it.' >&2
    exit 1
  fi
  for file in ca.crt tls.crt tls.key; do
    test -s "$bundle/$file" && test -r "$bundle/$file" || {
      printf 'Missing or unreadable bundle file: %s\n' "$file" >&2
      exit 1
    }
  done
  chmod 700 "$bundle"
  chmod 600 "$bundle/ca.crt" "$bundle/tls.crt" "$bundle/tls.key"
  mkdir -p "$config_dir/gateways"
  mkdir "$target" "$target/mtls"
  chmod 700 "$target" "$target/mtls"
  copy_original_bundle() {
    for file in ca.crt tls.crt tls.key; do
      install -m 600 "$bundle/$file" "$target/mtls/$file" || return
    done
  }
  copy_original_bundle
  result=0
  "$cli" gateway add "$endpoint" --name "$name" --local || result=$?
  copy_original_bundle
  exit "$result"
)
```

**Why copy twice?** With OpenShell 0.1.2, `gateway add --local` was observed replacing the preinstalled certificates. Install the bundle **before** registration and restore the **same original bundle after** it, including when the CLI exits unsuccessfully. Do not substitute newly generated certificates. The block never prints a certificate or key. It creates a local registration and stores sensitive credentials; it does not deploy a gateway or create a sandbox. If registration fails, a partial directory may remain: inspect it with your administrator rather than removing the overwrite guard.

The CLI may report “Gateway is not reachable” before the original bundle is restored.
Registration success is not proof of connectivity. Run **Check connection** afterward
and resolve any remaining error; do not disable TLS verification.

`--local` selects the CLI's local mTLS registration workflow for a loopback/tunnel endpoint; it does not relocate remote compute. For a **non-loopback remote gateway**, use the administrator's existing OpenShell registration workflow and inspect `openshell gateway add --help`. In CLI 0.1.2, bare HTTPS registration selects edge/browser authentication, while `--remote <ssh-dest>` is the remote mTLS-over-SSH workflow. Do not invent a `--mtls` flag, apply `--local` to a remote endpoint, or downgrade authentication to satisfy the console. The resulting registration must use supported mTLS authentication.

Return to **Set up connection → Refresh registrations → Check connection → Use gateway**. Credentials remain on disk under `CONFIG_DIR/gateways/NAME/mtls/`; never paste them into the browser or a public issue.

### Terminal choices

Other actions:

- **Open in browser:** an SDK-backed interactive session in an xterm terminal.
- **Exec new:** a new shell or configured agent, started through `openshell sandbox exec --tty`.
- **Attach:** attach to the sandbox's canonical process, available only when that process has a TTY.
- **Copy command:** a self-contained command that generates a private temporary SSH config and removes it after the session exits.
- **Show SSH config:** review and copy a Host block; this action does not edit `~/.ssh/config`.
- **Open in editor:** delegates to OpenShell's editor integration, which may install its managed SSH config.

Commands and terminal tickets are pinned to gateway and workspace. Existing terminal sessions retain their original target when another tab switches the console. Stale browser requests are rejected rather than silently operating on a same-named sandbox elsewhere. Selection is shared by tabs using the same console process, not independently per tab.

Native SSH creates a mode-0700 temporary directory and mode-0600 config. The terminal wrapper removes them when SSH exits; a forcibly killed wrapper or host crash can leave a temporary file. The config contains an OpenShell proxy command, not copied private keys or relay tokens.

### Selection and restart behavior

Gateway precedence is `OPENSHELL_GATEWAY` → saved console gateway → CLI `active_gateway` suggestion → `openshell` suggestion. Workspace precedence is `OPENSHELL_WORKSPACE` → saved workspace → `default`. Only an environment-pinned gateway or saved console selection activates automatically at startup; `OPENSHELL_WORKSPACE` alone does not activate a fresh console. Environment variables pin their respective fields. Remove them and restart if you want to change those fields in the UI.

The console's saved selection is separate from the CLI active gateway; running `openshell gateway select` does not silently retarget an already configured console. To return to first-run mode, stop the console, unset `OPENSHELL_GATEWAY`, and move aside `CONFIG_DIR/console-context.json`. This does not delete registrations, credentials, archives, delivery settings, or pending service deadlines.

### Troubleshooting

| Symptom | Exact next step |
| --- | --- |
| Node is too old / SQLite cannot load | Run `node --version`; install Node 22.13+ and restart the console with that executable. |
| OpenShell CLI is missing | Run `openshell --version` in the terminal that launches the server. Install the CLI or set `OPENSHELL_BIN=/absolute/path/to/openshell`, restart, and reopen **Set up connection**. |
| Native SSH is unavailable | Run `ssh -V`; install your OS's OpenSSH client and restart the console so its `PATH` includes `ssh`. If only terminal launch is unavailable, use **Copy command** in your own terminal. |
| kubectl is missing | For a Kubernetes tunnel, install kubectl and configure the administrator-provided cluster context, then run the tunnel command above. kubectl is unnecessary for a directly reachable registration. |
| No registrations are listed | Check the displayed `CONFIG_DIR` and the server's OS account. The console reads per-user registrations. Complete the manual registration above, or launch both the CLI and console with the same `XDG_CONFIG_HOME`, then click **Refresh registrations**. |
| A certificate file is missing or unreadable | Have the administrator restore `ca.crt`, `tls.crt`, and `tls.key` under `CONFIG_DIR/gateways/NAME/mtls/` for the server's account. Use mode 0700 for the directory and 0600 for the files, then click **Check connection**. |
| TLS certificate expired, not yet valid, mismatched, or untrusted | Check the workstation clock and obtain a renewed, matching bundle for this endpoint from the administrator. Restore all three original files after any 0.1.2 registration attempt and retry **Check connection**. Do not disable TLS verification. |
| Connection refused, timeout, or tunnel stopped | Restart the approved `kubectl ... port-forward --address 127.0.0.1 ...` in a separate terminal; verify its context, namespace, service, and port match the registration and keep it running. Renew cloud/cluster login if kubectl reports authentication failure, then retry **Check connection**. |
| Unsupported OIDC, edge auth, or HTTP | Use the upstream CLI appropriate to that deployment; this console cannot activate it. Ask for an approved, compatible mTLS connection rather than disabling authentication or editing metadata to mislabel it. |
| Workspace is absent / access denied | Ask the administrator to grant this identity access to the intended workspace or provide the correct gateway/bundle. Retry **Check connection** and select only a returned workspace; a valid TLS handshake alone is not authorization. |
| Sandbox is not Ready | Read its status and conditions in the console; ask the administrator to start or repair it and wait for **Ready** before opening SSH. **Check connection** does not start or create sandboxes. |

## Remote Kubernetes and AWS

An AWS account is **not** required for the getting-started path above. The separate [private AWS evaluation guide](deploy/aws/README.md) records the verified EKS/OpenShell setup, administrator-run provisioning, connection steps, and explicit teardown. It is not a production quickstart and the console never runs those commands for you.

The evaluation keeps the gateway as a Kubernetes `ClusterIP` behind a loopback-only `kubectl port-forward`. Kubernetes user authentication and authorization are separate from mTLS transport. That isolated test deployment permits unauthenticated user calls inside its trusted cluster: **do not expose it publicly or share it with untrusted workloads**. Shared production deployments require upstream OIDC or a trusted authentication proxy; those console authentication paths are not implemented.

Administrator references:

- [OpenShell Kubernetes setup](https://docs.nvidia.com/openshell/kubernetes/setup)
- [OpenShell Kubernetes access control](https://docs.nvidia.com/openshell/kubernetes/access-control)
- [OpenShell gateway authentication](https://docs.nvidia.com/openshell/how-it-works/gateways/authentication)
- [EKS network policies](https://docs.aws.amazon.com/eks/latest/userguide/cni-network-policy.html)

EKS, EC2 workers, EBS volumes, public IPv4 addresses, and data transfer incur AWS charges while provisioned. Stopping a sandbox does not delete the cluster or stop those charges.

## What is saved and what runs

The setup dialog displays resolved paths. Both the OpenShell CLI and console use `CONFIG_DIR = $XDG_CONFIG_HOME/openshell`, otherwise `~/.config/openshell`. Set `XDG_CONFIG_HOME` before launching either program to use another configuration location. Native and copied commands explicitly preserve this location so a new terminal cannot select a different registration directory. `STATE_DIR` means `OPENSHELL_CONSOLE_DATA_DIR`, otherwise `$XDG_STATE_HOME/openshell-console` or `~/.local/state/openshell-console`.

| Action / data | Persistent effect |
| --- | --- |
| Manual CLI registration | Writes `CONFIG_DIR/gateways/NAME/metadata.json` and the bundle in `mtls/{ca.crt,tls.crt,tls.key}`. The CLI may also update its own active-gateway state. Setup only displays these commands; you run them. |
| **Check connection** | Reads local registration/TLS material and calls list-workspaces. No local state writes, context activation, collectors, sandbox exec, or remote resource changes. The gateway may log the read request. |
| **Use gateway** | Saves `CONFIG_DIR/console-context.json` (owner-only), reconnects that context on later restarts, and starts collection even with no browser open. |
| Activity and policies | Stored per gateway/workspace in `STATE_DIR/contexts/<scope-hash>/`: `activity.sqlite`, `activity-delivery.sqlite`, and `policies/` (including organization rules and memberships). SQLite companion files can exist alongside databases. |
| Retention and delivery | Activity has no automatic expiry. No webhook destination is created automatically. Previously configured enabled deliveries may resume on activation/restart and continue sending their original context's pending events after switching. Credentials in the delivery database are not encrypted at rest. |
| Service auto-close | Previously configured deadlines in `STATE_DIR/ingress.json` can resume on activation/restart and close services in their originating context. Switching contexts does not cancel them. |
| Legacy checkout policies | A one-time copy into scoped state is allowed only for the original local loopback `openshell/default` registration. Other registrations do not inherit them. Legacy `ui/.state` activity databases remain untouched, not reassigned. Installed packages exclude checkout policies and runtime databases. |
| Organization policy sweep | Off by default. `OPENSHELL_CONSOLE_SWEEP=1` enables background reconciliation only for the startup context; switching does not retarget it. Explicit policy edits still apply immediately. |
| Native SSH | Private temporary config/directory, normally deleted when SSH exits. Direct SSH does not edit `~/.ssh/config`; the separate editor integration may install managed SSH configuration. |

Switching selection pauses the old activity collector; it does not erase its archive. Stopping the console stops its collection, delivery workers, and deadline enforcement, not gateway workloads or cloud billing. Onboarding is not a global pause for an already active console: checking another registration does not stop existing work.

Credentials stay server-side. Treat the console as having the operator's gateway authority. Keep it on loopback; do not proxy it publicly or expose it on a LAN. There is no browser-user login or multi-tenant authentication layer. Activity and webhook credentials are sensitive local data, not an immutable audit log or encrypted credential vault. Protect the operator account and backups.

See [SECURITY.md](SECURITY.md) for the trust boundary, and [ui/README.md](ui/README.md) for feature details, retention/deletion behavior, and transport architecture.

## Development and releases

See [CONTRIBUTING.md](CONTRIBUTING.md) for checks and release packaging. CI exercises the local contracts and build on macOS and Linux; it does not provision AWS resources. Remote transport acceptance requires a real OpenShell gateway and is a separate manual check.

## License

[Apache License 2.0](LICENSE). Third-party libraries, fonts, and the vendored OpenShell SDK retain their own licenses and notices; see [third-party notices](ui/THIRD_PARTY_NOTICES.md). The Apache license does not grant trademark rights.
