# The `swarmd` Daemon

> Running SWARM Orchestrator headless -- as a per-user background program, reachable over an authenticated WebSocket instead of the desktop webview.

---

## Table of Contents

- [What `swarmd` Is](#what-swarmd-is)
- [Getting the Binary](#getting-the-binary)
- [Quick Start (Loopback)](#quick-start-loopback)
- [What the Browser Build Offers](#what-the-browser-build-offers)
- [Command Line](#command-line)
- [Installing as a User Service](#installing-as-a-user-service)
  - [Linux (systemd)](#linux-systemd)
  - [macOS (launchd)](#macos-launchd)
  - [Windows (Scheduled Task)](#windows-scheduled-task)
- [Retrieving the Connect URL](#retrieving-the-connect-url)
- [Reaching the Daemon Off-Box](#reaching-the-daemon-off-box)
- [Security Model](#security-model)
- [Running and Stopping](#running-and-stopping)
- [Uninstalling](#uninstalling)

---

## What `swarmd` Is

`swarmd` runs the exact same `swarm_core::runtime::Runtime` the desktop shell does -- worker registry, session manager, the single ordered event log, the agent scheduler -- with **no webview and no `tauri` link-time dependency**. It serves the 36 registry commands and the event stream over an authenticated WebSocket (`crates/swarmd/src/ws.rs`) instead of Tauri IPC; the frame-by-frame contract is in [API Reference: Wire Protocol](api.md#wire-protocol-swarmd). A remote client reattaches by replaying the log from a sequence number, so a reconnect resumes exactly where it left off, even across a daemon restart. A ship commit or push keeps running when the browser's connection drops, and its outcome reaches the browser through the replayed log.

It is a **per-user** program, not a system daemon: it runs worker agents as you, reads and writes your app-data directory under your home, and shells out to `git` against your repositories and worktrees. Every install path below registers it as a **user** service (systemd `--user`, a launchd LaunchAgent, a per-user logon Scheduled Task) running **non-elevated**. Running it as root / SYSTEM would break that ownership model and needlessly widen its blast radius.

It uses the **same data directory as the desktop app** (`dev.crimson.swarm-orchestrator` under your platform's app-data location), so the two share one event log, config and session set. A single-instance lock (`daemon.lock`) lets only one of them run against that directory at a time: whichever starts second refuses to start and says which shell holds it (`swarmd` exits with status 75; the desktop app shows a dialog and exits with status 1). Stop the desktop app before starting the daemon, or point one of them at another directory with `--data-dir`.

## Getting the Binary

**From a release:** each tagged release attaches a `swarmd-<target>` binary (plus `.sha256` next to it) for four targets:

| Target | Asset |
|---|---|
| Windows (x86_64) | `swarmd-x86_64-pc-windows-msvc.exe` |
| macOS, Apple Silicon | `swarmd-aarch64-apple-darwin` |
| macOS, Intel | `swarmd-x86_64-apple-darwin` |
| Linux (x86_64, glibc) | `swarmd-x86_64-unknown-linux-gnu` |

Verify the checksum (`sha256sum -c swarmd-<target>.sha256`) and mark it executable (`chmod +x` on Unix). Each binary also carries a Sigstore build-provenance attestation; `gh attestation verify swarmd-<target> --repo ABCrimson/Swarm` checks it.

**From source** (from the repository root; `swarmd` is a member of the Cargo workspace):

```sh
cargo build -p swarmd --release
# binary at target/release/swarmd[.exe]
```

The toolchain is pinned by `rust-toolchain.toml`.

## Quick Start (Loopback)

Run it directly to confirm it works before installing a service:

```sh
swarmd                      # binds 127.0.0.1:8787 by default
```

On startup, **when stdout is a terminal**, it prints the connect URL, with the token in the URL **fragment** (never sent to the server, never logged by an intermediary):

```text
SWARM Daemon Listening On http://127.0.0.1:8787/#t=<token>
```

Anywhere else (a service manager, a redirect) it prints only the address and the command that produces the URL, so the token never reaches a log:

```text
SWARM Daemon Listening On http://127.0.0.1:8787/ (Run `swarmd connect-url` For The Connect URL)
```

To get a browser UI from the daemon itself, build the web bundle (`pnpm build:web`, output in `dist-web/`) and serve it with `--serve-ui dist-web`, then open the connect URL. Without `--serve-ui`, point any WebSocket client at `ws://127.0.0.1:8787/ws`. `Ctrl-C` stops it gracefully.

## What the Browser Build Offers

The page `--serve-ui` serves talks to the daemon over the WebSocket (`wsTransport`), not Tauri IPC, so it has no native dialogs, no filesystem plugin, no OS notifications and no updater, and no webview-direct Anthropic chat. The frontend reads that from the transport's capability flags (`hasCapability()` in `src/lib/tauri.ts`, fixed per build), or, for the opener and the plugin calls themselves, from `isTauri()`, and either hides a control or disables it with "Available In The Desktop App Only", rather than offering it and failing.

| Control | Desktop app | `--serve-ui` browser build |
| --- | --- | --- |
| Workspace page, Open Project (folder picker, file tree, file viewer) | Works | Button disabled, "Available In The Desktop App Only" |
| Graph Export / Import Workflow | Works | Hidden |
| Sessions: export (JSON, Markdown, metrics CSV), the card menu's Export As JSON, and Import | Work (native save and open dialogs) | Disabled, with "Available In The Desktop App Only" beside or under them |
| Sessions: delete | Native confirmation dialog | The browser's own confirmation dialog |
| Sessions: Snapshot button, the card menu's Save As Template, the palette's Snapshot Session (the `localStores` capability) | Work (plugin-store files) | Snapshot and Save As Template are disabled, with "Available In The Desktop App Only"; Snapshot Session is absent from the command palette |
| Sessions: the template picker's saved templates; automatic snapshots (the `localStores` capability, and the Tauri bridge for the store reads and writes) | Saved templates load from a plugin-store file; a snapshot of the active session is taken every Auto-Snapshot Interval | The picker shows "Available In The Desktop App Only" in place of saved templates (the built-in ones stay); automatic snapshots do not run, and Settings' Auto-Snapshot Interval is disabled with the same reason |
| Ship: Open Compare Page (receipt) | Opens the default browser through the opener plugin | Opens the compare page in a new browser tab (`window.open`); the "Commit + Push + Open Compare Page" action's post-ship auto-open runs only in the desktop app (where a failure shows the warning toast "Shipped, But Could Not Open The Compare Page: …"), so the browser build opens nothing on its own and shows no toast |
| Worker AI panel: webview chat, model selector, Inject Instruction, Queue | Works for workers without an agent session | Replaced by a notice, "Available In The Desktop App Only"; Claude Code and Codex workers chat as usual |
| Alert thresholds: OS notification mirror | Works when enabled in Settings | The in-app toast only |
| Settings: Check For Updates | Works | Button disabled, "Available In The Desktop App Only" beside it |
| Settings: Check For Updates On Launch, Native Alert Notifications toggles | Work | Toggles disabled, with "Available In The Desktop App Only" |
| Spawn dialog: Webview Anthropic provider, folder picker; the palette's Spawn Worker; applying a template that has workers (the `localAiChat` capability: these spawn webview workers) | Work; Webview Anthropic is the default provider | The provider and folder picker are disabled, with "Available In The Desktop App Only" (the dialog starts on Claude Code); Spawn Worker is absent from the command palette; template cards that have workers are disabled with the same reason, and `spawnWorkerFromSpec` and `applyTemplate` refuse with it |
| Settings, AI Connectivity: API Key field, Save API Key | Work | Both disabled, with "Available In The Desktop App Only"; the key is never read, because `swarmd` denies secret-shaped config keys to remote clients |
| Ship preview: summary Generate / Regenerate | Streams a draft from the webview to Anthropic | Disabled, with "Available In The Desktop App Only"; the summary text area stays editable |

The disabled Check For Updates button is what a browser-build user sees. `checkForUpdates()` itself rejects with "Update Checks Need The Desktop App" when the transport has no updater or there is no Tauri bridge (for example a plain-browser preview of the desktop build, where the button stays enabled and the failure toast, "Update Check Failed", carries that text), so a check that did not run never reads as "up to date".

## Command Line

```text
swarmd [OPTIONS]
swarmd connect-url [--bind ADDR] [--data-dir PATH]
```

| Option | Meaning |
|---|---|
| `--bind ADDR` | Listen address, default `127.0.0.1:8787`. A non-loopback address needs a token minted by an earlier loopback run (see [Reaching the Daemon Off-Box](#reaching-the-daemon-off-box)). |
| `--data-dir PATH` | Data directory, default the desktop app's: `%APPDATA%\dev.crimson.swarm-orchestrator` on Windows, `~/Library/Application Support/dev.crimson.swarm-orchestrator` on macOS, `$XDG_DATA_HOME/dev.crimson.swarm-orchestrator` (else `~/.local/share/...`) elsewhere. |
| `--serve-ui DIR` | Serve the `pnpm build:web` bundle in `DIR` at `/` (refused at startup if there is none). |
| `--allow-host NAME[:PORT]` | Also accept this name in the `Host` / `Origin` headers (a reverse proxy, a MagicDNS name). Repeatable. A name without a port matches any port. |
| `--log-file PATH` | Append logs to `PATH` (created private to you on Unix) instead of stderr. |
| `-h`, `--help` / `-V`, `--version` | Usage / version. |
| `connect-url` | Print the connect URL (it carries the token) and exit; fails if no token exists yet. |

Flags take their value as the next argument or inline (`--bind=ADDR`). `RUST_LOG` overrides the default log filter (`swarm_core=info,swarmd=info,warn`).

**Exit status:** `0` clean stop, `2` bad command line, `75` (`EX_TEMPFAIL`) another SWARM instance holds the data directory, `1` any other startup failure.

## Installing as a User Service

The `crates/swarmd/service/` directory holds ready-to-use unit files and install scripts. The scripts locate a `swarmd` binary (`$SWARMD_BIN`, a release asset or `swarmd` next to the script, the repository's `target/release`, or `PATH`), install it to a per-user location, and register the service. All are **idempotent** -- re-run to upgrade the binary or refresh the unit. On Linux and macOS the service gets the `PATH` of the shell that runs `install.sh`, so agent CLIs such as `claude` and `codex` are found; re-run it after installing new ones. On Windows the task runs with your logon environment, so a CLI added to your user PATH is found after you sign in again.

### Linux (systemd)

```sh
cd crates/swarmd/service
./install.sh
```

This copies `swarmd` to `~/.local/bin/` (`$SWARMD_BIN_DEST` overrides), installs `swarmd.service` to `~/.config/systemd/user/` with a drop-in (`swarmd.service.d/install.conf`) that sets `ExecStart` to the installed binary and `PATH` to yours, enables it and **restarts** it so a running daemon moves onto the new binary. The unit is `Type=exec`, restarts on failure after 5 s, gives up after 5 starts in 5 minutes, never restarts on exit status 75, and allows 180 s to stop (the worst-case graceful shutdown is about 52.5 s plus the event drain, which gives up at 120 s; see [Running and Stopping](#running-and-stopping)). It deliberately has no sandboxing directives: every worker terminal would inherit them. To start it at boot and keep it running after you log out:

```sh
sudo loginctl enable-linger "$USER"
```

### macOS (launchd)

```sh
cd crates/swarmd/service
./install.sh
```

This installs the binary, fills the absolute binary path, log directory and your `PATH` into `dev.crimson.swarmd.plist`, writes it to `~/Library/LaunchAgents/`, and `launchctl bootstrap`s it into your `gui/<uid>` domain. It is a **LaunchAgent** (per user), not a LaunchDaemon. launchd restarts it after a crash but not after a clean exit (`KeepAlive` / `SuccessfulExit` false), spaces retries a minute apart (`ThrottleInterval` 60), and allows 180 s between `SIGTERM` and `SIGKILL` (`ExitTimeOut`). Logs go to `~/Library/Logs/swarmd/swarmd.log`, a directory at mode `0700` -- never `/tmp`.

### Windows (Scheduled Task)

```powershell
cd crates\swarmd\service
.\install.ps1
```

**This is a per-user logon Scheduled Task, not a Windows service.** The script installs `swarmd.exe` under `%LOCALAPPDATA%\Programs\swarmd` and registers a task, *"SWARM Daemon (swarmd)"*, with an at-logon trigger for your account, the *Interactive* logon type and run level *Limited* (non-elevated). It runs hidden (through `conhost.exe --headless`) in your interactive session, with no execution time limit and normal priority, and the scheduler restarts it up to 3 times, one minute apart, if it fails. `swarmd` writes its own log, `%APPDATA%\dev.crimson.swarm-orchestrator\swarmd.log` (`--log-file`).

What that means in practice:

- It **does not start before you log on**, and it runs only in your logon session. After a reboot, nothing runs until you sign in.
- It has **no Service Control Manager integration**: no boot-time start, no SCM recovery actions, no service account.
- It therefore **does not suit a headless Windows machine** that nobody logs on to interactively (for example one reached only over SSH): the daemon would never start there.

A real Windows service is not implemented; `install.ps1` is the only Windows installer today. Stop and start the task with `Stop-ScheduledTask` / `Start-ScheduledTask -TaskName 'SWARM Daemon (swarmd)'`.

## Retrieving the Connect URL

The token is minted on first run and stored in `<data-dir>/daemon-token`, created already private (mode `0600` on Unix; on Windows a DACL reduced to your account's SID): it is written to a `.daemon-token.<rand>` temporary file beside the final name and then linked into place without clobbering, so no reader sees a partial or world-readable token and two racing first runs converge on one. It is never written to a service log. Ask the binary for the URL instead, as the same user:

| Platform | Command |
| --- | --- |
| Linux | `~/.local/bin/swarmd connect-url` |
| macOS | `~/.local/bin/swarmd connect-url` |
| Windows | `& "$env:LOCALAPPDATA\Programs\swarmd\swarmd.exe" connect-url` |

Add `--bind ADDR` and `--data-dir PATH` if the daemon runs with non-default values. The install scripts print the exact command when they finish. The services' logs show the listen address and any warnings:

| Platform | Logs |
| --- | --- |
| Linux | `journalctl --user -u swarmd -f` |
| macOS | `tail -f ~/Library/Logs/swarmd/swarmd.log` |
| Windows | `Get-Content -Wait "$env:APPDATA\dev.crimson.swarm-orchestrator\swarmd.log"` |

## Reaching the Daemon Off-Box

By default every install binds **loopback only**, and `swarmd` **refuses** a non-loopback bind on a data directory that has never completed a loopback run -- there is no token yet to authenticate with. The check runs before anything could mint a token, so a refused run does not create the file that would let an identical second run through. Exposing it is a deliberate two-step:

1. **Establish the token.** Run once on loopback (any install above does this). This mints `<data-dir>/daemon-token`.
2. **Front it with transport security you control.** The token is the *only* authentication and the WebSocket is plain `ws://`; do not put `--bind 0.0.0.0:PORT` on the open internet. Reach it instead through an SSH tunnel (`ssh -L 8787:127.0.0.1:8787 host`, keeping the local port equal to the daemon's, or adding `--allow-host 127.0.0.1:<port>` for another one) or a reverse proxy that terminates TLS, forwards WebSocket upgrades and adds its own access control, started with `--allow-host proxy.example.com` so its `Host` / `Origin` are accepted. Binding a wildcard address works for LAN and tailnet clients: a request whose `Host` names the interface address it actually reached is accepted automatically. A non-loopback bind also hard-fails unless the data directory and the token file could be restricted to you.

The connect URL shows the bind address, or the loopback address (`127.0.0.1` / `[::1]`) for a wildcard bind. Replace the origin with the one your client reaches (`https://swarm.example.com/#t=<token>`).

## Security Model

- **Token in the URL fragment**, never a query parameter -- it is not sent to the server on the initial request and not captured by intervening proxies. The browser client moves it into `sessionStorage` and scrubs it from the address bar. A client that can send headers may use `Authorization: Bearer <token>` on the upgrade instead.
- **256-bit token, constant-time comparison**, minted with `getrandom`, validated on load (exactly 64 hex characters; a malformed file is an error, never silently replaced), permissions re-applied on every start. No unauthenticated mode exists.
- **Host and Origin checks on every request**, `/ws` and the static `--serve-ui` routes alike. WebSocket upgrades are exempt from CORS, and a DNS-rebinding page can reach a loopback daemon under an attacker's host name, so a `Host` (and `Origin`, when sent) that does not name the connection's own local address, a loopback spelling on a loopback connection, or an `--allow-host` entry gets a `403`.
- **Bounded admission**: 32 authenticated connections, a separate pool of 16 pending handshakes (4 per client address), `hello` within 5 s, 2 MiB per message, 8 concurrent `rpc` calls per connection. Unauthenticated sockets cannot take an authenticated client's slot.
- **`RemotePolicy` at the command boundary**: `read_file` / `write_file` are `Denied` over the wire and `read_config` / `write_config` are `SecretFiltered` (any key shaped like a credential is refused in both directions), so a remote client cannot exfiltrate the daemon token, API keys, or arbitrary files even though the command runs the same code the desktop shell does. See [API Reference: Who Can Call What](api.md#who-can-call-what).
- **The token and the API key are also off limits to the file commands locally.** `read_file` / `write_file` canonicalize the path and refuse `daemon-token`, its `.daemon-token.<rand>` temporary form and `swarm-config.json` (which holds the Anthropic API key) in the data directory, so even a local caller, such as an approved webview AI tool on the desktop sharing this data directory, cannot read or replace them through those commands. See [API Reference: File System Commands](api.md#file-system-commands).
- **The trust boundary it does not close**: an authenticated client can `spawn_worker` and `worker_input`, which is a shell as the daemon's user. Treat the token like an SSH private key.
- **Loopback-first, user-scoped, non-elevated** -- see above. The data directory is created (or tightened) to mode `0700` on Unix.

## Running and Stopping

`SIGINT` / `SIGTERM` (on Windows `Ctrl-C`, console close, logoff and shutdown) start a graceful shutdown: new connections stop, every client gets a `1001 Going Away` close, every worker is stopped the way `kill_worker` stops it (agent sessions shut down, worktrees get their usual disposition, except that a kill still waiting on an agent session's in-flight attach when the 40 s `STOP_WORKERS_TIMEOUT` expires is abandoned, leaving that worker and its worktree unreconciled; see [ADR-0040](adr/0040-kill-stops-the-session-first.md)), the event writer drains and records the exact head seq so the next start continues with no gap, and the data-directory lock is released. Apart from the event drain, the worst case is about 52.5 s: up to 5 s each for the HTTP and the WebSocket drain (`Limits::drain_timeout`), 40 s for the workers (the 30 s an agent adapter's handshake may still take, plus the session's teardown), and 2.5 s for any agent session still registered. The event drain has no timer, because every persistent event costs a disk flush ([ADR-0039](adr/0039-event-log-flushes-every-commit.md)) and a slow disk would turn a fixed budget into lost events: it waits until the writer has committed the last event accepted before the shutdown, so it lasts as long as that backlog's flushes (about 2 ms per persistent event on ext4, see [Event Log Persistence](performance.md#event-log-persistence)), and logs its progress every 5 s. Only a drain still running after 120 s (`DRAIN_CEILING`) gives up: it logs an error with the number of accepted events left unpersisted, and the next start skips to the seq reservation (a gap, never a reused seq). The systemd unit and the launchd plist wait 180 s before force-stopping: the 52.5 s before the drain plus its 120 s ceiling, with margin, so neither kills `swarmd` before it can log a drain that overran. The Windows Scheduled Task has no such window: `Stop-ScheduledTask` and `Stop-Process -Force` (what `install.ps1` and `uninstall.ps1` use) end the process without a graceful window (neither script waits for one: `install.ps1` and `uninstall.ps1` follow a hard stop with `WaitForExit(10000)`), so stopping the task is not a graceful shutdown.

To upgrade, re-run the install script; it replaces the binary and restarts the service. Uninstalling or upgrading never touches the data directory.

## Uninstalling

```sh
# Linux / macOS
./uninstall.sh                 # add --purge-binary to also remove the binary

# Windows
.\uninstall.ps1                # add -PurgeBinary to also remove the binary
```

Uninstalling removes the service (the systemd unit and drop-in, the LaunchAgent, or the Scheduled Task), stops the daemon, and (optionally) removes the binary. It **never** touches your SWARM data directory or event log.
