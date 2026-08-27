# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.13.x  | :white_check_mark: |
| < 0.13  | :x:                |

## Reporting a Vulnerability

If you discover a security vulnerability in SWARM Orchestrator, please report it responsibly.

**Do NOT open a public issue.**

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
- **Update signatures are configured and enforced.** An Ed25519 keypair has been generated (`~/.tauri/swarm-orchestrator.key`, not committed); the public key is populated in `src-tauri/tauri.conf.json` under `plugins.updater.pubkey`, and `tauri-plugin-updater` verifies every downloaded update against it before installation. See [`src-tauri/UPDATER_KEYS.md`](src-tauri/UPDATER_KEYS.md) for key management details.
- CI signs release artifacts: `.github/workflows/release.yml` passes `TAURI_SIGNING_PRIVATE_KEY` (and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, if set) as GitHub Actions secrets to `tauri-apps/tauri-action`, so every published release is signed automatically, not just local builds
- File system access is scoped by Tauri capabilities (`src-tauri/capabilities/default.json`), narrower than a blanket app-data grant:
  - Reads (`fs:allow-read-text-file`, `fs:allow-read-dir`, `fs:allow-exists`) are permitted under `$APPDATA/**` and `$HOME/**`, to support workspace/file-tree browsing
  - Writes, removals, and renames (`fs:allow-write-text-file`, `fs:allow-mkdir`, `fs:allow-remove`, `fs:allow-rename`) are restricted to `$APPDATA/**` and `$HOME/.swarm/**` only -- the app cannot write, delete, or rename files anywhere else under the user's home directory
- No `eval()` or `new Function()` usage

## Known Gaps / In Progress

- Update artifacts are signed, and the release pipeline has now shipped real releases (v0.13.0, v0.13.1) with the four-platform `latest.json` manifest machine-verified per release (`verify-updater-manifest` in `.github/workflows/release.yml`). The in-app apply path (download → signature check → install) has not yet been observed completing a real version-to-version update on every platform; treat the updater as still in its soak period.
- The broad read scope (`$HOME/**`) is intentionally permissive to support arbitrary workspace directories; if this proves too broad in practice, a future release should move to a user-configured allowlist of workspace roots instead of blanket `$HOME` read access.
