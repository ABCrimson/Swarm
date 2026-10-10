# ADR-0027: Frontend state in three tiers

- **Status:** Accepted
- **Date:** 2026-07-10

## Context

With every backend event on one ordered stream ([ADR-0003](0003-single-writer-ordered-event-log.md)),
the frontend can hold domain state as a pure projection of that stream. UI state (which panel is open,
which worker is selected) and user preferences have different lifetimes and different owners, and
mixing them in one store causes needless re-renders and persistence mistakes.

## Decision

- **Domain state in Zustand 5 stores**, updated with `immer` and `subscribeWithSelector`, fed by the
  event bus through app-root hooks (`useWorkerEvents`, `useSessionEvents`, `useAgentSessionEvents`,
  `useProvenanceEvents`, `useSystemLogEvents`, `useMetrics`). Stores that model data as `Map` or `Set`
  call immer's `enableMapSet()` at module load, in production as well as development.
- **Ephemeral UI state in Jotai atoms** (`src/store/ui.ts`): selection, page, panels, the causality
  inspector, the performance overlay, and the reduced-motion flag, which starts from the OS setting and
  follows it.
- **Persisted preferences as Jotai atoms built by `atomWithSettings`** (`src/store/persisted.ts`):
  theme, pane sizes, app settings, keybindings, the selected model. They read a copy of
  `swarm-settings.json` preloaded before first render, validate per key, and write through an ordered
  queue ([ADR-0026](0026-rust-owns-config-and-sessions.md)).
- Sessions are persisted by the backend; the session store is a projection of it.
- The React Compiler memoises, so there is no manual `useMemo` or `useCallback`, and no `forwardRef`.

## Consequences

- A hot path that must not pay for immer's proxies (provenance ingest) writes plain objects instead.
- An immer draft is revoked when its producer returns, so a closure passed to `set` must not leak one
  (for example into an async callback) and read it later.
- Stores rebuild from the live stream plus snapshot `list_*` commands after a reload; terminal
  scrollback and the provenance graph are session-scoped.
