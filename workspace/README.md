# OpenShell workspace

One shared OpenShell sandbox that the Claude desktop app and the Codex app open
projects in over SSH. Projects live in `~/projects` inside the sandbox, not on
this Mac; every command, install and network request the agents make runs under
`policy.yaml`.

```bash
./openshell-workspace up       # build the image, start the sandbox, register it with both apps
./openshell-workspace status   # sandbox phase, SSH reachability, projects
./openshell-workspace stop     # flush and stop, keeping files
./openshell-workspace remove   # delete the sandbox and every project in it
```

`up` writes the SSH host `openshell-workspace` to `~/.ssh/openshell/config.d/`,
adds one `Include` line at the top of `~/.ssh/config`, and adds an
"OpenShell · workspace" entry to `sshConfigs` in `~/.claude/settings.json`.
Both files are backed up as `*.bak-openshell` first.

## Using it

- **Claude desktop:** pick "OpenShell · workspace" in the environment dropdown,
  then a folder under `~/projects`. The app deploys its server and CLI to
  `~/.claude/remote/` in the sandbox on first connect and forwards your
  desktop sign-in; nothing to log into.
- **Codex app:** sign in once with `ssh -t openshell-workspace codex login --device-auth`,
  then Settings → Connections → enable `openshell-workspace` and add a project
  under `~/projects`.
- **New project:** neither app's remote folder picker creates folders, so create it first:
  `ssh openshell-workspace 'mkdir -p ~/projects/my-app && cd ~/projects/my-app && git init'`.
- **Dev servers:** `openshell forward start 3000 workspace -d`, then open `http://127.0.0.1:3000`.

## Policy

| Rule | Programs | Hosts |
| --- | --- | --- |
| `agent-claude` | `/usr/local/bin/claude`, `~/.claude/remote/**` (the desktop app's server and CLI) | api.anthropic.com, claude.ai, platform.claude.com, downloads.claude.ai (read-only) |
| `agent-codex` | `/usr/local/bin/codex`, Codex's native binary under `/usr/local/lib/node_modules/@openai/` | api.openai.com, auth.openai.com, chatgpt.com, ab.chatgpt.com |
| `git-github` | git's HTTPS helpers | github.com (read-write: fetches are POSTs) |

Everything else is denied and appears in the console's Approvals page. Claude
Code's Datadog telemetry is denied on purpose. Codex runs with
`sandbox_mode = "danger-full-access"` because OpenShell is the boundary and
Codex's bubblewrap sandbox can't create namespaces inside it.

## Known limits

- All projects share one sandbox: isolated from this Mac, not from each other.
- `openshell sandbox stop` alone can lose recent writes and deletes (0.1.2 doesn't
  flush the VM's disk); `./openshell-workspace stop` runs `sync` first.
- Code leaves the sandbox through git (pushing needs a credential) or
  `openshell sandbox download`.
