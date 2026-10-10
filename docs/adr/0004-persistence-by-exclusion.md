# ADR-0004: Persistence by exclusion: deltas are ephemeral, blocks are durable

- **Status:** Accepted
- **Date:** 2026-07-09 (agent family and typed input source 2026-08-14)

## Context

Every event consumes a seq, but not every event belongs in history. PTY output, metrics ticks and
log lines are high-frequency telemetry. Streaming deltas from a provider agent would add roughly 800
SQLite rows per second at eight workers. Raw terminal keystrokes can contain secrets a human typed
into a shell. Meanwhile spawn, kill, ship and permission events are exactly what replay and the
causal record need.

## Decision

`is_persistent(event)` in `orchestration/engine.rs` decides, and it works by **exclusion**:

- never persisted by variant: `worker_output`, `system_metrics`, `system_log`, `agent_turn_delta`;
- never persisted by field: `worker_input` whose `source` is `terminal`. `source` is a closed enum
  (`terminal`, `tool`, `automation`), so a misspelled wire value fails deserialization instead of
  slipping into the log; only machine-issued input is archived;
- everything else persists before it is emitted.

A new variant is therefore persistent by construction unless someone excludes it deliberately. Each
delta has a durable counterpart: `agent_turn_delta` streams the typing, `agent_block` is the complete
content block that replay reconstructs a turn from.

## Consequences

- Replay of a turn shows full blocks but not the typing animation.
- Terminal scrollback is not recoverable from the log; a reload keeps it only in the webview's store.
- `swarmd` uses the same predicate to classify frames as persistent or ephemeral
  ([ADR-0023](0023-swarmd-one-ordered-lane.md)), so the two cannot disagree.
- Tests pin the policy per family (worktree, ship, agent, the `worker_input` carve-out).

See [Ordered Event Core](../architecture.md#ordered-event-core).
