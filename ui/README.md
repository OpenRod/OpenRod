# OpenShell Console

A local control plane UI for the OpenShell gateway, built on the OpenRod Desk design system.

```bash
npm install
npm run dev        # http://127.0.0.1:4600
```

## Pages

- **Sandboxes**: a compact virtualized inventory table with sticky sortable columns, status counts, image and group filters, and search across the entire loaded fleet. Rows show name, status, owner, image, group, uptime, and creation age. Only viewport rows plus overscan are mounted; filtering and sorting are memoized separately from live traffic updates. A single click opens a centered popup with the access graph and a compact summary shown first. Rules, Activity, and Details tabs separate the longer content; navigation and lifecycle actions remain visible while each panel scrolls independently. The development-only `?fleet=1000` and `?fleet=10000` previews exercise large inventories without creating real sandboxes. This is client-side windowing over the loaded inventory, not server-side pagination. Owner comes from the owner field or labels; uptime requires a reported start time, and missing data is shown as “Not reported” instead of using creation age.
- **Approvals**: requests the gateway blocked and drafted rules for. Allow, reject with a reason, or revoke an earlier approval.
- **Activity**: live allowed/denied connection feed from the sandbox proxy (OCSF audit lines), with a "most denied" breakdown.
- **Gateway**: health, runtime, auth, providers, and a live traffic map.

### Policies

- **Organization**: access decided before sandboxes run, in three layers: organization rules for every sandbox, group rules for the sandboxes in a group, and each sandbox's own rules (Egress). A sandbox picks its group in New sandbox and keeps it for life (a gateway label). Organization-blocked hosts override every rule. Each level sets what happens to requests nothing covers: keep blocked (rejected automatically, nobody asked), auto-approve safe ones, or ask a reviewer. Saved as JSON in `policies/org/`; saving re-applies to every affected sandbox, and a background pass every 15s settles requests policy already decides and adds missing rules to sandboxes created outside the console.
- **Egress**: per-sandbox network rules: hosts (with wildcards), ports, HTTP method/path allow and block rules, which programs may connect, enforce vs audit, and private-IP allowances. Recently denied destinations become draft rules in one click. Every change is a revision; the console waits until the sandbox confirms it is enforced, and any revision can be restored. Also shows the global policy status and lets you remove one (setting a global policy is left to the CLI).
- **Ingress**: every way into a sandbox, per sandbox. A sandbox starts closed (it has no network interface); the page lists what's open and who can use it. Open a port as a gateway URL with presets (dev server, Vite, Jupyter) and an auto-close timer (1h / 8h / 1 day / until closed), change the timer, or close it. Also shows terminal/exec sessions from the gateway's audit log, the session lifetime from `gateway.toml`, and inbound visits. Templates can open services at start. Auto-close deadlines live in `.state/ingress.json` and are enforced every 30 s while the console runs (and on startup for anything overdue).
- **Secrets**: add (masked, never shown again), rotate, set expiry, attach/detach, delete. Each secret shows exactly which hosts it can be sent to, how it's injected, and which programs may use it. Import NVIDIA's published provider profiles (pinned to v0.1.2).
- **Security presets** (under Templates): create-time policies (writable and read-only paths, Landlock mode, starting network rules), picked independently from the image in New sandbox. Built-ins plus your own, saved as JSON in `policies/`. Capture a running sandbox's rules, duplicate, or edit a preset. Existing group references and service-opening defaults are preserved.
- **Guardrails**: gateway settings, gateway-wide or per sandbox: auto-approval of prover-clean proposals, agent proposals, and the OCSF JSON audit log.

Changes go through the gateway's server-side patch operations (`UpdateConfig.merge_operations`), so the gateway validates every edit before storing it.

## Image templates

Templates is also a local environment library, with a separate **Image templates** tab:

- A six-step builder covers Ubuntu/Debian, system packages, Node/Python, Claude Code/Codex, an optional public repository and small files, build commands, and launch defaults. Recipes compile to an inspectable Dockerfile in an isolated temporary build context. Files and setup commands run as the non-root UID 1000 sandbox user. Build-time networking belongs to Docker; runtime access belongs to the selected security preset.
- Import an existing local image, pull a registry reference using Docker's existing authentication, or upload a `docker save` archive (`.tar`, `.tar.gz`, `.tgz`, up to 4 GB). VM disk images and rootfs archives are not supported by this importer. Multi-image archives load into Docker but require selecting a single image through the local-image picker afterward.
- Drafts and results persist in `.state/image-templates/`; in-progress form recovery uses session storage. Images remain in the local Docker engine. Real build/import logs, cancellation, failure recovery, search, duplication, and recipe removal are supported. Removing a recipe does not delete an image or sandbox.
- “Available locally” means the image exists and passed Linux/architecture inspection, **not** that its OpenShell runtime was tested. Launch uses the inspected image ID, rechecks image availability, and independently resolves organization/group/security-preset policy. Remote gateways and non-local Docker contexts are rejected. The selected gateway must be able to access that local engine.
- Startup commands and non-secret environment values are launch defaults, not image layers. Credential fields are rejected; attach providers through the existing launch dialog. Compute limits remain the gateway defaults in this version.

Run recipe/storage checks with `node --test server/image-templates.test.js` from `ui/`. Runtime smoke checks have covered a real Node/Python build, uploaded archive, registry pull, local import, and a temporary OpenShell sandbox with working files/environment and writable workspace.

## How it connects

The browser only talks to `/api/os/*` on this dev server. `server/` holds an
`@nvidia/openshell-sdk` client (built from OpenShell v0.1.2, vendored in
`vendor/`) authenticated with the same mTLS bundle the `openshell` CLI uses
(`~/.config/openshell/gateways/<active>/mtls`). The certificate never reaches
the browser, and provider credential values are never returned.

The server binds to 127.0.0.1 only. Every route checks the socket, Host and
Origin, and each change additionally requires a same-origin POST with
an `x-openshell-console` header. Ordinary writes use JSON; the image archive
route accepts a size-limited binary stream with the same origin/header checks.

## Notes

- Sandboxes from a locally built image (such as `claude-sandbox:latest`) need
  Docker Desktop running when they are created. Otherwise the VM driver falls
  back to Docker Hub and the sandbox errors.
- Only approvals can be undone. Rejections are final; a rejected host shows
  up again only if the sandbox retries it.
