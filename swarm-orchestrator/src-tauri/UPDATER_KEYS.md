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

The `pubkey` field in `tauri.conf.json` must be populated before production release.
