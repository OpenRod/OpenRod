# MCP and Skills Setups

## Workflow

1. In **Setups → Bring my setup**, select MCPs and Skills from local harness configuration. Each category supports bulk selection.
2. Quick setup and the image-template builder automatically prepare supported npm packages, then bake a pinned snapshot into the image. In Templates, select the Setup and choose Build template (or Save template for an existing image); preparation progress and cancellation appear in the editor. No separate install step is required. Credentials and unsupported launchers still need attention. For manual preparation or an existing sandbox, **Prepare & check** installs supported npm launchers in disposable OpenShell sandboxes, pins their dependencies, and checks MCP initialization without calling tools. A package that was prepared and passed that check is reused on later imports, retries and Quick setups with the same name, version, integrity hash and arguments; its stored archive digest is re-verified, and the registry policy check and version lookup still run first.
3. Import saves the snapshot automatically and creates or updates the Setup's egress policy (see **Network access**); a popup lists the websites it allows. The dialog lists, before Import, the items that will be saved as inactive (for example unsupported launchers or missing credentials); compatible items can still be used. Import stops for review only when preparation finds a new problem.
4. Select the Setup during Quick setup or template-based sandbox creation, or enable it on an existing sandbox. Quick setup shows package-build progress, stops creation on package failure, supports cancellation, and reuses the prepared snapshot/image on later launches. Destinations covered by the Setup's egress policy need no approval; credential-bound destinations and Setups saved before egress policies existed still list per-sandbox grants to approve. Image templates retain the Setup revision and package artifacts without credentials or active agent configuration.
5. For account-based MCPs, authenticate in the sandbox's agent session. Codex has a **Sign in** action that opens its native MCP login in the terminal. Follow the authorization link and paste the callback URL when prompted. The harness owns its OAuth session and refresh lifecycle.

## Security boundaries

- Desktop OAuth sessions are not copied. Static secrets are transferred only with explicit selection or entry, stored as gateway credentials, and referenced by destination-bound policy rules.
- Imported code runs inside a sandbox. npm lifecycle scripts are disabled. Dependency locks and artifact digests are checked; archives reject traversal and escaping links.
- Runtime, package-build and authentication destinations are separate requirements. Organization restrictions and authoritative gateway policy remain in force. Unknown runtime destinations stay blocked.
- Grants identify the actual executable. Interpreter permissions also apply to other code using that interpreter; they are not per-process isolation.
- MCP initialization and tool discovery do not verify every tool action. Native OAuth completion is verified through the agent, not by reading its private tokens. Remote MCPs that publish OAuth sign-in metadata (read-only, policy-checked GETs from the console) are not started in a check sandbox at import; sign-in and the first connection happen through the agent in the destination sandbox.
- Enabling checks the reviewed revision, executable identity and effective policy again. Installation preserves unrelated harness configuration. Removing a Setup removes managed files and takes the sandbox out of the Setup's egress policy; approved per-sandbox grants and gateway secrets require separate review/removal.

## Network access

Each saved Setup whose MCPs reach the network gets one managed allow policy, `policies/egress/setup-<setup id>.json`, named "MCPs & Skills: <setup name>" and shown in **Egress**.

- It lists the hosts the Setup's active MCPs reach at runtime and each remote MCP's own sign-in host, on their ports (normally 443). Package-build hosts such as the npm registry are never included; only the isolated builder reaches them. Hosts the organization blocks are left out and reported in the import popup.
- Hosts an MCP sends credentials to, and sign-in services named by an MCP's sign-in metadata, are not in the policy: each sandbox approves them when the Setup is enabled there. The import popup lists them.
- It applies to the sandboxes that use the Setup (`appliesTo.setups`), not to everyone. Gateway labels are fixed at creation, so the console records membership in `setup-members.json` in the gateway/workspace's scoped state directory: at sandbox creation (selected and template Setups), on enable, on remove and on sandbox deletion. A Quick-setup `(prepared)` snapshot is recorded with the Setup it was prepared from and uses that Setup's policy. The policy is in the sandbox's policy from creation, and the 15-second policy sync keeps it current.
- Hosts and ports added to the policy in Egress are kept when the Setup's hosts are recomputed (on import and when an item is deleted); ports only a removed MCP needed close. A policy switched to Block in Egress is left unchanged. The policy is removed when the Setup is deleted, or when it would have no hosts left.
- A program inside a member sandbox can reach the listed hosts, as with any allow policy. Credential-bound destinations still use per-sandbox grants that inject the secret for the listed executable only.

## Current limits

- Supported package adapters cover npm/npx launchers. Python/uvx, arbitrary local projects and desktop-only integrations need additional adapters. Host application integrations cannot be made portable just by signing in.
- Existing sandboxes need Python 3.11+, a compatible Node runtime and the selected harness. Package artifacts currently target Linux with glibc and the builder's architecture/Node major.
- Skills are copied as reviewed files. Their instructions are not executed during import; arbitrary package, filesystem and network dependencies are not automatically inferred.
- One Setup holds up to 64 MB of selected MCPs and Skills (each skill up to 4 MB and 200 files). Import the rest as a second Setup.
- To use another registry or sign-in service, add it to the Setup's egress policy in Network › Egress. A completed sign-in does not override network or tool policy.
- Preparation artifacts survive console restart. An interrupted import needs a fresh review. Failed enable operations may leave explicitly approved network rules or credential attachments in place, but take the sandbox back out of a Setup egress policy it had just joined; configuration checks report the failure.
- Preparation checks npm connectivity inside the builder before installing packages. Each npm phase has a two-minute limit and the installation has a 250-second deadline; npm may retry individual downloads, but the console does not repeat the whole installation. Gateway startup, registry outages and interrupted gateway execution stop the remaining tools and retain completed items for review and retry. These rules apply to every import, Quick setup and template preparation.
- The console cannot repair the gateway host's network routing or bootstrap image access. A local gateway image override does not change other users' gateways. The gateway must be able to start its builder and reach the approved registries; the importer reports that failure without bypassing policy or running imported code on the host.

## Verification

From `ui/`: `npm test` runs the automated tests and `npm run build` builds the production frontend. Live checks in disposable sandboxes have covered Quick setup from an unprepared npm MCP to a baked image and a working sandbox, MCP initialization and tool discovery, package install and removal, gateway credential substitution, and denial of an unrelated destination. Native OAuth logins reach the authorization step; account authorization is completed by the user. No MCP tool actions are invoked by these checks.

## Destination agents

The import source does not constrain the destination. `shared/setup-targets.json` is the common catalog for creation, installation, and live inventory. Setups imported from Codex, Claude Code, or Cursor can be installed for:

| Agent | MCP configuration | Skill directory |
| --- | --- | --- |
| Claude Code | `~/.claude.json` | `~/.claude/skills/` |
| Codex | `~/.codex/config.toml` | `~/.agents/skills/` |
| Cursor | `~/.cursor/mcp.json` | `~/.cursor/skills/` |
| OpenCode | `~/.config/opencode/opencode.json` (or existing `.jsonc`) | `~/.config/opencode/skills/` |
| Pi | `~/.pi/agent/mcp.json` | `~/.pi/agent/skills/` |
| Antigravity CLI | `~/.gemini/config/mcp_config.json` | `~/.gemini/config/skills/` |
| GitHub Copilot | `~/.copilot/mcp-config.json` | `~/.copilot/skills/` |
| Kiro CLI | `~/.kiro/settings/mcp.json` | `~/.kiro/skills/` |
| Factory Droid | `~/.factory/mcp.json` | `~/.factory/skills/` |

Aider is explicitly unavailable for Setup installation; this console does not provide a native MCP/skill adapter for it. It can still be selected as a sandbox agent. Import discovery still covers the original three local sources.

MCP entries are converted to the destination schema (including OpenCode command arrays and `environment`, Copilot transport and tool discovery fields, Droid transport types, and Antigravity's `serverUrl`). Existing non-managed settings are preserved. OpenCode JSONC comments are accepted, though a managed update serializes that file as JSON. User changes to managed MCP values or skill files still block overwrite/removal.

Agent versions must support the documented interfaces. In particular, Pi requires its built-in MCP client, and an extension registering `/mcp` may replace that client. Valid skill frontmatter and runtime dependencies remain the skill author's responsibility. Authentication stays inside each destination agent; source OAuth sessions are not transferred.

Adapter references checked October 1, 2026:
- [Pi MCP](https://pi.dev/docs/latest/mcp) and [skills](https://pi.dev/docs/latest/skills)
- [OpenCode MCP](https://opencode.ai/docs/mcp-servers/) and [skills](https://opencode.ai/docs/skills/)
- [Copilot MCP](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers) and [configuration paths](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-config-dir-reference)
- [Kiro configuration scopes](https://kiro.dev/docs/cli/chat/configuration/) and [MCP schema](https://kiro.dev/docs/mcp/configuration/)
- [Droid MCP](https://docs.factory.ai/harness/mcp) and [configuration scopes](https://docs.factory.ai/enterprise/hierarchical-settings-and-org-control)
- [Antigravity MCP migration](https://www.antigravity.google/docs/cli/gcli-migration/) and [skills](https://www.antigravity.google/docs/skills)

Adapter lifecycle tests use isolated homes and stub agent executables; they verify file formats, settings preservation, conflict handling, removal, and inventory without invoking models. A disposable Linux container additionally verified Pi 0.99.2 and OpenCode 1.18.34 connecting to a local test MCP; both agents' native skill loaders found the installed test skill. Other newly added agents have not had authenticated live-session verification.
