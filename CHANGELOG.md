# Changelog

## Unreleased

### Persistent SSH work and local configuration reuse

- Run the managed SSH gateway on the remote host in a pinned Docker container with persistent state and restart policy. Laptop sleep, console shutdown and viewer disconnect close only local tunnels.
- Remote browser terminals, native SSH shells and copied Exec commands reattach to named tmux sessions. Console-built images include tmux, and new remote sandboxes receive explicit PTY device grants.
- Remote sandbox creation automatically offers local network-policy templates, egress rules, MCPs & Skills, and Groups as versioned snapshots. Remapped identities preserve existing remote policy and membership; local sandbox grants and original-gateway secrets are excluded.
- Prepared MCP archives retain digest verification and are rebuilt for incompatible remote architectures. Credentialed MCPs indicate destination credentials are required.
- Migrate legacy remote-work gateway SQLite/WAL state and driver files over SSH, retaining the original copy and refusing conflicting or missing remote state.
- Verified 547 tests and the production build after rebasing onto current main. An isolated real EC2 sandbox continued successful HTTPS requests while its terminal, viewer and all test gateway tunnels were disconnected, then reattached to the same session. A second EC2 sandbox built and installed an imported local Skill with its Group and network policy; MCP credentials and a real model conversation were not exercised.

### Combined local and SSH inventories

- Sandboxes and Templates now show local and managed SSH resources together, with location badges, an All locations filter, and location-qualified identity for same-named resources.
- Details, terminals, files, policy edits, creation and template/bulk actions retain the resource's owning gateway/workspace. Creation selects its location explicitly; using a template inherits its location.
- Disconnected remote inventory is retained across reload/restart with disabled actions; local resources remain usable. AWS EKS is excluded from this local/SSH flow.
- Explicit location requests reject unknown or disconnected owners; OpenRod Cloud authorization remains selected-context-only.
- Fixed Setup-save policy synchronization to use the context-scoped store after the global store removal; migrated policy/membership integration fixtures to scoped state.
- Browser smoke against both existing gateways verified combined inventories, location filtering, local details while SSH was selected, owner-restricted creation templates, and retained disabled remote rows after an isolated disconnect. A live local overview remained available; the server rejected a disconnected remote mutation with HTTP 409. No live workloads or policies were changed.
- Verified all 461 regression tests and the production build. A throwaway real Setup-save route exercise persisted the expected scoped MCP egress policy. Browser creation proof stopped before provisioning; real cross-location sandbox creation and terminal execution were not performed.
- Merged current main's scoped Setup fixes, retaining explicit store handoff and isolated integration fixtures. CI now initializes runner-temporary state paths inside a step instead of using the unavailable job-level `runner` context; the integrated workflow passes `actionlint`.

### SSH connection recovery and preparation

- Disconnect now restores the available local gateway/workspace or requires connection selection, rather than retaining the stopped SSH gateway endpoint.
- Missing Docker on Ubuntu/Debian systemd hosts now pauses for explicit installation approval, shows privileged package/service/group effects, verifies a fresh SSH login, and continues the chosen runtime download/upload mode. Existing or broken installations are never automatically replaced or repaired.
- Verified Docker approval and upload continuation in the browser with isolated SSH fixtures; real privileged installation was not run on the already-prepared EC2 host.
- SSH image templates now build on local Docker for the remote architecture, transfer over the existing SSH Docker tunnel, and verify engine/image identity before registration. Existing-image selection uses the deployment engine; remote-only bases for MCP/Skill layers are imported under temporary local tags.
- Verified a real browser-triggered ARM64-Mac → AMD64-EC2 build, transfer, matching image IDs, and Ready template publication. Production build and 335 regression tests passed; all 53 image/engine tests passed after the remote-base follow-up.

### Upstream integration

- Rebased onto main `5847b76`, preserving multi-group membership and serialized policy coverage, global-policy review/removal, Quick Setup build logs, and template-in-use deletion protection alongside SSH-first connections and local-to-SSH image builds. Template usage checks and membership fixtures now retain the selected workspace/storage scope.
- Verified 377 regression tests and the production build. An isolated browser/server smoke against the live gateway loaded template inventory, sandbox details and network rules; the usage endpoint identified the existing sandbox blocking template deletion. No live policies or workloads were changed, and the primary console was not restarted.
- Rebased onto current main while retaining cloud authentication, cloud transfer, SSH-first connections, context-scoped Setup storage and template drafts. Restored explicit Python setup in CI.
- Verified the merged production build and 267 regression tests. Browser smoke covered local connection, refresh cancellation/timeouts/retry, sandbox forms, Setup navigation and template-draft recovery; live API checks rejected cross-origin and stale-context mutations.
- Reconnected the real `aws-ec2` host through its existing managed gateway state with runtime installation disabled by upload mode. Docker and matching runtime images were already ready. No remote workloads were created or deleted; full sandbox creation/terminal and fresh remote installation remain unverified in this pass.

- Preserved upstream MCP/Skills imports, Quick Setup, template bulk actions, graph/theme controls, OpenEgg Shell branding and new native Terminal sessions alongside remote onboarding.
- Bound Setup catalogs, preparation artifacts/manifests, previews, cancellation, deployment jobs, credentials and inventory to gateway/workspace context. Legacy checkout Setup data stays untouched and requires explicit re-import/preparation.
- Scoped browser template draft recovery so another gateway or workspace cannot adopt a draft's Setup references or replacement intent.
- Retained published Docker images during template deletion because another gateway/workspace may reference them.
- Included Setup Python helpers, the verifier and shared JSON catalog in npm packages; classified MCP, archive and TOML libraries as runtime dependencies and refreshed license notices. CI provisions Python for installer regressions.
- Verified the integrated suite (214 tests), production build, installed-package first-run flow, real skill discovery/import, and browser/native SSH sessions through a local gateway. AWS transport was not reverified during this merge because its credential refresh failed.

### SSH-first connection setup

- Replaced the cloud/registration wizard with local-gateway or configured-SSH-host selection. The original local gateway is preserved; an isolated second gateway runs locally for remote Docker workloads.
- Discover concrete SSH aliases and Include files; retain OpenSSH configuration, strict known-host checking, key/agent authentication and jump hosts.
- Read connection lists and job status without waiting for the current gateway's workspace discovery, so an unreachable gateway does not block choosing a host.
- Removed the manual workspace chooser; connections automatically reuse an accessible saved workspace or select `default`/the first accessible workspace, while retaining context isolation internally.
- Automatically install a missing local remote-work gateway executable from the pinned official OpenShell 0.1.2 release, verify its SHA-256 checksum, and retain it in the console data directory without sudo or overwriting existing installations.
- Moved connection setup out of the sidebar to **Connect machine** beside **New sandbox**, with the active location shown in the sandbox toolbar.
- SSH connection now detects and reuses installed OpenShell runtime images, automatically downloads missing images by default, or waits for a package when upload mode is selected.
- Host refresh retains current choices, leaves connection controls and dialog closing responsive, and aborts after ten seconds with an actionable error. Added a monitor icon to the Connect machine action.
- Probe native Linux/rootful Docker and version-matched OpenShell sandbox/supervisor images. Missing runtime images can be downloaded remotely or loaded from an uploaded Docker-save package.
- Isolate gateway databases, keys and registrations by SSH alias/Docker-engine identity. Own gateway/tunnel lifecycle, preserve remote workloads on disconnect, and require explicit reconnect after console restart.
- Generate separate operator and supervisor credentials for OpenShell 0.1.2's complete guest-mTLS requirement; never copy the original local gateway's keys.
- Unified CLI and console configuration under `$XDG_CONFIG_HOME/openshell` (default `~/.config/openshell`), removing the console-only directory override that could register a gateway somewhere else. Native/copy commands preserve the same configuration root in newly opened terminals.
- Made the native SSH target explicit: gateway, workspace, sandbox, and the proxy/tunnel connection path. A loopback gateway address is not treated as evidence of local compute.
- Browser terminals report Live only after the remote exec session and input handler are ready, preventing early keystrokes from being dropped during gateway connection setup.
- Reworked source/locally built tarball onboarding, symptom-based troubleshooting, selection precedence, local state/retention, resumed delivery and service deadlines, opt-in policy reconciliation, and SDK-terminal versus real OpenSSH behavior.
- Removed obsolete registration-plan helpers and read-only onboarding endpoints. The normal flow no longer asks for cloud, Kubernetes or certificate-bundle configuration.

### Remote connections

- Retained gateway/workspace context isolation and accessible-workspace selection for local and SSH-managed connections.
- Pinned SDK operations, CLI commands, terminal tickets, uploads, builds, and service deadlines to their originating gateway/workspace.
- Reject stale browser requests instead of silently targeting another context; existing interactive sessions keep their original target.
- Made direct OpenSSH the primary native terminal action, using private temporary SSH configuration with exit cleanup. Kept separate exec and canonical TTY attach actions.
- Verified native OpenSSH and browser terminals against OpenShell-managed AWS EKS pods, including same-named sandboxes in different workspaces.
- Fixed ready Kubernetes sandboxes being reported as problematic solely because `Suspended=False`.

### Distribution and safety

- Added a loopback-only production server and `openshell-console` executable; npm packages include the built frontend and bundled SDK without Vite at runtime.
- Moved mutable data out of the application directory and scoped policies, memberships, archives, and delivery configuration by connection context.
- Made organization-policy reconciliation an explicit startup-context opt-in. Gateway selection alone no longer enables policy reconciliation.
- Retained published Docker images rather than deleting images potentially referenced by another gateway/workspace.
- Added Apache-2.0 licensing, SDK and dependency notices, contributor/security guidance, and macOS/Linux CI packaging checks.
- Replaced the undocumented PP Rader font asset with the existing open-source Geist font.

### Deployment limits

- AWS verification uses a private Kubernetes port-forward and development user-authentication configuration, not public production ingress.
- OIDC and edge-authenticated gateway registrations remain unsupported by the console.
- No npm publication, GitHub release, or repository visibility change is performed by these source changes.
