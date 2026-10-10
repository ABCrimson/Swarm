# ADR-0002: `swarmd` is a separate binary, not a `--headless` flag

- **Status:** Accepted
- **Date:** 2026-08-15

## Context

The headless daemon could have been the desktop executable started with a `--headless` flag, sharing
one artifact. Two facts argue against it. Tauri links `libwebkit2gtk` at build time on Linux, so a
runtime flag cannot unlink it and a headless server box would still need the GTK/WebKit stack. And
the release desktop binary is built with `windows_subsystem = "windows"`, which has no console to
print startup errors or a connect URL to.

## Decision

`swarmd` is its own binary (`crates/swarmd`), built from `swarm-core` plus an HTTP/WebSocket server
(`axum`). It carries none of the updater, dialog, notification, fs, opener or store plugins, which
also shrinks the network-exposed dependency surface. It ships as its own release asset per target.

## Consequences

- A server box needs only the `swarmd` binary and the provider CLIs it drives.
- Two binaries share one data-directory format, so they must not run against the same directory at
  once; [ADR-0025](0025-single-instance-lock.md) enforces that.
- The desktop app cannot attach to a running daemon: the transport is fixed at build time
  ([ADR-0024](0024-transport-chosen-at-build-time.md)). Attaching a desktop window to a remote daemon
  is future work.
- `swarmd --serve-ui <dir>` serves a `pnpm build:web` bundle from disk. Embedding the bundle in the
  binary is not done.

See [Runtime Modes](../architecture.md#runtime-modes) and [daemon.md](../daemon.md).
