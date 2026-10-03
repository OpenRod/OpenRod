# OpenRod

A web console for [NVIDIA OpenShell](https://github.com/NVIDIA/OpenShell). Create sandboxes, edit network policy, and open agent sessions from one place, running on your own machine.

## You'll need

- Node.js 22.13 or newer
- macOS (Apple Silicon) or Linux
- [OpenShell](https://github.com/NVIDIA/OpenShell) 0.1.2 with a local gateway
- Docker, running: [Docker Desktop](https://docs.docker.com/desktop/) on macOS (`brew install --cask docker-desktop`, then open it once) or [Docker Engine](https://docs.docker.com/engine/install/) on Linux. OpenRod builds sandbox images with it, including for Quick setup.
- OpenSSH and OpenSSL

Install OpenShell, pinned to the supported release:

```bash
curl -LsSf https://raw.githubusercontent.com/NVIDIA/OpenShell/main/install.sh | OPENSHELL_VERSION=v0.1.2 sh
```

## Run

```bash
npx openrod

# or install the openrod command globally
npm install -g openrod
openrod
```

On every start, OpenRod opens your browser on a link with a new secret token. Over SSH, or anywhere without a display, open the printed link yourself:

```text
OpenRod console (open this link): http://127.0.0.1:4600/?token=<secret>
```

Treat the link like a password: anyone who has it while OpenRod is running can use your gateway credentials. Then go to **Sandboxes → New sandbox → This computer** to connect your gateway.

### Options

```text
--port <port>  HTTP port from 1 to 65535 (default: 4600)
--host <host>  Loopback only: 127.0.0.1 (default), localhost, or ::1
--open         Always open the console in your default browser
--no-open      Only print the link (the default over SSH, in CI or without a display)
--help, -h     Show help
--version, -v  Show the installed version
```

If `openshell` isn't on your `PATH`, set `OPENSHELL_BIN` to its full path.

## Docs

- [README and quick start](https://github.com/OpenRod/OpenRod#readme)
- [Opening sandboxes](https://github.com/OpenRod/OpenRod/blob/main/docs/opening-sandboxes.md) · [Remote SSH hosts](https://github.com/OpenRod/OpenRod/blob/main/docs/remote-hosts.md) · [What gets saved](https://github.com/OpenRod/OpenRod/blob/main/docs/data-and-state.md)
- [Security](https://github.com/OpenRod/OpenRod/blob/main/SECURITY.md) · [Changelog](https://github.com/OpenRod/OpenRod/blob/main/CHANGELOG.md) · [Issues](https://github.com/OpenRod/OpenRod/issues)

## License

[Apache-2.0](https://github.com/OpenRod/OpenRod/blob/main/LICENSE) · Third-party notices in [THIRD_PARTY_NOTICES.md](https://github.com/OpenRod/OpenRod/blob/main/ui/THIRD_PARTY_NOTICES.md)

OpenRod is an independent community project, not affiliated with, endorsed by, or supported by NVIDIA. NVIDIA and OpenShell are trademarks of NVIDIA Corporation.
