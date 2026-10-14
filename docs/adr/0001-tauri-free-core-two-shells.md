# ADR-0001: `swarm-core` is Tauri-free; the desktop app and the daemon are thin shells

- **Status:** Accepted
- **Date:** 2026-08-14

## Context

All backend logic (workers, sessions, the event log, the bus, git, the ship chain) first lived inside
the Tauri app crate, wired to `tauri::AppHandle`, Tauri state and `tauri-plugin-store`. That made two
things impossible: running SWARM without a webview (a headless daemon reachable from a browser, a
phone or another machine) and testing the domain logic without building a Tauri app. The Linux build
of Tauri also links `libwebkit2gtk` at build time, so anything that depends on `tauri` drags it in.

## Decision

The domain lives in `crates/swarm-core`, which depends on no `tauri` or `tauri-plugin-*` crate. Every
seam that would otherwise be a Tauri type is a plain Rust value:

- recording events is `events::EventSink`; delivering them is an `emit` callback handed to
  `Runtime::start` plus any number of `OrchestrationEngine::subscribe` receivers;
- filesystem roots are a `Paths` value the shell resolves and passes in (Tauri's app data directory,
  or `swarmd`'s `--data-dir`);
- every command handler is a registry entry (see [ADR-0021](0021-command-registry-remote-policy.md)).

Two shells embed it: `swarm-desktop` (`src-tauri/`) and `swarmd` (`crates/swarmd`). Both build their
runtime through the one `Runtime::start`, so they cannot drift apart. CI enforces the boundary:
`cargo tree --locked -p swarm-core -e normal` and the same for `swarmd` must list no crate whose name
starts with `tauri`. `swarmd` is checked on its own because a `tauri` dependency added straight to its
manifest would not show up under `swarm-core`.

## Consequences

- Domain tests run with plain `cargo test`, with real git repositories and fake provider CLIs, and no
  webview.
- A new shell (a CLI, a service) is a new thin crate over `Runtime`.
- Anything that needs a live webview or an OS plugin cannot go in the core. The two such commands,
  `check_for_updates` and `send_notification`, are `NATIVE_ONLY` and exist only in the desktop shell.
- The workspace has three members: `src-tauri`, `crates/swarm-core`, `crates/swarmd`.

See [architecture.md](../architecture.md#backend) and [Runtime Modes](../architecture.md#runtime-modes).

## Amendment (2026-10-14): `open_worker_directory` is a third `NATIVE_ONLY` command

The webview's worktree link opens a worker's own worktree directory through it, by worker id,
instead of through an opener path scope (see the 2026-10-14 amendment to [ADR-0030](0030-tauri-3-alpha-capability-scoped-fs.md)).
