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

- All IPC commands validate input at the boundary (UUID parsing, required fields)
- API keys are never logged or serialized (redacted from `Debug`/`Serialize` derives on the AI client config)
- Content Security Policy enforced via Tauri configuration (`default-src 'self'`, no `unsafe-inline`, `connect-src` scoped to `ipc:`/`http://ipc.localhost` and `https://api.anthropic.com`)
- **Update signatures are configured and enforced.** An Ed25519 keypair has been generated (`~/.tauri/swarm-orchestrator.key`, not committed); the public key is populated in `src-tauri/tauri.conf.json` under `plugins.updater.pubkey`, and `tauri-plugin-updater` verifies every downloaded update against it before installation. See [`docs/updater-keys.md`](docs/updater-keys.md) for key management and signed-version enforcement (`requireSignedVersion`).
- CI signs release artifacts: `.github/workflows/release.yml` passes `TAURI_SIGNING_PRIVATE_KEY` (and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, if set) as GitHub Actions secrets to `tauri-apps/tauri-action`, so every published release is signed automatically, not just local builds
- File access carries no static allow scope: fs:allow-read-file, fs:allow-read-dir, fs:allow-exists, fs:allow-stat and fs:allow-write-file reach only paths the user picked in an open/save dialog (granted for the session). fs:scope denies $APPDATA/** and the credential stores (~/.ssh, ~/.gnupg, ~/.aws, ~/.azure, ~/.kube, ~/.docker, ~/.config/gh, ~/.claude, ~/.codex, ~/.git-credentials, ~/.netrc) even inside a grant. No mkdir/remove/rename permission is granted.
- No `eval()` or `new Function()` usage

## Known Gaps / In Progress

- Update artifacts are signed, and the release pipeline has now shipped real releases (v0.13.0, v0.13.1) with the four-platform `latest.json` manifest machine-verified per release (`verify-updater-manifest` in `.github/workflows/release.yml`). The in-app apply path (download → signature check → install) has not yet been observed completing a real version-to-version update on every platform; treat the updater as still in its soak period.
