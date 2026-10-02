# Remote SSH hosts

← [Back to README](../README.md)

**New sandbox → Where should it run? → Remote machine** connects a Linux machine you reach over SSH. OpenRod runs a **persistent second OpenShell gateway** in Docker on that host, and shows its sandboxes and templates alongside your local ones. Your existing local gateway is never reconfigured.

## Requirements

- A concrete `Host` alias in `~/.ssh/config` (aliases in `Include` files are discovered too; wildcard patterns are not selectable) with trusted key-based access. SSH uses your configuration, keys, agent and jump hosts, with strict host-key verification; OpenRod never accepts unknown host keys or prompts for passwords.
- A native **Linux amd64/arm64 host with a running rootful Docker Engine** whose socket the SSH user can use without an interactive sudo prompt, plus Python 3. Docker Desktop, rootless Docker, and Docker contexts pointing at another machine are not supported. Docker socket access is effectively root on that host.
- An `openshell-gateway` 0.1.2 executable locally. If none is installed, OpenRod downloads the pinned [official release](https://github.com/NVIDIA/OpenShell/releases/tag/v0.1.2) for Apple Silicon macOS or arm64/x64 Linux, verifies its SHA-256 digest, and installs it under its private data directory (requires `tar`, no sudo).

## Steps

1. Click **New sandbox**, choose **Remote machine**, and pick an SSH alias. Listing hosts does not open SSH connections or install anything.
2. Click **Connect**. The host does not need OpenShell installed: OpenRod reuses matching runtime images and, if they are missing, offers **Download on host** or **Upload** of an offline `docker save` package (see below). If Docker itself is absent on Ubuntu or Debian with systemd, connection pauses for **Install Docker and continue** approval: this needs root or passwordless sudo, installs the distribution `docker.io` package, enables its service, and adds the SSH user to the root-equivalent `docker` group. Existing or broken Docker installations are never replaced or repaired; other distributions need manual setup. A failed installation can leave package, service, or group changes behind.
3. Once ready, **Sandboxes** and **Templates** show both locations, marked **Local** or **SSH · host-alias**. **New sandbox** chooses its location explicitly; **Use template** inherits the template's location. **Disconnect** in the sidebar closes the local SSH tunnels.

The remote gateway has its own database, certificates, providers and sandbox inventory. It runs with `--restart unless-stopped`, binds to remote loopback, and is reached only through SSH forwarding. Only one remote host is connected at a time. When a sandbox is created on the SSH host, your local network-policy templates, egress rules, MCPs & Skills, and Groups are offered as versioned snapshots; secret values, local sandbox memberships and sandbox-specific grants are not copied. **Build an image** for an SSH host builds with Docker on your computer for the host's architecture and loads the result over the SSH tunnel, so local Docker is needed only for image builds and upload packages.

## Uploading a runtime package

Use a trusted, uncompressed `docker save` archive containing the sandbox, supervisor, and gateway images for the version and architecture shown in the dialog. On a networked Docker computer, for an amd64 host and OpenShell 0.1.2:

```bash
docker pull --platform linux/amd64 ghcr.io/nvidia/openshell/sandbox:0.1.2
docker pull --platform linux/amd64 ghcr.io/nvidia/openshell/supervisor:0.1.2
docker pull --platform linux/amd64 ghcr.io/nvidia/openshell/gateway:0.1.2
docker save --output openshell-runtime-0.1.2-linux-amd64.tar \
  ghcr.io/nvidia/openshell/sandbox:0.1.2 \
  ghcr.io/nvidia/openshell/supervisor:0.1.2 \
  ghcr.io/nvidia/openshell/gateway:0.1.2
```

Use `linux/arm64` for an arm64 host. Select the resulting `.tar` with **Upload**. The console stages at most 4 GiB in a private temporary file, streams it to `docker load` over SSH, verifies the sandbox, supervisor and gateway tags/platforms, and removes the staged file. Gateway startup additionally verifies the gateway image against its pinned digest and platform. It does not execute an installer script from the archive. Remote download pulls the runtime images directly on the host.

Workload images are separate from these runtime images. **Build an image** uses Docker on your computer, targets the selected SSH host’s architecture, then automatically loads the result onto that host through its existing SSH tunnel. The console verifies the engine identity, image ID, and platform before registering the template in the originating gateway/workspace. Local Docker must be running and support the target architecture; no registry is required. **Use an existing image** instead checks the selected remote engine or pulls the reference there. Adding MCP/Skill bundles to an existing remote image imports its base locally under a temporary build-owned tag, without overwriting local user tags. Temporary archives are removed; published images remain on their engines until explicitly removed.

## Disconnecting and reconnecting

**Disconnect** closes the local SSH tunnels. Stopping the console server, shutting down your computer, or putting it to sleep does not stop the remote Docker gateway or persistent terminal sessions. Reconnect to the same SSH host and reopen the same terminal to reattach. The remote machine must remain running; an agent waiting for your input still waits. Stopping/deleting its sandbox or exiting the agent ends its work. Existing images must include `tmux`; console-built images include it automatically. Recreate older sandboxes through the console to receive the required `/dev/ptmx` and `/dev/pts` filesystem grants. MCP OAuth login terminals are short-lived and are not persistent agent sessions.

Gateway state is retained separately for each SSH alias/Docker-engine identity. Reconnecting to the same engine reuses its state and keys. Repointing an alias to a different engine does not reuse the old engine's sandbox records. An SSH failure is shown explicitly; no automatic reconnect or installation retry runs.

Your original local gateway continues independently. Selecting it does not stop an already-running remote gateway; use **Disconnect** when you want that remote connection closed. After a console restart, choose the SSH host and connect again to reattach to its running remote gateway.

## Troubleshooting

| Symptom | Next step |
| --- | --- |
| No SSH hosts | Add a concrete `Host my-host` entry to the console account's `~/.ssh/config`, then refresh. |
| Host key or authentication rejected | Run `ssh my-host` yourself, verify the host's identity, and configure a usable key or agent. The console does not accept unknown keys or prompt for passwords. |
| Docker missing or inaccessible | Install/start Docker Engine on the Linux host and grant the SSH user socket access. Docker access is effectively host-administrator authority. |
| Runtime still missing after upload | Supply both exact version tags for the detected architecture, using a trusted `docker save` archive. |
| SSH forwarding failed | Enable TCP and Unix-socket forwarding for this SSH account. Ensure the reported remote loopback port is not already in use. |
| Another console owns the connection | Disconnect or stop that console before connecting here. |
| Local gateway missing | Start and register your existing local gateway using the OpenShell CLI, then refresh. Only HTTPS/mTLS registrations are offered. |
| Gateway executable missing | Install `openshell-gateway` 0.1.2 locally and ensure it is on OpenRod's `PATH`, or let **Connect** download the pinned release. |
| Sandbox is not Ready | Inspect its conditions. A successful SSH/runtime connection does not prove a workload image or sandbox policy can start successfully. |
