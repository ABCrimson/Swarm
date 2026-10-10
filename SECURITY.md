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
- **The Content Security Policy is set in `src-tauri/tauri.conf.json`:** `default-src 'self'`, `script-src 'self'` (no inline script, no `eval`), `object-src 'none'`, `connect-src` limited to `ipc:`, `http://ipc.localhost` and `https://api.anthropic.com`. `style-src` does allow `'unsafe-inline'`, because libraries inject styles at runtime (toast and motion positioning rules); scripts stay locked down.
- **File access carries no static allow scope.** The capability grants `fs:allow-read-file`, `fs:allow-read-dir`, `fs:allow-exists`, `fs:allow-stat` and `fs:allow-write-file`, and `fs:deny-default` keeps everything else off. A path becomes reachable only when the user picks it in an open or save dialog, which grants it for the session. `fs:scope` denies `$APPDATA/**` and the credential stores (`~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.azure`, `~/.kube`, `~/.docker`, `~/.config/gh`, `~/.claude`, `~/.codex`, `~/.git-credentials`, `~/.netrc`) even inside a grant. No mkdir, remove or rename permission is granted. `src-tauri/src/capability_contract.rs` pins this capability file in a test.
- **The opener plugin is scoped.** URLs open only for GitHub compare pages (`https://*/*/*/compare/*`), and paths only under `~/.swarm/worktrees/`.
- **The webview AI chat holds the Anthropic API key.** The key lives in `swarm-config.json` in the app data directory (owner-only mode on Unix), and the webview calls `api.anthropic.com` directly. Nothing in `swarm-core` formats a config value into a log line or an error message. Git output that reaches events or commit messages passes through secret redaction first.
- **Update signatures are enforced.** An Ed25519 (minisign) keypair signs every updater artifact; the public key is in `src-tauri/tauri.conf.json` under `plugins.updater.pubkey`, and the private key is not committed (see [`docs/updater-keys.md`](docs/updater-keys.md)). `requireSignedVersion` is on, so a signature must also bind the version `latest.json` announces. A test in `src-tauri/src/config_contract.rs` keeps the flag on.
- **CI signs and verifies releases.** `.github/workflows/release.yml` passes `TAURI_SIGNING_PRIVATE_KEY` (and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, if set) to `tauri-apps/tauri-action` as GitHub Actions secrets, attests every artifact, and its `verify-updater-manifest` job checks each manifest entry's signature, signed version and attestation before a human publishes the draft release.
- **Dependencies are gated.** Every pin is exact, a version must be 24 hours old before it resolves (`minimumReleaseAge`), `trustPolicy: no-downgrade` refuses a package that lost its provenance, `cargo deny` checks the Rust tree, and GitHub Actions are pinned by commit SHA.
- No `eval()` or `new Function()` in application code.

### Headless daemon (`swarmd`)

- **Every request is authenticated.** A 256-bit bearer token (`<data dir>/daemon-token`, created private and compared in constant time) is required; there is no unauthenticated mode.
- **Loopback by default** (`127.0.0.1:8787`). Binding a non-loopback address is refused until a loopback run has minted the token.
- **`Host` and `Origin` are allow-listed on every request** (DNS-rebinding defense); extra names need `--allow-host`.
- **Remote clients are narrower than the desktop webview.** Commands that read or write the daemon host's files are not reachable remotely, and config keys that look like secrets cannot be read or written over the wire. An authenticated client can still spawn workers, which run commands as the daemon's user: treat the token like a shell login.
- **`--serve-ui` responses carry a CSP** (`default-src 'self'`, `connect-src 'self'`, `frame-ancestors 'none'`), `nosniff`, `no-referrer` and cross-origin isolation headers.

## Known Gaps / In Progress

- **The in-app updater only checks.** `check_for_updates` asks the endpoint whether a newer release exists and never downloads or installs it, so the signature and signed-version checks on download have not yet been exercised by a real in-app update. Releases (v0.13.0, v0.13.1) are signed and their `latest.json` is verified per release in CI; installing a new version means downloading it from the release page.
- **Webview AI tools run without a per-call approval step.** The built-in tools (`run_command`, `read_file`, `write_file`, worker control) execute what the model asks for, within the capabilities of the logged-in user; an approval flow is planned.
