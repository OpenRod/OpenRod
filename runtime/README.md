# VM localhost resolution

`openshell-v0.1.2-loopback.patch` fixes VM guest provisioning in NVIDIA OpenShell
v0.1.2 (source commit `6648bd0c290efbc41ba131ee9831ee45cd431f94`). It is a runtime
patch, independent of this console, the selected agent, and the host OS.

The VM driver exports local Docker images using a temporary container. Docker
can replace `/etc/hosts` with an empty file during that export, including when
the image contains a valid hosts file. Guest startup configures a DNS relay at
`127.0.0.53`, but previously did not restore localhost mappings. Agents opening
a listener on `localhost` could fail before sign-in.

The patch reconciles `/etc/hosts` after mounting the workload image on every VM
boot. It maps `localhost` to `127.0.0.1` and `::1`, preserves unrelated aliases,
removes conflicting localhost aliases, and leaves the file owned by guest root
with mode 0644. Image-supplied symlinks are replaced without reading their
targets. Network policies and DNS relay configuration are unchanged.

## Build and distribute

Apply the patch to the pinned upstream checkout:

```sh
git apply /path/to/openshell-viewer/runtime/openshell-v0.1.2-loopback.patch
```

Follow the upstream VM build instructions to prepare matching runtime artifacts
(`mise run vm:setup` and `mise run vm:supervisor`), then build the driver:

```sh
OPENSHELL_VM_RUNTIME_COMPRESSED_DIR="$PWD/target/vm-runtime-compressed" \
  cargo build --release --locked -p openshell-driver-vm --bin openshell-driver-vm
```

On macOS, sign the resulting driver with the upstream Hypervisor entitlement:

```sh
codesign --force --sign - \
  --entitlements crates/openshell-driver-vm/entitlements.plist \
  target/release/openshell-driver-vm
```

Install the binary in an operator-owned directory and set `driver_dir` under
`[openshell.drivers.vm]` in the gateway configuration to that directory. Restart
the gateway, then stop/start existing sandboxes so their boot sequence runs.
Do not delete or recreate existing sandboxes: stop/start preserves their disks.

The startup script participates in the bootstrap image cache identity, so a
patched driver builds a new bootstrap instead of reusing the old script.
Distribute the patched driver for each gateway platform; publishing only the
console does not update remote gateways or other users' installed drivers.
This patch has not been released by NVIDIA.

## Verification

The patch includes a Linux regression script covering missing/empty hosts files,
custom aliases, conflicting localhost addresses, repeat boots, symlink targets,
and invalid directory destinations:

```sh
bash crates/openshell-driver-vm/scripts/test-loopback-hosts.sh
```

Run the VM driver unit tests with the same runtime bundle. For end-to-end
verification, start a sandbox from an unmodified Antigravity image, check
`getent hosts localhost`, and launch `agy`. Repeat after stop/start. No internet
allow rule for localhost should be added.
