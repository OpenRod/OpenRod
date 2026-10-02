<div align="center">

# 🎣 OpenRod

**A web console for [NVIDIA OpenShell](https://github.com/NVIDIA/OpenShell).**
Create sandboxes, edit policy, and open agent sessions from one place, running on your own machine.

[![CI](https://github.com/OpenRod/OpenRod/actions/workflows/ci.yml/badge.svg)](https://github.com/OpenRod/OpenRod/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/openrod)](https://www.npmjs.com/package/openrod)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

[Quick start](#-quick-start) · [Remote hosts](docs/remote-hosts.md) · [Security](#-security) · [Development](#-development)

</div>

---

## ✨ What you can do

| | |
| --- | --- |
| 📦 **Sandboxes & templates** | Create, manage and build image templates |
| 💻 **Agent sessions** | Open in the browser, your terminal, VS Code or Cursor |
| 🛡️ **Network policy** | Edit egress rules and policy templates |
| 🔌 **MCP servers & Skills** | Bring your own into any sandbox |
| 📜 **Activity** | Review what happened inside a sandbox |
| 🌐 **Remote hosts** | Run a persistent gateway on a Linux box over SSH, so work continues while your laptop sleeps |

---

## 🚀 Quick start

**You'll need**

- Node.js **22.13+**
- macOS (Apple Silicon) or Linux
- OpenShell **0.1.2** with a local gateway
- OpenSSH and OpenSSL

**1. Install OpenShell** (pinned to the supported release)

```bash
curl -LsSf https://raw.githubusercontent.com/NVIDIA/OpenShell/main/install.sh | OPENSHELL_VERSION=v0.1.2 sh
```

**2. Run OpenRod**

```bash
npx openrod --open
```

**3. Open the link it prints**

```text
OpenRod console (open this link): http://127.0.0.1:4600/?token=<secret>
```

**4. Connect your gateway.** Go to **Sandboxes → New sandbox → This computer**, and you're in.

> [!WARNING]
> Treat that link like a password. Anyone who has it while OpenRod is running can use your gateway credentials.

<details>
<summary><b>CLI options & install globally</b></summary>

```bash
npm install -g openrod
openrod --open
```

```text
--port <number>  HTTP port, 1–65535 (default: 4600)
--host <host>    Loopback only: 127.0.0.1 (default), localhost, or ::1
--open           Open the console in your default browser
--no-open        Do not open a browser (default)
--help, -h       Show help
--version, -v    Show the installed version
```

If `openshell` isn't on your `PATH`, set `OPENSHELL_BIN` to its full path. Gateway registrations are read from `~/.config/openshell/gateways/<name>/` (only HTTPS/mTLS); you never paste keys into the browser.

</details>

<details>
<summary><b>How the token link works</b></summary>

Every start generates a new random secret. The page stores it in an HttpOnly cookie and reloads without the token in the URL, so a bookmark of `http://127.0.0.1:4600/` keeps working until the console restarts. After a restart, or in another browser, copy the new link from your terminal.

</details>

---

## 🧭 Opening a sandbox

| Open in | How it works |
| --- | --- |
| **Browser** | xterm.js session in a new tab |
| **Terminal** | macOS Terminal or Linux `x-terminal-emulator` over SSH, a new session, or attach |
| **VS Code** | Requires **VS Code Server** to be chosen at creation |
| **Cursor** | Shown when Cursor is one of the sandbox's agents |

Details: [docs/opening-sandboxes.md](docs/opening-sandboxes.md)

---

## 🌐 Remote SSH hosts

Run a persistent second gateway in Docker on a Linux machine you reach over SSH. Your local gateway is never reconfigured.

1. **New sandbox → Where should it run? → Remote machine**
2. Pick an SSH alias and click **Connect**
3. Sandboxes and templates now show **Local** and **SSH · host-alias** side by side

**Needs:** a `Host` alias in `~/.ssh/config`, a Linux amd64/arm64 host with rootful Docker, and Python 3.

📖 Full guide, offline runtime upload and reconnecting: [docs/remote-hosts.md](docs/remote-hosts.md)

---

## 🛠️ Troubleshooting

| Symptom | Fix |
| --- | --- |
| No SSH hosts | Add a concrete `Host my-host` entry to `~/.ssh/config`, then refresh |
| Host key or auth rejected | Run `ssh my-host` yourself and verify the host |
| Docker missing or inaccessible | Install Docker Engine and grant the SSH user socket access |
| Local gateway missing | Start and register it with the OpenShell CLI (HTTPS/mTLS only) |
| Sandbox not Ready | Inspect its conditions in the console |

More: [docs/remote-hosts.md#troubleshooting](docs/remote-hosts.md#troubleshooting)

---

## 💾 What gets saved

OpenRod keeps config in `~/.config/openshell` and state in `~/.local/state/openshell-console`. Activity history and webhook credentials are **not encrypted**.

📖 Full list of files and effects: [docs/data-and-state.md](docs/data-and-state.md)

---

## 🔒 Security

- **Your authority, your machine.** OpenRod can do whatever your gateway credentials allow. Keys stay on the server and never reach the browser.
- **Loopback only.** No login and no multi-user support. Don't proxy it or expose it on a LAN.
- **Per-launch token.** Every request, stream and WebSocket needs the HttpOnly cookie.
- **Local data is not a vault.** Protect your disk and backups.

Full threat model and vulnerability reporting: [SECURITY.md](SECURITY.md)

---

## 🧑‍💻 Development

```bash
cd ui
npm ci
npm run dev     # Vite dev server
npm test        # server and library tests
npm run build   # production frontend
```

See [CONTRIBUTING.md](CONTRIBUTING.md) · [ui/README.md](ui/README.md) · [ui/SETUPS.md](ui/SETUPS.md)

---

<div align="center">

[Apache-2.0](LICENSE) · Third-party notices in [ui/THIRD_PARTY_NOTICES.md](ui/THIRD_PARTY_NOTICES.md)

<sub>OpenRod is an independent community project, not affiliated with, endorsed by, or supported by NVIDIA. NVIDIA and OpenShell are trademarks of NVIDIA Corporation.</sub>

</div>
