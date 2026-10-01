# MCP and Skills Setups

## Workflow

1. In **Setups → Bring my setup**, select MCPs and Skills from local harness configuration. Each category supports bulk selection.
2. Quick setup and the image-template builder automatically prepare supported npm packages, then bake a pinned snapshot into the image. In Templates, select the Setup and choose Build template (or Save template for an existing image); preparation progress and cancellation appear in the editor. No separate install step is required. Credentials and unsupported launchers still need attention. For manual preparation or an existing sandbox, **Prepare & check** installs supported npm launchers in disposable OpenShell sandboxes, pins their dependencies, and checks MCP initialization without calling tools.
3. Save the reviewed snapshot. Items needing attention remain inactive; compatible items can still be used.
4. Select the Setup during Quick setup or template-based sandbox creation, or enable it on an existing sandbox. Quick setup shows package-build progress, stops creation on package failure, supports cancellation, and reuses the prepared snapshot/image on later launches. Review access before granting it. Image templates retain the Setup revision and package artifacts without credentials or active agent configuration.
5. For account-based MCPs, authenticate in the sandbox's agent session. Codex has a **Sign in** action that opens its native MCP login in the terminal. Follow the authorization link and paste the callback URL when prompted. The harness owns its OAuth session and refresh lifecycle.

## Security boundaries

- Desktop OAuth sessions are not copied. Static secrets are transferred only with explicit selection or entry, stored as gateway credentials, and referenced by destination-bound policy rules.
- Imported code runs inside a sandbox. npm lifecycle scripts are disabled. Dependency locks and artifact digests are checked; archives reject traversal and escaping links.
- Runtime, package-build and authentication destinations are separate requirements. Organization restrictions and authoritative gateway policy remain in force. Unknown runtime destinations stay blocked.
- Grants identify the actual executable. Interpreter permissions also apply to other code using that interpreter; they are not per-process isolation.
- MCP initialization and tool discovery do not verify every tool action. Native OAuth completion is verified through the agent, not by reading its private tokens.
- Enabling checks the reviewed revision, executable identity and effective policy again. Installation preserves unrelated harness configuration. Removing a Setup removes managed files; approved network rules and gateway secrets require separate review/removal.

## Current limits

- Supported package adapters cover npm/npx launchers. Python/uvx, arbitrary local projects and desktop-only integrations need additional adapters. Host application integrations cannot be made portable just by signing in.
- Existing sandboxes need Python 3.11+, a compatible Node runtime and the selected harness. Package artifacts currently target Linux with glibc and the builder's architecture/Node major.
- Skills are copied as reviewed files. Their instructions are not executed during import; arbitrary package, filesystem and network dependencies are not automatically inferred.
- Additional/custom registries and sign-in services require review. A completed sign-in does not override network or tool policy.
- Preparation artifacts survive console restart. An interrupted import needs a fresh review. Failed enable operations may leave explicitly approved network rules or credential attachments in place; configuration checks report the failure.
- Preparation checks npm connectivity inside the builder before installing packages. Each npm phase has a two-minute limit and the installation has a 250-second deadline; npm may retry individual downloads, but the console does not repeat the whole installation. Gateway startup, registry outages and interrupted gateway execution stop the remaining tools and retain completed items for review and retry. These rules apply to every import, Quick setup and template preparation.
- The console cannot repair the gateway host's network routing or bootstrap image access. A local gateway image override does not change other users' gateways. The gateway must be able to start its builder and reach the approved registries; the importer reports that failure without bypassing policy or running imported code on the host.

## Verification

Automated tests: `node --test ui/server/*.test.js ui/src/lib/*.test.js`.
Production build: `npm --prefix ui run build`.

A live Quick setup test also covered unprepared shadcn → pinned snapshot → baked image → sandbox install, seven discovered tools, an HTTP 200 registry request, and reuse of the pinned image.

Live disposable-sandbox checks covered Magic UI and shadcn initialization/tool discovery, package install/removal, gateway credential substitution and denial of an unrelated destination. Native Codex/Figma login reached the authorization step; account authorization must be completed by the user. No MCP tool actions were invoked during these checks.

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
