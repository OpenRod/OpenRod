# Security

## Supported deployment

Run the console on the operator's machine, bound to loopback. It is not a hosted dashboard, identity provider, SSH server, or multi-user authorization boundary. Other processes and users with access to the operator account or loopback interface must be trusted.

The console can exercise the authority of the configured OpenShell gateway credentials: creating and deleting sandboxes, executing commands, transferring files, and changing policy. Do not expose it through a public reverse proxy, container port mapping, or LAN bind. The production executable rejects non-loopback addresses. The API checks peer address, Host, Origin, and fetch-site metadata; mutating requests require same-origin JSON and a custom header. These checks mitigate cross-origin browser attacks, not malicious software running locally.

## Setup and activation boundary

The administrator is responsible for deploying and securing the gateway, workspace authorization, sandbox readiness, and securely distributing an approved mTLS client bundle. The console's **Set up connection** dialog displays inspectable commands; it does not install tools, provision infrastructure, run registration or tunnel commands, or receive credentials pasted/uploaded through the browser.

On a fresh console, with neither a saved console selection nor `OPENSHELL_GATEWAY`, the CLI active gateway is only a suggestion. No automatic gateway connection or activity collector starts until **Use gateway**. **Check connection** is a separate explicit read-only probe: it reads an existing registration and its TLS files, validates certificate dates/key match, and makes a list-workspaces RPC. It does not persist a selection, write configuration/databases, execute inside a sandbox, or mutate remote resources. A gateway may log the read request. A passing check is not a security audit, proof of sandbox readiness, or proof of an OpenSSH session.

**Use gateway** revalidates and saves the selection, then enables normal console behavior. A saved selection or environment-pinned gateway reconnects on restart, starts collection without an open browser, and can resume previously configured webhook delivery and service-close deadlines. Opening setup or checking a different registration does not stop an already active context. Read the [persistent-effects summary](README.md#what-is-saved-and-what-runs) before activation.

## Credentials and connection context

- Gateway TLS keys stay under `$XDG_CONFIG_HOME/openshell` (otherwise `~/.config/openshell`) in `gateways/NAME/mtls/{ca.crt,tls.crt,tls.key}` and are loaded only by the server. The CLI and console share this path convention. Metadata is in the adjacent `metadata.json`. Do not commit these files or place them in the frontend/public directory. Keep credential directories at mode 0700 and files at 0600.
- Browser terminal tickets are one-use, short-lived, and pinned to the gateway/workspace captured at issuance.
- Browser requests carry a context identifier. Requests from a stale context are rejected rather than targeting another same-named sandbox.
- Native SSH uses OpenShell's generated ProxyCommand and session authentication. The console does not expose pod port 22 or implement its own SSH authentication.
- OpenShell-generated SSH configs disable conventional host-key persistence/checking; gateway TLS and the OpenShell relay are the trust path. Review the generated config before use outside this console.
- Temporary SSH configs use owner-only permissions and are removed on normal session exit or terminal-launch failure. Process termination with SIGKILL, an abandoned terminal launch, or a machine crash can leave files under the OS temporary directory. They must not contain private keys or relay tokens.
- OpenShell 0.1.2 `gateway add --local` was observed replacing preinstalled certificates. Manual loopback registration must install the approved bundle before the command and restore the same original bundle afterward, including CLI failure. Refuse an existing registration name; never repair a failure by disabling certificate verification, inventing an authentication flag, or printing private keys.
- Direct **SSH shell** uses real OpenSSH and does not edit `~/.ssh/config`. The separate editor integration may install OpenShell-managed SSH configuration. **Open in browser** is SDK-backed exec, not OpenSSH.
- `console-context.json` in the configuration directory stores the console selection, separately from the CLI's `active_gateway`. Gateway precedence is environment pin, saved selection, then CLI/default suggestions; workspace precedence is environment pin, saved workspace, then `default`. `OPENSHELL_WORKSPACE` alone does not activate a fresh console.

## Remote Kubernetes authentication

Kubernetes gateway mTLS transport does not by itself supply production user authentication and authorization. Configure upstream OIDC or a trusted access proxy for shared deployments, following [OpenShell access control](https://docs.nvidia.com/openshell/kubernetes/access-control). The console currently supports HTTPS mTLS registrations only; OIDC, edge authentication, and plaintext HTTP are unsupported. Do not weaken a deployment's authentication to make it compatible.

The [AWS verification deployment](deploy/aws/README.md) is an optional isolated evaluation, not the default onboarding or a production quickstart. It keeps a ClusterIP gateway behind a loopback-only `kubectl port-forward` and enables OpenShell's development unauthenticated-user option inside the trusted cluster. Do not expose that gateway publicly or run untrusted workloads with access to it. `--local` describes the tunnel endpoint, not local compute. Upstream network policies must be enforced by the CNI, not merely accepted by the Kubernetes API.

## Local state

The state root is `OPENSHELL_CONSOLE_DATA_DIR`, otherwise `$XDG_STATE_HOME/openshell-console` or `~/.local/state/openshell-console`. Policies, memberships, `activity.sqlite`, and `activity-delivery.sqlite` are scoped by gateway/workspace under `contexts/<scope-hash>/`. The root `ingress.json` holds service-close deadlines with their originating contexts. Setup shows the actual resolved paths.

Activity is retained without automatic expiry; switching contexts pauses collection for the old context but leaves its archive. No webhook destination is created automatically. Previously configured enabled deliveries may continue sending their original context's pending events after a switch. Persisted service deadlines can close remote services after activation/restart, regardless of the current selection. Stopping the server stops its workers, not remote workloads; restarting an active context can resume work.

These files are not an encrypted secrets vault. Webhook credentials and activity records can contain sensitive information. Protect the operator account, filesystem permissions, backups, and disk encryption. Archive deletion does not erase source logs, exported or delivered copies, database remnants, or backups; it is not forensic erasure.

Legacy checkout policy migration is a one-time copy only for the original local loopback `openshell/default` registration. Other contexts never inherit it; old `ui/.state` activity databases are left untouched. Organization reconciliation is off unless `OPENSHELL_CONSOLE_SWEEP=1`, then fixed to the startup context. Explicit UI policy changes can still alter remote policy. Imported image build recipes and setup commands execute locally and must be trusted before building.

## Reporting vulnerabilities

Do not post credentials, exploit details, or real sandbox logs in public issues. Use this repository's GitHub **Security → Report a vulnerability** when private reporting is enabled. If it is unavailable, open a non-sensitive issue requesting a private reporting channel from a maintainer. Include affected versions, a minimal reproduction, impact, and redacted evidence through the private channel.

Only the current source branch and subsequently maintained tagged releases receive fixes. There is no security SLA or claim of an independent security audit. Report OpenShell gateway/runtime vulnerabilities to the upstream NVIDIA OpenShell project rather than only to this console.
