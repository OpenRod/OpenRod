# OpenShell Console

A local control plane UI for the OpenShell gateway, built on the OpenRod Desk design system.

```bash
npm install
npm run dev        # http://127.0.0.1:4600
```

## Pages

- **Sandboxes**: a compact virtualized inventory table with sticky sortable columns, status counts, image and group filters, and search across the entire loaded fleet. Rows show name, status, owner, image, group, uptime, and creation age. Only viewport rows plus overscan are mounted; filtering and sorting are memoized separately from live traffic updates. A single click opens a centered popup with the access graph and a compact summary shown first. Rules, Activity, and Details tabs separate the longer content; navigation and lifecycle actions remain visible while each panel scrolls independently. The development-only `?fleet=1000` and `?fleet=10000` previews exercise large inventories without creating real sandboxes. This is client-side windowing over the loaded inventory, not server-side pagination. Owner comes from the owner field or labels; uptime requires a reported start time, and missing data is shown as “Not reported” instead of using creation age. A ready sandbox has **Open in Cursor** and **Open in VS Code** buttons (only for editors installed on this machine). They run `openshell sandbox connect <name> --editor …`, so OpenShell adds its managed SSH config (one `Include` line in `~/.ssh/config`, Host blocks in `~/.config/openshell/ssh_config`) and the editor connects over Remote-SSH. **Open in browser** runs the sandbox's session (its agent, or a shell) in a new browser tab: xterm.js in the page, a WebSocket to the console, and the gateway's interactive exec behind it (the RPC `openshell sandbox exec --tty` uses). The tab's menu starts another session as a shell or any installed agent. Each tab is one session, and it ends when the tab closes.
- **Approvals**: requests the gateway blocked and drafted rules for. Allow, reject with a reason, or revoke an earlier approval.
- **Activity**: retained, searchable logs and platform events with collection coverage, separate policy decisions and outcomes, evidence details, investigation pivots, saved views, and JSON export.
- **Gateway**: health, runtime, auth, providers, and a live traffic map.

### Security

- **Policies**: create-time policies (writable and read-only paths, Landlock mode, starting network rules), picked independently from the image in New sandbox. Built-ins plus your own, saved as JSON in `policies/`. Capture a running sandbox's rules, duplicate, or edit a policy. Existing group references and service-opening defaults are preserved. A policy is fixed once the sandbox exists; later network changes happen on the Network page.
- **Network**: one page with an **Egress** tab and an **Ingress** tab (`#egress`, `#ingress`).
- **Egress** (Network): reusable network rules. **Add rule** asks for a name, destinations (hosts, with `*.` and `**.` wildcards) and an action, Allow or Block, plus what it applies to: **Groups** (the default), **Specific sandboxes**, or **Every sandbox**. A group can be created right in the form. Below the choice, the form lists the sandboxes the rule reaches today. Sandboxes start locked down, so nothing leaves one until an allow rule covers it, and a block always beats an allow. Blocking a host also blocks its subdomains. **Advanced** (allow only) holds ports (default 443 and 80), requests (any, read only, read & write, or specific method/path pairs, plus blocked requests), programs (default any), enforce vs audit, and private addresses. Presets: GitHub read and clone, npm, PyPI. Saved as JSON in `policies/egress/`; saving re-applies the rule to every sandbox it covered before or after. The tab also lists destinations, recently blocked hosts (Allow opens a pre-filled rule) and each sandbox's rules and revisions, where one-off sandbox rules can still be added.
  - How a network rule maps to OpenShell: an allow is one OpenShell rule named `egress_<id>` with an endpoint per destination (no inspection unless Advanced asks for it) and binaries `/**` unless programs are set. OpenShell has no host-level deny, so a block is an inspected endpoint per host (and `**.host`) whose deny rules match every request, on every port the sandbox's rules open (allow rules, its policy, one-off rules and providers). It answers HTTP with `policy_denied` and refuses non-HTTP traffic.
  - "All destinations" (Open) is shown but disabled: OpenShell 0.1.2 rejects `*` hosts, and endpoints without a host only open IP addresses in the VM driver.
- **Groups**: sandboxes that share network access. Create a group on the Groups page (optionally adding sandboxes in the same step), inline in the rule form, or inline in the New sandbox dialog. Put a sandbox in a group from the Groups page (a group menu per sandbox, bulk **Move to**, or a group's panel), or pick the group when creating the sandbox; the dialog lists the network rules it will get. A sandbox is in one group at a time and can change groups whenever; its rules are rewritten right away. Network rules aimed at a group reach every sandbox in it, including ones added later. Deleting a group moves its sandboxes to No group; the sandboxes are kept.
  - Membership is stored by the console in `policies/org/members.json`, not in the sandbox: gateway labels are fixed at creation. A sandbox with no stored membership falls back to the group label it was created with. Deleting a sandbox from the console forgets its membership, so a later sandbox with the same name starts ungrouped. Groups are saved in `policies/org/groups/<id>.json`; one from before the console managed groups may pin a policy (`template`), which the New sandbox dialog shows.
- **Blocked everywhere** (top row of Network → Egress → Rules, and "Block everywhere" on a blocked host): hosts blocked in every sandbox, with their subdomains, written into each one as the `org_blocked` rule. They override every rule. Saved in `policies/org/organization.json`; a background pass every 15s settles requests policy already decides and adds missing rules to sandboxes created outside the console. The Organization page itself is the Enterprise Version.
- **Ingress** (Network): every way into a sandbox, per sandbox. A sandbox starts closed (it has no network interface); the page lists what's open and who can use it. Open a port as a gateway URL with presets (dev server, Vite, Jupyter) and an auto-close timer (1h / 8h / 1 day / until closed), change the timer, or close it. Also shows terminal/exec sessions from the gateway's audit log, the session lifetime from `gateway.toml`, and inbound visits. Policies can open services at start. Auto-close deadlines live in `.state/ingress.json` and are enforced every 30 s while the console runs (and on startup for anything overdue).
- **Secrets**: add (masked, never shown again), rotate, set expiry, attach/detach, delete. Each secret shows exactly which hosts it can be sent to, how it's injected, and which programs may use it. Import NVIDIA's published provider profiles (pinned to v0.1.2).
- **Activity collection**: automatically collects and retains gateway events while the console server runs. Export and Webhook are available in Activity. The separate gateway setting for sandbox OCSF JSON files remains available through the CLI; it does not control Activity collection and is not exposed as an Activity toggle. Legacy `#guardrails` links redirect to Activity.

Changes go through the gateway's server-side patch operations (`UpdateConfig.merge_operations`), so the gateway validates every edit before storing it.

## Image templates

The Templates page lists image templates. An image template is an OpenShell sandbox template (`openshell sandbox template create`), so the list is the gateway's own and `openshell sandbox create --template <name>` works too.

- One page: a name, the agents to install, an optional public repository and a runtime (Node.js, Python). Claude Code, Codex, OpenCode and Gemini CLI are shown; Pi, Cursor, Antigravity, Copilot, Kiro, Factory Droid and Aider are under **More agents**, and any other agent installs through setup commands. **Advanced** holds what the sandbox starts in (any installed agent opens as a session, or a shell, or a custom command), the OS, apt packages, setup commands, non-secret environment variables and the generated Dockerfile. **Use an existing image** takes a local image or a registry reference instead of building one.
- A build runs in local Docker (tagged `openshell-template/<name>:<id>`, as the non-root UID 1000 sandbox user). On success the console creates the OpenShell template: image and environment go into the template itself; the recipe and start command go into the `openshell.console/recipe` annotation so the console can edit it. Nothing is stored in `.state/`; a running or failed build lives only in server memory.
- OpenShell has no template update. Editing rebuilds, then deletes and recreates the template under the same name. Existing sandboxes are unaffected: a previous build's image is removed from Docker only if no sandbox or template still points at it, because a stopped sandbox resolves its image again when it starts. The gateway records the template each sandbox came from, but recreating resets the version, so sandboxes from before and after an edit both show `<name>@1`.
- Template and sandbox names follow OpenShell's rule: lowercase letters, digits and dashes, at most 19 characters.
- Built templates add each selected agent's sign-in and model destinations to the sandbox policy at launch, as rules named `agent-<id>` from the reviewed table in `shared/agent-access.js`; the launch dialog lists them per agent with any sign-in note. Agents such as Pi finish browser sign-in by redirecting to a `localhost` callback inside the sandbox, which the host browser can't reach: copy the full URL from the "site can't be reached" page, paste it into the agent's prompt and press Enter. Existing sandboxes keep the policy they were created with.
- Policies, providers and ingress are chosen in New sandbox, as before; OpenShell templates don't hold policy. CPU and memory aren't offered because the VM driver ignores per-sandbox limits. Templates created with the CLI show up and can be launched, but not edited here.

Run recipe checks with `node --test server/image-templates.test.js` from `ui/`.

## Sandbox attribution

New sandboxes created through this console store `openshell.console/created-by`
and `openshell.console/owner` in their gateway metadata labels. Both initially
identify the local OS account running the console server. Set
`OPENSHELL_CONSOLE_OPERATOR` before starting the server to use a specific user or
service ID instead. The server supplies these values; browser input cannot
choose the creator. Sandbox summary and Details show **Created by** separately
from **Owner**.

This is local operator attribution, not an authenticated browser user or an
immutable audit record. There is no owner reassignment UI yet. Existing sandboxes
and sandboxes created outside the console retain their existing metadata;
missing attribution displays “Not reported”.

## Files

- **Start with** in New sandbox: a local folder or a public git repository.
  - **Local folder:** the server reads a folder under your home folder. It refuses hidden folders such as `~/.ssh` and `~/.config`, `~/Library`, and any folder holding the gateway certificate. Before you create the sandbox it shows what will be sent: file count, size, whether `.gitignore` applied, and files that look like secrets (`.env`, `*.pem`).
  - Once the sandbox is ready, `openshell sandbox upload` puts the folder in `/sandbox/<folder>`, the same as `sandbox create --upload`. `.git` follows as a second upload, because the CLI's `.gitignore` filter leaves it out; worktrees and subfolders arrive without history.
  - **Git repository:** cloned inside the sandbox into `/sandbox/<repo>` with `git clone`. The policy must let git reach the host, and cloning needs POST to `/git-upload-pack`, so a GET-only GitHub rule is not enough.
  - Sessions open in the project folder (`--workdir`, stored as the `openshell.console/project` label). Progress and a Retry button are in the Files tab. Progress is kept in memory, so a console restart forgets it.
- **Files tab** in the sandbox popup:
  - Browse `/sandbox` (listed through `exec`: `realpath`, `find` and `stat`, at most 2,000 entries; nothing GNU-only, so busybox images work too).
  - Download a file, or a folder as `.tar.gz`: `cat` or `tar cf -` streamed out through the SDK's exec into a temp folder, then fetched once by token. (The CLI's `download` needs GNU `realpath -e` in the image, which busybox images lack.)
  - Drop files or folders to upload into the current folder. They are staged one request per file, then sent with one `openshell sandbox upload`. Uploads merge: same-name files are replaced after a confirmation, and nothing is deleted.
- **Limits:**
  - 1 GB per transfer, and never more than the sandbox's free space. The microVM disk is about 4 GB.
  - Only `/sandbox` is reachable, symlinks travel as links, and a link that resolves outside `/sandbox` is refused: the console resolves every path inside the sandbox before it lists, uploads or downloads.
  - Each transfer shows the matching `openshell` command, for anything larger or for scripting.
- Uploads use the CLI (tar over the gateway's SSH relay) because the SDK's `exec` accepts at most 4 MiB of stdin. The CLI must be on `PATH`, or set `OPENSHELL_BIN`.
- Tests: `node --test server/files.test.js`.

## How it connects

The browser only talks to `/api/os/*` on this dev server. `server/` holds an
`@nvidia/openshell-sdk` client (built from OpenShell v0.1.2, vendored in
`vendor/`) authenticated with the same mTLS bundle the `openshell` CLI uses
(`~/.config/openshell/gateways/<active>/mtls`). The certificate never reaches
the browser, and provider credential values are never returned.

The server binds to 127.0.0.1 only. Every route checks the socket, Host and
Origin, and each change additionally requires a same-origin POST with
an `x-openshell-console` header. Writes use JSON.

### SSH connections

The sandbox popup's **Connect** section uses the gateway already selected by
the console, whether its endpoint is local or remote. Every generated CLI
command includes `--gateway <name>` so changing the CLI's active gateway cannot
redirect a connection.

- **Open in browser** keeps the SDK-backed xterm session inside the console.
- **Native SSH → New session** opens the sandbox's configured shell or agent in
  the project directory with `openshell sandbox exec --tty`.
- **Native SSH → Attach** uses `openshell sandbox connect` for sandboxes whose
  canonical process owns a TTY. It is omitted otherwise.
- **Show SSH config** runs `openshell sandbox ssh-config` and displays the Host
  block for review and copying. It never changes `~/.ssh/config`. The existing
  editor action follows OpenShell's `sandbox connect --editor` behavior, which
  may install OpenShell's managed SSH config.

Native terminal launch requires the `openshell` CLI and OpenSSH on the console
machine. Set `OPENSHELL_BIN` to an executable path when the CLI is not on
`PATH`. Opening a terminal is supported on macOS and Linux; other platforms can
copy the pinned command and generated config. The browser receives gateway
location metadata and commands, never mTLS material, SSH session tokens, or
provider credentials.

Focused checks:
`node --test server/openshell-cli.test.js server/editor.test.js server/files.test.js server/ssh.test.js server/terminal.test.js src/lib/sandbox-session.test.js`.

## Notes

- Sandboxes from a locally built image (such as `claude-sandbox:latest`) need
  Docker Desktop running when they are created. Otherwise the VM driver falls
  back to Docker Hub and the sandbox errors.
- Only approvals can be undone. Rejections are final; a rejected host shows
  up again only if the sandbox retries it.

### Installed agent detection

Opening a sandbox's graph or details runs a read-only executable inventory inside ready sandboxes and refreshes it every 30 seconds while open. This finds agents shipped in the image and subsequently installed agents, including removals. It checks PATH and common user installation directories for Claude Code, Codex, GitHub Copilot, Cursor Agent, Gemini CLI, OpenCode, OpenClaw, Pi, Antigravity CLI, Kiro CLI, Factory Droid, and Aider; custom names or locations outside these paths are not automatically discovered. No agent is launched and no credentials are read. A completed scan takes precedence over launch labels; failed/stopped scans retain the last process-cached result as last detected, and an empty successful scan is shown separately from an unavailable scan. Checks have a timeout and share a short cache across tabs. The inventory establishes executable presence, not authentication or agent health, and does not distinguish image provenance from later installation.

## Activity investigations and retention

Activity now searches a local SQLite archive at `ui/.state/activity.sqlite` (Node 22.13+ required). The console server collects logs and platform events even with no browser open. Collection stops when the server stops. There is no automatic expiry; this is a local investigation store, not an immutable external SIEM archive.

- Searches, category/severity filters, exact-match pivots, sorting, and time ranges apply to retained events on the server. Pages use a fixed ingestion snapshot and time anchor so new arrivals cannot shift subsequent pages. Export includes every matching retained event plus coverage metadata.
- Source cursors are saved after evidence is persisted and used to resume watches. Rejected cursors fall back to bounded replay (400 logs and 400 platform events); stream warnings and interruptions remain visible. Earlier history and unresolved gaps are never claimed complete.
- Policy decisions are separate from execution outcomes. A connection failure is not a policy denial. Events without verdicts and unknown formats remain searchable. Original source envelopes, structured fields, full request URLs, and nanosecond timestamps are retained.
- Observed agent labels come from executable-name matches, not authenticated initiator identity or installed-agent inventory. Parent process, initiating user/agent, session linkage, and policy revision at event time are shown as unreported unless the event supplies them. Current policy is never substituted for historical policy.
- History-only records use a scoped source-envelope fingerprint. Stream cursors distinguish otherwise identical source events; cursor aliases reconcile history replay. Sources are scoped by gateway, sandbox identity, and creation time. Collected events remain after sandbox removal.
- Saved views are browser-local. A copied view link contains filters, not evidence; it requires access to the same console archive. Custom time ranges are serialized as absolute instants.

Focused checks: `node --test server/activity-store.test.js server/activity-collector.test.js src/lib/activity-inventory.test.js src/lib/activity-targets.test.js` from `ui/`.


### Activity exports and destinations

Activity retains console-normalized records derived from the gateway log stream, not native OCSF JSON records. Export matching events supports the original console JSON envelope (including query and coverage) or an array of OCSF 1.4.0 Base Events. Downloads stream a fixed snapshot of all matching retained records. The OCSF adapter preserves original evidence in `raw_data` and console fields in `unmapped.openshell`; it does not infer specialized network/authentication classes. Collection time is used only when source time is missing, explicitly marked in `unmapped.time_basis`. A permitted connection is not treated as a successful operation.

**Activity → Export → Webhook** configures public HTTPS JSON ingestion endpoints with no auth, Bearer, or X-API-Key authentication. Each POST contains one console event or one OCSF Base Event; proprietary SIEM envelopes require an adapter. The receiver must accept the selected format. Synthetic tests contain no sandbox data, and HTTP 2xx acceptance is not proof of SIEM indexing.

Destinations are saved paused, with a cursor starting at creation (no automatic historical backfill). Enable forwarding to send all subsequent matching events, including those collected while paused. Filters cover sandbox names, event categories, and decisions. The server sends independently of browser tabs, resuming persisted positions after restarts. Failed events block later delivery to that destination, retry exponentially up to five minutes, and pause after eight failures. Retry/enable resumes the same event; pause retains the position. Delivery is at least once, with a stable event ID and `Idempotency-Key` for receiver deduplication. Removing a destination discards its position and credential but preserves Activity history.

Configuration, credentials, delivery positions, counters, and latest test/failure status live in `.state/activity-delivery.sqlite` (owner-only permissions; credentials are not encrypted at rest and never returned by the API). No destination is configured automatically. HTTPS requests validate certificates, reject redirects and nonpublic addresses, pin DNS resolution per attempt, and have a 10-second request timeout and 1 MB event limit. There is no separate daemon: collection and delivery require the console server to be running; upstream collection gaps still apply.

Validation: `node --test server/activity-delivery.test.js server/activity-store.test.js server/activity-collector.test.js src/lib/activity-inventory.test.js src/lib/activity-targets.test.js`.


### Deleting retained activity

Activity's **Delete** menu offers selected logs (up to 5,000 IDs), all matching logs across every retained page, or all retained logs regardless of filters. Individual event details also have **Delete log**. The header checkbox selects loaded rows only; changing filters clears selection. Synthetic demo data does not expose archive deletion controls.

Each operation first reviews a server-calculated count and a fixed ingestion snapshot. A five-minute, single-use review token is required to confirm. New arrivals after the review are preserved. Deletion removes records from the local archive and pending webhook delivery; source logs, downloaded exports, and remote SIEM copies are unchanged. An outbound request already sent may still arrive. Existing collection continues, and all connected browser caches and paginated history are refreshed, including paused views.

Opaque event fingerprints and cursor aliases remain to prevent deleted events being reimported by upstream replay. Source resume cursors and the monotonically increasing archive sequence are preserved. This is deletion from the console history, not forensic erasure of database files or backups. Restart, replay suppression, exact filtering, all-page deletion, frozen previews, and webhook cancellation are covered by `node --test server/activity-deletion.test.js`.
