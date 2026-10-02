# Contributing

OpenRod takes **issues from everyone** and **pull requests only from the OpenRod team** for now. Pull requests from outside the team are closed automatically; please [open an issue](https://github.com/OpenRod/OpenRod/issues/new/choose) instead.

Thanks for helping improve OpenRod. Bug reports, fixes and focused features are welcome; for larger changes, open an issue first to agree on the approach.

## License and sign-off

OpenRod is licensed under the [Apache License 2.0](LICENSE). Contributions are accepted under the same license (inbound = outbound): by submitting a pull request you agree that your contribution is licensed under Apache-2.0.

Every commit must carry a [Developer Certificate of Origin](https://developercertificate.org/) sign-off, certifying that you wrote the change or otherwise have the right to submit it under the project's license. Add it with `git commit -s`, which appends:

```text
Signed-off-by: Your Name <you@example.com>
```

Use your real name and an email you can be reached at. To sign off commits you already made, run `git rebase --signoff main` (or `git commit --amend -s` for the last commit) and force-push your branch.

Do not include credentials, real policy data, runtime databases, or unlicensed assets in pull requests. Report security issues privately as described in [SECURITY.md](SECURITY.md), not in issues or pull requests.

## Local development

```bash
cd ui
npm ci
npm run dev
```

Node.js 22.13+ is required for the SQLite-backed activity archive. See [Prerequisites](README.md#prerequisites): OpenShell CLI/gateway 0.1.2, OpenSSH and OpenSSL locally, and a trusted native Linux/rootful Docker host for remote compute. Use disposable gateway state and an approved host for mutation checks.

First-run development is intentionally unconfigured. A CLI active-gateway suggestion alone must not activate collection. **New sandbox → Where should it run?** selects the local gateway (**This computer**) or probes an SSH alias (**Remote machine**); missing runtime images are downloaded on the host or uploaded as a package. Never reconfigure the original local gateway, install Docker with automatic privilege escalation, or accept TLS keys through browser forms.

## Verification

```bash
cd ui
npm test
npm run build
npm run start:local -- --port 4601 --no-open
```

Tests must be deterministic and isolate local files and gateway context. Keep behavioral regressions for context isolation, stale requests, credential separation, SSH configuration, process cleanup, installation consent and upload boundaries. Do not substitute mocked SSH success for a real remote-sandbox smoke.

For onboarding or connection changes, verify against a real, administrator-approved gateway:

1. Start with an isolated `XDG_CONFIG_HOME` and `OPENSHELL_CONSOLE_DATA_DIR`, no saved console selection, and no `OPENSHELL_GATEWAY`/`OPENSHELL_WORKSPACE` pins. Registrations live in `$XDG_CONFIG_HOME/openshell/gateways/`. Confirm a CLI active-gateway suggestion alone does not connect or start collectors, delivery workers, deadline enforcement, or policy reconciliation.
2. Open **New sandbox → Where should it run?** before and after activation. Check empty/missing SSH configuration, Include aliases, missing local tools, key/host verification errors, and explicit refresh. Merely listing hosts must not open SSH sessions or create gateway state.
3. Connect an approved Linux Docker host. Exercise both runtime installation choices, failed/incomplete upload, wrong platform/version, and shutdown during an operation. Confirm a persistent Docker gateway/database is created on remote loopback, the original gateway is unchanged, and TLS verification remains enabled. Use `openshell-gateway config preflight --path ...` against generated configuration.
4. Connect locally and remotely. Confirm automatic workspace selection reuses an accessible saved workspace, otherwise prefers `default`, then the first accessible workspace; no workspace chooser is shown. Confirm owner-only `console-context.json`, context-scoped collection, and job polling after activation changes the context. Test environment pins, explicit SSH reconnection after restart, remote disconnect, and retained per-engine state.
5. Open a Ready sandbox in the browser terminal and execute `hostname` and `pwd`. Then choose **Connection options → SSH shell** and click **Open in → Terminal**, execute the same commands through real OpenSSH, exit, and check temporary-config cleanup and that `~/.ssh/config` was not changed. The SDK browser terminal is not evidence of SSH.
6. Switch contexts while a session is live: it must never retarget another same-named sandbox. Disconnecting the viewer detaches remote tmux sessions; local interactive exec keeps its previous lifecycle. Verify SSH loss closes only the local viewer transport and a tmux worker continues producing remote output, failed connections do not report Ready, and stopped sandboxes cannot launch sessions.
7. In the disposable context, verify disclosed persistent behavior: collection stops for the old context on a switch, configured deliveries can keep their original target, configured service deadlines retain their original context, and organization reconciliation stays off unless `OPENSHELL_CONSOLE_SWEEP=1`, then remains bound to the startup context. Never configure a real recipient or remote policy merely to exercise setup.

Do not remove or modify an operator's real config to simulate first run. The [local-state reference](ui/README.md#console-data-directory) lists files that must remain separate from a contributor's fixtures. Keep browser screenshots and failure reports free of TLS keys, provider credentials, and real activity evidence.

## Packaging and release

1. Update the version in `ui/package.json`, its lockfile, and the changelog.
2. Run the checks above on macOS and Linux. Review the package's SDK version and compatibility claims.
3. Build and pack locally: `cd ui && npm pack` (`prepack` builds the frontend).
4. Inspect the tarball. It must include the built frontend, production server, SDK, required runtime dependencies, licenses, and third-party notices. It must not contain credentials, checkout policies, runtime databases, tests, or the Vite development server.
5. Install the tarball into an isolated prefix and run its `openrod` executable. Verify unconfigured startup and host discovery before activating a gateway. Then check static assets, API, SSE, browser terminal, native SSH, stale-context refusal, restart/persistence disclosure, and graceful SIGTERM.
6. Review dependency/font/asset licensing. `ui/THIRD_PARTY_NOTICES.md` contains installed dependency license texts; refresh it when bundled libraries or fonts change. Preserve the SDK archive's upstream copyright notice in `ui/vendor/OPENSHELL-LICENSE`.
7. A maintainer pushes a `vX.Y.Z` tag matching the `ui/package.json` version. [`release.yml`](.github/workflows/release.yml) runs the tests, publishes to npm with provenance through npm trusted publishing (gated by the `npm` GitHub environment), and creates the GitHub release.
