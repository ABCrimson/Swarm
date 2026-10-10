# Updater Keys

> How SWARM Orchestrator's in-app updater is signed: the Ed25519 keypair, the CI signing flow, signed-version enforcement, and how each Linux bundle would update.

---

## Table of Contents

- [Generating the Keypair](#generating-the-keypair)
- [CI Signing](#ci-signing)
- [Signed-Version Enforcement](#signed-version-enforcement)
- [Re-Signing an Artifact by Hand](#re-signing-an-artifact-by-hand)
- [Current Status](#current-status)
- [Linux: AppImage And .deb](#linux-appimage-and-deb)

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

Store the private key as a secret of the `release` GitHub environment, which the build job of `.github/workflows/release.yml` runs in (the environment's deployment policy decides which refs may sign):

```bash
gh secret set TAURI_SIGNING_PRIVATE_KEY --env release < ~/.tauri/swarm-orchestrator.key
```

The build job installs with `pnpm install --frozen-lockfile` and no caches, so nothing another workflow wrote can reach the signing key. It passes the secrets to the build step, where `tauri-apps/tauri-action` builds with the repo-pinned CLI:

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

- rejects a signature that carries no version at all with `MissingSignedVersion` (any artifact signed by hand without `--app-version`);
- rejects a signature whose version differs from the one `latest.json` announces with `SignedVersionMismatch` (the plugin does this even when the flag is off).

The app's `check_for_updates` command (`src-tauri/src/commands/native.rs`) only calls `Updater::check()` today, so this enforcement takes effect as soon as in-app download or install is wired up. `src-tauri/src/config_contract.rs` has a contract test (`updater_requires_signed_versions`) that keeps the flag on and downgrades off.

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

- **Private key:** generated at `~/.tauri/swarm-orchestrator.key` with no password. It is not committed to the repository; it exists only on the machine(s) that generated it and in the `TAURI_SIGNING_PRIVATE_KEY` secret of the `release` environment.
- **Public key:** populated in `src-tauri/tauri.conf.json` under `plugins.updater.pubkey`.
- **Update endpoint:** `plugins.updater.endpoints` in `tauri.conf.json` points at the `ABCrimson/Swarm` GitHub Releases `latest.json` asset:
  ```
  https://github.com/ABCrimson/Swarm/releases/latest/download/latest.json
  ```
- **CI signing:** `.github/workflows/release.yml` runs the full CI gate on `v*` tag pushes (and, as a dry run that creates no release, on manual `workflow_dispatch`), builds with `tauri-apps/tauri-action`, and passes `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (both secrets of the `release` environment) to the build step, so every tagged release is signed automatically across all four build matrix targets (`x86_64-pc-windows-msvc`, `aarch64-apple-darwin`, `x86_64-apple-darwin`, `x86_64-unknown-linux-gnu`).
- **`verify-updater-manifest` job:** runs after `build` on tag pushes and runs `.github/scripts/verify-updater-manifest.sh` against the `latest.json` of the draft release before a human publishes it. It asserts the announced version, all four platform keys (`windows-x86_64`, `darwin-aarch64`, `darwin-x86_64`, `linux-x86_64`), that every artifact verifies with `minisign` against the public key in `tauri.conf.json`, that every signed trusted comment ends in `version:<version>`, and that every artifact carries a build provenance attestation. The four build jobs fetch-modify-upload the same release asset non-atomically, so a lost entry would otherwise go unnoticed.

`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` is in the workflow for forward compatibility, but the secret is currently unset/empty. If the key is ever rotated to a password-protected one, set that secret in the `release` environment before the next tagged release.

## Linux: AppImage And .deb

The release builds both Linux bundles (`--bundles deb,appimage` in `.github/workflows/release.yml`), and `tauri-plugin-updater` 3.0.0-alpha.2 can apply either:

- The plugin derives the installer from the running app's bundle type and looks in `latest.json` for `linux-x86_64-<installer>` (`linux-x86_64-appimage`, `linux-x86_64-deb`) before falling back to the bare `linux-x86_64` entry. The `verify-updater-manifest` job asserts the bare key; it does not check for the per-installer ones.
- **AppImage:** the new AppImage is written over the running one, which needs a temp directory on the same mount point as the AppImage.
- **.deb:** the package is written to a temp file and installed with `dpkg -i`, run through `pkexec`, then through a zenity/kdialog password prompt with `sudo`, then through terminal `sudo`. A `.deb` update therefore always asks for administrator rights.

The app does not apply updates yet: `check_for_updates` only reports that a newer release exists (see [Signed-Version Enforcement](#signed-version-enforcement)). Until in-app download and install are wired up, AppImage and `.deb` users alike install a new version from the release page.
