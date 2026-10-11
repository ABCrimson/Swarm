# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.13.x  | :white_check_mark: |
| < 0.13  | :x:                |

## Reporting a Vulnerability

If you discover a security vulnerability in SWARM Orchestrator, please report it responsibly.

> [!IMPORTANT]
> **Do NOT open a public issue.**

Instead, please use [GitHub Security Advisories](https://github.com/ABCrimson/Swarm/security/advisories/new) or email security@crimson.dev. Include:

1. Description of the vulnerability
2. Steps to reproduce
3. Potential impact
4. Suggested fix (if any)

We will acknowledge receipt within 48 hours and provide a detailed response within 7 days.

## Security Measures

### Desktop app

- **IPC commands validate their input at the boundary.** Both shells dispatch through one shared command registry (`swarm_core::commands::Registry`): arguments must be a JSON object, identifiers parse as UUIDs, and required fields are checked before a handler runs.
- **Every app command has its own ACL entry.** `src-tauri/build.rs` generates an `allow-<command>`/`deny-<command>` permission for each name in `src-tauri/src/commands/command_list.rs` (the list the `commands!` forwarders are declared from), and `src-tauri/capabilities/default.json` grants the webview exactly those `allow-*` entries. Tauri rejects an invoke of a command the capability does not grant before it reaches the registry. `src-tauri/src/capability_contract.rs` (`app_commands_are_granted_one_by_one`) keeps the grants and the command list identical.
- **The Content Security Policy is set in `src-tauri/tauri.conf.json`:** `default-src 'self'`, `script-src 'self'` (no inline script, no `eval`), `object-src 'none'`, `connect-src` limited to `ipc:`, `http://ipc.localhost` and `https://api.anthropic.com`. `style-src` does allow `'unsafe-inline'`, because xterm.js (its renderers and scrollbar theme) and sonner (toast styles) insert `<style>` elements at runtime; scripts stay locked down.
- **File access carries no static allow scope.** The capability grants only `fs:allow-read-file`, `fs:allow-read-dir`, `fs:allow-exists`, `fs:allow-stat` and `fs:allow-write-file`; every other fs command is off because Tauri denies what a capability does not grant. `fs:deny-default` additionally denies the webview's own data directories. A path becomes reachable only when the user picks it in an open or save dialog, which grants it for the session. `fs:scope` denies `$APPDATA/**` and the credential stores (`~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.azure`, `~/.kube`, `~/.docker`, `~/.config/gh`, `~/.claude`, `~/.codex`, `~/.git-credentials`, `~/.netrc`) even inside a grant. No mkdir, remove or rename permission is granted. `src-tauri/src/capability_contract.rs` pins this capability file in a test.
- **Webview AI tools need your approval.** The built-in tools that act on your machine (`run_command`, `spawn_worker`, `kill_worker`, `write_file`, `read_file`) wait for Allow Once, Allow For Session or Deny before they run. The gate sits inside each tool's own `execute` (`src/lib/tools.ts`), so the registry, the chat loop and tests all go through it, and an input that fails validation never reaches a prompt. A session grant is keyed by tool, worker and exact argument (the full command string, the path exactly as the model wrote it, the worker name): it auto-approves only an identical later call, never another pending one, and `write_file` never gets one. Stopping a turn or killing its worker denies the turn's pending tool calls. The prompt (`ToolApprovalPrompt`) shows the tool name and every field of the validated input as data, not prose: backslashes are doubled, newline, carriage return and tab appear as `\n`, `\r`, `\t`, and every other control, bidi and zero-width character as `\uXXXX`, non-string values as canonical JSON, and `write_file` adds the content size. All of that escaping lives in one module, `src/lib/display-escape.ts` (`escapeForDisplay`), which every other user-visible path or name (the file viewer's header and tooltip, the ship preview, the agent permission row) goes through too. A value over 500 characters is cut with a "… N more characters" count, Allow stays disabled until each cut value has been expanded once, and commands and paths are never cut. `get_metrics` and custom tools (sandboxed Blob Workers with no backend access) have no side effect to approve.
- **`read_file` and `write_file` are confined by the backend, whatever the model asks.** Paths must be absolute and are canonicalized (symlinks resolved; an existing write target is resolved too, which expands Windows 8.3 short names) before the scope check: reads may touch the app data and home directories, writes only the app data directory and `~/.swarm`. A deny list over the canonical path, compared case-insensitively, refuses `swarm-config.json` (it holds the Anthropic API key), `daemon-token`, their backup and temp forms (`swarm-config.json.corrupt-<ms>`, `.daemon-token.<rand>`) and `~/.ssh`, `~/.gnupg` and `~/.aws`. On Windows a write is also refused when the file name contains `:` (an NTFS alternate data stream), ends in `.` or a space, or is a reserved device name (`CON`, `PRN`, `AUX`, `NUL`, `COM1`-`COM9`, `LPT1`-`LPT9`, and the superscript forms `COM¹`-`COM³` and `LPT¹`-`LPT³`, with or without an extension). A hard link to a secret is not detected.
- **The opener plugin is scoped.** URLs open only for GitHub compare pages (`https://*/*/*/compare/*`), and paths only under `~/.swarm/worktrees/`.
- **The webview AI chat holds the Anthropic API key.** The key lives in `swarm-config.json` in the app data directory (owner-only mode on Unix), and the webview calls `api.anthropic.com` directly. Nothing in `swarm-core` formats a config value into a log line or an error message. Git output that reaches events or commit messages passes through secret redaction first.
- **Update signatures are enforced.** An Ed25519 (minisign) keypair signs every updater artifact; the public key is in `src-tauri/tauri.conf.json` under `plugins.updater.pubkey`, and the private key is not committed (see [`docs/updater-keys.md`](docs/updater-keys.md)). `requireSignedVersion` is on, so a signature must also bind the version `latest.json` announces. A test in `src-tauri/src/config_contract.rs` keeps the flag on.
- **CI signs and verifies releases.** `.github/workflows/release.yml` passes `TAURI_SIGNING_PRIVATE_KEY` (and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, if set) to `tauri-apps/tauri-action` as GitHub Actions secrets, attests every artifact, and its `verify-updater-manifest` job checks each manifest entry's signature, signed version and attestation before a human publishes the draft release.
- **Dependencies are gated.** Every pin is exact, a version must be 24 hours old before it resolves (`minimumReleaseAge`), except the same-day pins listed one by one in `minimumReleaseAgeExclude` (pruned automatically once the lockfile no longer resolves them), `trustPolicy: no-downgrade` refuses a package that lost its provenance, `cargo deny` checks the Rust tree, and GitHub Actions are pinned by commit SHA.
- No `eval()` or `new Function()` in application code.

### Headless daemon (`swarmd`)

- **Every request is authenticated.** A 256-bit bearer token (`<data dir>/daemon-token`, created private and compared in constant time) is required; there is no unauthenticated mode.
- **Loopback by default** (`127.0.0.1:8787`). Binding a non-loopback address is refused until a loopback run has minted the token.
- **`Host` and `Origin` are allow-listed on every request** (DNS-rebinding defense); extra names need `--allow-host`.
- **Remote clients are narrower than the desktop webview.** Commands that read or write the daemon host's files are not reachable remotely, and config keys that look like secrets cannot be read or written over the wire. An authenticated client can still spawn workers, which run commands as the daemon's user: treat the token like a shell login.
- **`--serve-ui` responses carry a CSP** (`default-src 'self'`, `style-src-elem 'self' 'unsafe-inline'`, `connect-src 'self'`, `frame-ancestors 'none'`), `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, and `Cross-Origin-Opener-Policy` / `Cross-Origin-Resource-Policy: same-origin`.

## Known Gaps / In Progress

- **The in-app updater only checks.** `check_for_updates` asks the endpoint whether a newer release exists and never downloads or installs it, so the signature and signed-version checks on download have not yet been exercised by a real in-app update. Releases (v0.13.0, v0.13.1) are signed and their `latest.json` is verified per release in CI; installing a new version means downloading it from the release page.
- **An approved `run_command` runs with your privileges.** Approval shows the exact command, but the command is not sandboxed: Allow For Session lets the same command on the same worker run again without a prompt.
