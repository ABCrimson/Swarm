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
