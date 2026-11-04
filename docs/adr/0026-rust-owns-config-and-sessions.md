# ADR-0026: Rust owns config and sessions; the webview owns its plugin-store files

- **Status:** Accepted
- **Date:** 2026-08-15 (sessions off plugin-store), 2026-09-23 (damage handling, ownership split),
  2026-11-04 (the API key leaves `swarm-config.json`)

## Context

Sessions and settings were first persisted by `tauri-plugin-store`, which only exists in the desktop
shell. A daemon needs the same files, and the plugin has hazards: it keeps one in-memory instance per
path and applies the options of whichever caller loaded the file first, and it **re-saves every file
it has loaded when the app exits**. A frontend integrity check that opened `swarm-config.json` through
it therefore overwrote every config change made during the session (API key, max workers, agent
concurrency, project root) with the startup copy on a normal exit. Separately, a reader that treats an
unreadable or malformed file as empty makes the next read-modify-write silently drop every other value.

## Decision

Two owners, no overlap:

- **Rust owns `swarm-config.json` and `sessions.json`.** `sessions.json` is `{"sessions": [...]}`, the
  shape the plugin wrote, so old files load unmodified. Both go through `state_file`: a missing,
  malformed and unreadable file are distinct outcomes, never "empty"; a malformed file is moved aside to
  `<name>.corrupt-<unix ms>` before any write; an unreadable one is left untouched and writes refuse;
  one bad session entry is skipped rather than failing the whole load. Writes are atomic and durable
  (fresh temp file, owner-only `0600` on Unix, fsync, rename over the target, fsync the directory).
  Config keys are written sorted; every read-modify-write cycle is serialised by a process-wide lock;
  a session save takes its snapshot inside the lock, so an older autosave can never overwrite a newer
  one. `swarm-config.json` holds `max_workers`, `agent_concurrency`, `default_repo_root` and
  `shipCoAuthoredBy`, plus the frontend's namespaced `<store>:<key>` entries; `anthropic_api_key` goes
  through the same functions but lives in the secret store (amendment below).
- **The webview owns `swarm-settings.json`, `swarm-snapshots.json` and `swarm-templates.json`**
  through one shared `LazyStore` handle per file (`src/lib/lazy-store.ts`) that passes no options, so
  the plugin's defaults apply (auto-save, 100 ms debounce). `swarm-config.json` must never be opened
  through the plugin. Settings atoms are built by `atomWithSettings`, which reads a copy preloaded
  before first render, validates each key with its zod schema and falls back to the atom default on
  failure.

## Consequences

- Settings and snapshots exist only in the desktop webview; the browser build served by `swarmd` has
  no persisted settings.
- The `SecretFiltered` policy is the only remote access to config
  ([ADR-0021](0021-command-registry-remote-policy.md)).
- The integrity check (`store-integrity`) validates only keys something really persists, and never
  touches `swarm-config.json`.

## Amendment (2026-11-04): the API key leaves `swarm-config.json`

`anthropic_api_key` is kept in a secret store behind the trait `SecretStore`
(`crates/swarm-core/src/secrets/`): the OS keychain (`keyring` with its `v1` stores: Windows Credential
Manager, macOS Keychain, the Secret Service on Linux) under service `swarm`, user `anthropic_api_key`, or,
when `Entry::store_status()` reports no keychain (a headless `swarmd` with no Secret Service), the
owner-only `<data dir>/swarm-secrets.json` (`0600` on Unix). The config functions still read and write
the key, so `read_config` / `write_config` keep their shape and their `SecretFiltered` remote policy
([ADR-0021](0021-command-registry-remote-policy.md)); writing `null` or `""` deletes it. A key that an
older build left in `swarm-config.json` is moved to the store once at startup (a background blocking task
from `Runtime::start`), on the key's first read or write, and on any rewrite of the file; a store that
refuses it leaves the file as it was. A key the `swarm-secrets.json` fallback holds is moved into the keychain,
and deleted from the file, by the next process that has one (`config::adopt_file_secrets`, under `SECRET_LOCK`);
a keychain refusal leaves the file copy for a later pass. Every store call blocks and runs
off the Tokio workers; a value lives in a `SecretString`, zeroed on drop, with a redacted `Debug`; a
failed keychain read is cached for `FAILURE_TTL` (30 s), never for the process life.

The OS keychain holds one `swarm`/`anthropic_api_key` entry per OS user, shared by every data directory;
migrating a legacy key, or adopting a `swarm-secrets.json` key, from any data directory replaces it, and
clearing it clears it for all. Only `swarm-secrets.json` is per data directory.
