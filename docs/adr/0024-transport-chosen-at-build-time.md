# ADR-0024: The frontend transport is chosen at build time

- **Status:** Accepted
- **Date:** 2026-08-15

## Context

The same React app has to run in the Tauri webview (IPC) and in a plain browser against `swarmd`
(WebSocket). Auto-detecting at runtime would change what a plain `pnpm dev` browser preview does,
which today degrades gracefully (every command resolves `undefined`, every subscription is a no-op) so
the UI renders its empty states.

## Decision

`src/lib/transport.ts` exports a `Transport` interface (`invoke`, `listen`, `connect`, `capabilities`)
with two implementations: `tauriTransport` (Tauri IPC, a no-op outside the shell) and `wsTransport` (a
WebSocket client of `swarmd`'s wire protocol with backoff and jitter reconnect, `hello{lastSeq}` on
every reconnect from `event-bus.ts`'s `getLastSeq()`, an RPC timeout, and the token read from the URL
fragment on first load then scrubbed). The choice is made **once, at module load**, from the Vite
define `__SWARM_TRANSPORT__`, set to `"ws"` only by `pnpm build:web`.

`src/lib/tauri.ts` keeps its whole public API on top of it. `isTauri()` keeps its original meaning
("the Tauri IPC bridge specifically") for features that are Tauri-only (plugin-fs, dialog, opener,
notification, updater, the webview chat). `hasTransport()` means "some backend is reachable" and backs
the wrappers that work over either. `TransportCapabilities` declares what each transport supports
(`workspaceBrowsing`, `nativeNotifications`, `autoUpdate`, `localAiChat`); at this commit call sites
gate on `isTauri()` and nothing reads those flags yet.

## Consequences

- The remote surface is intentionally narrow: Dashboard, Workers, Terminals, Metrics and Agent chat.
  Filesystem browsing and the plugin-store-backed settings surfaces import `@tauri-apps/plugin-*`
  directly and are gated by `isTauri()`, which doubles as the remote-capability gate.
- A built desktop app cannot attach to a running daemon.
- Superseded: a `Kv` abstraction (`src/lib/kv.ts`) was added as the migration target for the
  plugin-store surfaces but was never wired to a call site and has been deleted.

## Amended 2026-10-13

The capability flags are now read. `hasCapability(feature)` in `src/lib/tauri.ts` returns
`transport.capabilities[feature]`, and desktop-only controls (the folder picker and file tree, workflow
and session file dialogs, the webview AI chat, native alert notifications, the updater) gate on it, showing
`DESKTOP_ONLY_REASON` ("Available In The Desktop App Only") where a control is disabled instead of hidden.
The flags are static per build, so a plain-browser preview of the desktop build keeps its UI; runtime
`isTauri()` checks stay where a plugin call needs the bridge itself. The sentence above that says nothing
reads the flags describes the state at the original commit.

A fifth flag, `localStores`, covers the local plugin-store files (session snapshots, saved templates,
automatic snapshots): true for `tauriTransport`, false for `wsTransport`. The controls that offer them
(Sessions' Snapshot and Save As Template, the palette's Snapshot Session, the Auto-Snapshot Interval) gate on
`hasCapability("localStores")`; the template list read and the automatic snapshot schedule, which touch the
store without a user action, also require `isTauri()`. The statement above that the plugin-store-backed
surfaces are gated by `isTauri()` describes the original commit.
