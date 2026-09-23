# The `swarmd` Daemon

> Running SWARM Orchestrator headless — as a background service, reachable over an authenticated WebSocket instead of the desktop webview.

---

## Table of Contents

- [What `swarmd` Is](#what-swarmd-is)
- [Getting the Binary](#getting-the-binary)
- [Quick Start (Loopback)](#quick-start-loopback)
- [Installing as a User Service](#installing-as-a-user-service)
  - [Linux (systemd)](#linux-systemd)
  - [macOS (launchd)](#macos-launchd)
  - [Windows (Scheduled Task)](#windows-scheduled-task)
- [Retrieving the Connect Token](#retrieving-the-connect-token)
- [Reaching the Daemon Off-Box](#reaching-the-daemon-off-box)
- [Security Model](#security-model)
- [Uninstalling](#uninstalling)

---

## What `swarmd` Is

`swarmd` runs the exact same `swarm_core::runtime::Runtime` the desktop shell
does — worker registry, session manager, the single ordered event log, the
agent scheduler — with **no webview and no `tauri` link-time dependency**. It
serves the command surface and the event stream over an authenticated
WebSocket (see `crates/swarmd/src/ws.rs`) instead of Tauri IPC. A remote
client reattaches by replaying the log from a sequence number, so a
reconnect resumes exactly where it left off.

It is a **per-user** program, not a system daemon: it runs worker agents as
you, reads and writes your app-data directory under your home, and shells
out to `git` against your repositories and worktrees. Every install path
below registers it as a **user** service (systemd `--user`, a launchd
LaunchAgent, a per-user logon Scheduled Task) running **non-elevated**.
Running it as root / SYSTEM would break that ownership model and needlessly
widen its blast radius.

## Getting the Binary

**From a release:** each tagged release attaches a `swarmd-<target>` binary
(and a `.sha256` next to it) for all four platforms — Windows, macOS (Apple
Silicon and Intel), and Linux. Download the one for your target, verify the
checksum, and mark it executable (`chmod +x` on Unix).

**From source:**

```sh
cd src-tauri
cargo build -p swarmd --release
# binary at src-tauri/target/release/swarmd[.exe]
```

## Quick Start (Loopback)

Run it directly to confirm it works before installing a service:

```sh
swarmd                      # binds 127.0.0.1:8787 by default
```

On startup it prints the connect URL, with the token in the URL **fragment**
(never sent to the server, never logged by an intermediary):

```
SWARM Daemon Listening On http://127.0.0.1:8787/#t=<token>
```

Open that URL in a browser build, or point a WebSocket client at it. `Ctrl-C`
to stop. Flags: `--bind ADDR`, `--data-dir PATH`, `--serve-ui DIR`,
`--version`.

## Installing as a User Service

The `crates/swarmd/service/` directory holds ready-to-use unit files and
install scripts. The scripts locate a `swarmd` binary (next to the script, in
the repo `target/release`, on `PATH`, or via `$SWARMD_BIN`), install it to a
per-user location, and register the service. All are **idempotent** — re-run
to upgrade the binary or refresh the unit.

### Linux (systemd)

```sh
cd src-tauri/crates/swarmd/service
./install.sh
```

This copies `swarmd` to `~/.local/bin/`, installs `swarmd.service` to
`~/.config/systemd/user/`, and runs `systemctl --user enable --now swarmd`.
To keep it running after you log out (and start at boot):

```sh
sudo loginctl enable-linger "$USER"
```

### macOS (launchd)

```sh
cd src-tauri/crates/swarmd/service
./install.sh
```

This installs the binary, fills the absolute paths into
`dev.crimson.swarmd.plist`, writes it to `~/Library/LaunchAgents/`, and
`launchctl bootstrap`s it. Logs (which carry the connect token) are written
to `~/Library/Logs/` at mode `0700` — never `/tmp`.

### Windows (Scheduled Task)

```powershell
cd src-tauri\crates\swarmd\service
.\install.ps1
```

This installs `swarmd.exe` under `%LOCALAPPDATA%\Programs\swarmd` and
registers a logon Scheduled Task, *"SWARM Daemon (swarmd)"*, that runs in
your interactive session, **non-elevated**, restarting up to 3× on failure.
Output is redirected to a user-private log under `%APPDATA%`.

## Retrieving the Connect Token

The token is minted on first run and stored in `<data-dir>/daemon-token`
(permissions restricted to you). The connect URL — token included — is
printed at every startup, so read it from the service log:

| Platform | Command |
| --- | --- |
| Linux | `journalctl --user -u swarmd \| grep 'Listening On'` |
| macOS | `grep 'Listening On' ~/Library/Logs/swarmd.log` |
| Windows | `Select-String -Path "$env:APPDATA\dev.crimson.swarm-orchestrator\swarmd.log" -Pattern 'Listening On'` |

## Reaching the Daemon Off-Box

By default every install binds **loopback only**, and swarmd **refuses** a
non-loopback bind on a data directory that has never completed a loopback run
— there is no token yet to authenticate with. So exposing it is a deliberate
two-step:

1. **Establish the token.** Run once on loopback (any install above does
   this). This mints `<data-dir>/daemon-token`.
2. **Front it with transport security you control.** The token is the *only*
   authentication and the WebSocket is plain `ws://`; do not put
   `--bind 0.0.0.0:PORT` on the open internet. Reach it instead through an
   SSH tunnel (`ssh -L 8787:127.0.0.1:8787 host`) or a reverse proxy that
   terminates TLS and adds its own access control. Only bind non-loopback
   when the daemon token file's permissions could be restricted to you
   (swarmd hard-refuses otherwise, on exactly the runs that are reachable
   off-box).

## Security Model

- **Token in the URL fragment**, never a query parameter — it is not sent to
  the server on the initial request and not captured by intervening proxies.
- **Origin + Host checks** on the WebSocket upgrade, plus a single-instance
  advisory lock so two engines never share one data directory.
- **`RemotePolicy` at the command boundary**: `read_file`/`write_file` are
  `Denied` over the wire and `read_config`/`write_config` are
  `SecretFiltered`, so a remote client cannot exfiltrate the daemon token,
  API keys, or arbitrary files even though the command runs the same code
  the desktop shell does.
- **Loopback-first, user-scoped, non-elevated** — see above.

## Uninstalling

```sh
# Linux / macOS
./uninstall.sh                 # add --purge-binary to also remove the binary

# Windows
.\uninstall.ps1                # add -PurgeBinary to also remove the binary
```

Uninstalling removes the service and (optionally) the binary. It **never**
touches your SWARM data directory or event log.
