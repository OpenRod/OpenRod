# Changelog

## Unreleased

### Guided connection setup

- Added **Set up connection** with tool/path inspection, existing-registration discovery, inspectable user-run registration commands, read-only **Check connection**, and explicit **Use gateway** activation.
- Fresh consoles no longer connect or start collectors from the CLI active-gateway suggestion alone. Saved selections and environment-pinned gateways reconnect on restart, with persistence and background-work disclosures.
- Connection checks validate local mTLS material and make a real list-workspaces request without writing configuration/databases, running sandbox exec, or starting collectors. Activation revalidates the selected gateway/workspace before saving it.
- Documented administrator versus console-user responsibilities, exact private loopback/tunnel registration, existing-name protection, and the OpenShell 0.1.2 requirement to install the original bundle before registration and restore it afterward.
- Unified CLI and console configuration under `$XDG_CONFIG_HOME/openshell` (default `~/.config/openshell`), removing the console-only directory override that could register a gateway somewhere else. Native/copy commands preserve the same configuration root in newly opened terminals.
- Made the native SSH target explicit: gateway, workspace, sandbox, and the proxy/tunnel connection path. A loopback gateway address is not treated as evidence of local compute.
- Browser terminals report Live only after the remote exec session and input handler are ready, preventing early keystrokes from being dropped during gateway connection setup.
- Reworked source/locally built tarball onboarding, symptom-based troubleshooting, selection precedence, local state/retention, resumed delivery and service deadlines, opt-in policy reconciliation, and SDK-terminal versus real OpenSSH behavior.
- Kept AWS provisioning isolated as an optional, billable administrator-run evaluation—not a default or production quickstart. Setup never installs tools, provisions infrastructure, executes registration commands, accepts browser credential uploads, or exposes a gateway publicly.

### Remote connections

- Added registered-gateway and workspace selection without restarting the console.
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
