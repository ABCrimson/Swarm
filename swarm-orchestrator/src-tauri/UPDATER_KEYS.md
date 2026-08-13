# Tauri Updater Key Setup

## Generate Keys

Run the following command to generate an Ed25519 keypair for update signing:

```bash
npx @tauri-apps/cli signer generate -w ~/.tauri/swarm-orchestrator.key
```

This outputs:
- **Private key**: `~/.tauri/swarm-orchestrator.key` (NEVER commit this)
- **Public key**: Printed to stdout — copy into `tauri.conf.json` → `plugins.updater.pubkey`

## Environment Variable for CI

Set the private key as a GitHub Actions secret:

```bash
gh secret set TAURI_SIGNING_PRIVATE_KEY < ~/.tauri/swarm-orchestrator.key
```

Then reference in `.github/workflows/release.yml`:

```yaml
env:
  TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}
```

## Current Status

**Keys are generated and wired up.**

- **Private key:** Generated at `~/.tauri/swarm-orchestrator.key` (no password set on the key). It is not committed to the repository and exists only on the machine(s) that generated it and in the `TAURI_SIGNING_PRIVATE_KEY` GitHub Actions secret.
- **Public key:** Populated in `src-tauri/tauri.conf.json` under `plugins.updater.pubkey`.
- **Update endpoint:** `plugins.updater.endpoints` in `tauri.conf.json` points at the `crimson-dev/swarm-orchestrator` GitHub Releases `latest.json` asset:
  ```
  https://github.com/crimson-dev/swarm-orchestrator/releases/latest/download/latest.json
  ```
- **CI signing:** `.github/workflows/release.yml` runs on `v*` tag pushes (and manual `workflow_dispatch`), builds with `tauri-apps/tauri-action`, and passes `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (both GitHub Actions secrets) as env vars to the build step, so every tagged release is signed automatically across all four build matrix targets (`x86_64-pc-windows-msvc`, `aarch64-apple-darwin`, `x86_64-apple-darwin`, `x86_64-unknown-linux-gnu`).
- **`verify-updater-manifest` job:** runs after `build` (`if: always()`) and asserts `latest.json` on the draft release carries all four platform keys (`windows-x86_64`, `darwin-aarch64`, `darwin-x86_64`, `linux-x86_64`) before a human publishes it — the four build jobs fetch-modify-upload the same release asset non-atomically, so a lost entry would otherwise be silent.

No password was set on the generated private key (`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` is present in the workflow for forward-compatibility but is currently unset/empty as a secret). If the key is ever rotated to a password-protected one, set that secret before the next tagged release.

## Linux Caveat: AppImage-Only Updates

`tauri-plugin-updater` only supports self-applying updates via **AppImage** on Linux. The release workflow also produces a `.deb` bundle, but a `.deb` install has no in-place update mechanism through this plugin: `check_for_updates` will still report a new version is available, but attempting to apply it will fail. `.deb` users must uninstall/reinstall (or wait for a system-package-manager-based update path in a future release) rather than relying on the in-app updater.
