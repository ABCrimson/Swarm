# ADR-0003: One ordered event stream: a single writer and a SQLite log

- **Status:** Accepted
- **Date:** 2026-07-10 (engine 2026-07-09; legacy per-channel events removed 2026-07-10)

## Context

The first backend emitted one Tauri event channel per kind of event, each from whichever thread
produced it. Nothing ordered events across channels, nothing recorded them, and a frontend that
missed one (a reload, a slow webview) had no way to recover. Features that needed history (replay,
causality, a PR body that cites what a worker did) had nothing to read.

## Decision

Every backend event passes through one `OrchestrationEngine`. Callers hold an `EventSink` and send
fire-and-forget to one FIFO channel drained by one OS thread (`swarm-event-writer`). That thread is
the only place a sequence number (`seq`) is assigned, so wire order is total order by construction.
For each event it assigns `seq` and a timestamp, persists the event if the persistence policy says so
([ADR-0004](0004-persistence-by-exclusion.md)), and then emits the envelope
`{ seq, ts, originWorker?, causeSeq?, type, payload }` on the one channel `swarm://events`.

Persisted events go to a SQLite database (`swarm-events.db`, WAL, `rusqlite` bundled) with a
`PRAGMA user_version` migration ladder in which each rung runs in a transaction. Seqs are reserved in
blocks of 1024 in a `meta` table before they are issued, so a crash never reuses a seq and costs at
most one unused block; a clean shutdown records the exact head. `events_since(afterSeq, limit?)`
returns persisted rows after a seq and is the basis for gap backfill and replay. Terminal outcomes are
separate receipt events (`ship_settled`, `agent_turn_settled`), never a flag on a stream event, and
the frontend awaits them with `waitFor`.

## Consequences

- Any consumer can detect a gap (a seq jump) and heal it from `events_since`; both the Tauri webview
  and `swarmd` clients do.
- Persisted seqs have gaps, because ephemeral events consume seqs too. Consumers must never treat a
  gap as loss of a persisted event.
- All events serialize through one thread. Persistence is a synchronous SQLite append on that thread,
  so a slow disk makes the engine's queue back up rather than dropping events.
- The engine also exposes a lossy `broadcast` fanout. It is reserved for subscribers that can heal
  lag from the log, which is how `swarmd` uses it ([ADR-0023](0023-swarmd-one-ordered-lane.md)).
- Superseded: the transitional dual-emit (engine and legacy channels together) lasted one day and is
  gone, as are all per-channel events.

See [Ordered Event Core](../architecture.md#ordered-event-core).
