# Contributing

Contributions are accepted under the project's Apache-2.0 license. Do not include credentials, real policy data, runtime databases, or unlicensed assets in pull requests.

## Local development

```bash
cd ui
npm ci
npm run dev
```

Node.js 22.13+ is required for the SQLite-backed activity archive. Use the [SSH connection path](README.md#set-up-a-connection): OpenShell CLI/gateway 0.1.2, OpenSSH and OpenSSL locally, and a trusted native Linux/rootful Docker host for remote compute. Use disposable gateway state and an approved host for mutation checks.

First-run development is intentionally unconfigured. A CLI active-gateway suggestion alone must not activate collection. **Connect machine → Connect** selects a local gateway or probes an SSH alias; missing runtime images download automatically by default, with an explicit package-upload alternative. Never reconfigure the original local gateway, install Docker with automatic privilege escalation, or accept TLS keys through browser forms.

## Verification

```bash
cd ui
node --test server/*.test.js src/lib/*.test.js
npm run build
npm run start:local -- --port 4601 --no-open
```

Tests must be deterministic and isolate local files and gateway context. Keep behavioral regressions for context isolation, stale requests, credential separation, SSH configuration, process cleanup, installation consent and upload boundaries. Do not substitute mocked SSH success for a real remote-sandbox smoke.

For onboarding or connection changes, verify against a real, administrator-approved gateway:

1. Start with an isolated `XDG_CONFIG_HOME` and `OPENSHELL_CONSOLE_DATA_DIR`, no saved console selection, and no `OPENSHELL_GATEWAY`/`OPENSHELL_WORKSPACE` pins. Registrations live in `$XDG_CONFIG_HOME/openshell/gateways/`. Confirm a CLI active-gateway suggestion alone does not connect or start collectors, delivery workers, deadline enforcement, or policy reconciliation.
2. Open **Connect machine** beside **New sandbox** (also available before activation or while reading connection settings). Confirm no sidebar connection-setup block remains. Check empty/missing SSH configuration, Include aliases, missing local tools, key/host verification errors, and explicit refresh. Merely listing hosts must not open SSH sessions or create gateway state.
3. Connect an approved Linux Docker host. Exercise both runtime installation choices, failed/incomplete upload, wrong platform/version, and shutdown during an operation. Confirm a separate loopback gateway/database is created, the original gateway is unchanged, and TLS verification remains enabled. Use `openshell-gateway config preflight --path ...` against generated configuration.
4. Connect locally and remotely. Confirm automatic workspace selection reuses an accessible saved workspace, otherwise prefers `default`, then the first accessible workspace; no workspace chooser is shown. Confirm owner-only `console-context.json`, context-scoped collection, and job polling after activation changes the context. Test environment pins, explicit SSH reconnection after restart, remote disconnect, and retained per-engine state.
5. Open a Ready sandbox in the browser terminal and execute `hostname` and `pwd`. Then click **SSH shell → Open SSH in terminal**, execute the same commands through real OpenSSH, exit, and check temporary-config cleanup and that `~/.ssh/config` was not changed. The SDK browser terminal is not evidence of SSH.
6. Switch contexts while a session is live: it must never retarget another same-named sandbox. Disconnecting its managed gateway may interrupt it. Verify SSH loss stops the owned gateway, failed connections do not report Ready, and stopped sandboxes cannot launch sessions.
7. In the disposable context, verify disclosed persistent behavior: collection stops for the old context on a switch, configured deliveries can keep their original target, configured service deadlines retain their original context, and organization reconciliation stays off unless `OPENSHELL_CONSOLE_SWEEP=1`, then remains bound to the startup context. Never configure a real recipient or remote policy merely to exercise setup.

Do not remove or modify an operator's real config to simulate first run. The [local-state reference](ui/README.md#console-data-directory) lists files that must remain separate from a contributor's fixtures. Keep browser screenshots and failure reports free of TLS keys, provider credentials, and real activity evidence.

AWS checks incur costs and must use isolated resources. CI never provisions a cluster automatically.

## Packaging and release

1. Update the version in `ui/package.json`, its lockfile, and the changelog.
2. Run the checks above on macOS and Linux. Review the package's SDK version and compatibility claims.
3. Build and pack locally: `cd ui && npm pack` (`prepack` builds the frontend). The current install path is source or this locally built tarball, not an assumed published npm package.
4. Inspect the tarball. It must include the built frontend, production server, SDK, required runtime dependencies, licenses, and third-party notices. It must not contain credentials, checkout policies, runtime databases, tests, or the Vite development server.
5. Install the tarball into an isolated prefix and run its `openshell-console` executable. Verify unconfigured startup and host discovery before activating a gateway. Then check static assets, API, SSE, browser terminal, native SSH, stale-context refusal, restart/persistence disclosure, and graceful SIGTERM.
6. Review dependency/font/asset licensing. `ui/THIRD_PARTY_NOTICES.md` contains installed dependency license texts; refresh it when bundled libraries or fonts change. Preserve the SDK archive's upstream copyright notice in `ui/vendor/OPENSHELL-LICENSE`.
7. A maintainer can create the release tag and publish the verified package using an account authorized for the chosen npm name. CI uploads package artifacts but does not publish automatically. Verify package-name ownership and repository visibility before publishing.

No committed deployment configuration should expose an unauthenticated OpenShell gateway. Public Kubernetes gateways need their upstream user-authentication and authorization setup; the private port-forward evaluation is not production ingress.
