# Updater Keys

> How SWARM Orchestrator's in-app updater is signed: the Ed25519 keypair, the CI signing flow, signed-version enforcement, and the Linux caveat.

---

## Table of Contents

- [Generating the Keypair](#generating-the-keypair)
- [CI Signing](#ci-signing)
- [Signed-Version Enforcement](#signed-version-enforcement)
- [Re-Signing an Artifact by Hand](#re-signing-an-artifact-by-hand)
- [Current Status](#current-status)
- [Linux Caveat: AppImage-Only Updates](#linux-caveat-appimage-only-updates)

---

## Generating the Keypair

Generate the Ed25519 keypair for update signing with the repo-pinned Tauri CLI:

```bash
pnpm tauri signer generate -w ~/.tauri/swarm-orchestrator.key
```

This writes:

- **Private key:** `~/.tauri/swarm-orchestrator.key` (NEVER commit this).
- **Public key:** `~/.tauri/swarm-orchestrator.key.pub`, also printed to stdout. Copy it into `src-tauri/tauri.conf.json` under `plugins.updater.pubkey`.

Pass `-p <password>` to protect the private key with a password (see [Current Status](#current-status)).

## CI Signing

Store the private key as a GitHub Actions secret:

```bash
gh secret set TAURI_SIGNING_PRIVATE_KEY < ~/.tauri/swarm-orchestrator.key
```

`.github/workflows/release.yml` passes it to the build step, where `tauri-apps/tauri-action` runs the repo-pinned CLI through `pnpm tauri build`:

```yaml
env:
  TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}
  TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}
```

With `bundle.createUpdaterArtifacts` on, every updater artifact gets a `.sig` next to it, and `latest.json` carries those signatures for the updater endpoint.

## Signed-Version Enforcement

`src-tauri/tauri.conf.json` sets `plugins.updater.requireSignedVersion: true`.

`latest.json` is fetched over TLS but is not itself signed; the signature covers only the downloaded artifact. Without this flag, anyone able to serve a crafted `latest.json` could pair a newer `version` with the `url` and `signature` of an older, genuinely signed release and push users onto an outdated build.

`tauri build` writes `version:<app version>` into the minisign trusted comment of every updater signature, and the trusted comment is covered by the signature. With `requireSignedVersion` on, the updater's `download()` step:

- rejects a signature that carries no version at all with `MissingSignedVersion` (any artifact signed by hand without `--app-version`, or by a CLI older than 2.11.5);
- rejects a signature whose version differs from the one `latest.json` announces with `SignedVersionMismatch` (the plugin does this even when the flag is off).

The app's `check_for_updates` command only calls `Updater::check()` today, so this enforcement takes effect as soon as in-app download or install is wired up. `src-tauri/src/commands/updater.rs` has a contract test that keeps the flag on.

## Re-Signing an Artifact by Hand

`tauri build` binds the version automatically. Any manual (re-)signing of an updater artifact MUST pass the version the release announces:

```bash
pnpm tauri signer sign \
  --private-key-path ~/.tauri/swarm-orchestrator.key \
  --app-version <version> \
  <artifact>
```

Without `--app-version`, the resulting `.sig` has no signed version, and every updated client rejects the update with `MissingSignedVersion`. Upload the new `.sig`, and put its contents into the matching `platforms.<target>.signature` entry of the release's `latest.json`.

## Current Status

**Keys are generated and wired up.**

- **Private key:** generated at `~/.tauri/swarm-orchestrator.key` with no password. It is not committed to the repository; it exists only on the machine(s) that generated it and in the `TAURI_SIGNING_PRIVATE_KEY` GitHub Actions secret.
- **Public key:** populated in `src-tauri/tauri.conf.json` under `plugins.updater.pubkey`.
- **Update endpoint:** `plugins.updater.endpoints` in `tauri.conf.json` points at the `ABCrimson/Swarm` GitHub Releases `latest.json` asset:
  ```
  https://github.com/ABCrimson/Swarm/releases/latest/download/latest.json
  ```
- **CI signing:** `.github/workflows/release.yml` runs on `v*` tag pushes (and manual `workflow_dispatch`), builds with `tauri-apps/tauri-action`, and passes `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (both GitHub Actions secrets) to the build step, so every tagged release is signed automatically across all four build matrix targets (`x86_64-pc-windows-msvc`, `aarch64-apple-darwin`, `x86_64-apple-darwin`, `x86_64-unknown-linux-gnu`).
- **`verify-updater-manifest` job:** runs after `build` (`if: always()`) and asserts `latest.json` on the draft release carries all four platform keys (`windows-x86_64`, `darwin-aarch64`, `darwin-x86_64`, `linux-x86_64`) before a human publishes it. The four build jobs fetch-modify-upload the same release asset non-atomically, so a lost entry would otherwise go unnoticed.

`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` is in the workflow for forward compatibility, but the secret is currently unset/empty. If the key is ever rotated to a password-protected one, set that secret before the next tagged release.

## Linux Caveat: AppImage-Only Updates

`tauri-plugin-updater` only supports self-applying updates via **AppImage** on Linux. The release workflow also produces a `.deb` bundle, but a `.deb` install has no in-place update mechanism through this plugin: `check_for_updates` still reports that a new version is available, but applying it fails. `.deb` users must uninstall and reinstall (or wait for a system-package-manager update path in a future release) rather than rely on the in-app updater.
