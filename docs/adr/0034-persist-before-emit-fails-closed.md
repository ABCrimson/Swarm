# ADR-0034: A persistent event is saved before anyone sees it, and fails closed

- **Status:** Accepted
- **Date:** 2026-10-10

## Context

[ADR-0003](0003-single-writer-ordered-event-log.md) made the event log the source for gap backfill and
`swarmd` replay, and [ADR-0004](0004-persistence-by-exclusion.md) said persistent events are saved
before they are emitted. The writer did not hold to that when a write failed: a failed append was
logged and the event was still emitted, published as the new head and offered to the fanout. A client
could then act on an event that `events_since` and every later replay would never return, and a failed
seq reservation could hand out a seq the log had not reserved, which a crash would reissue.

## Decision

In `OrchestrationEngine`'s writer (`orchestration/engine.rs`, "Failing closed") a seq nobody can prove
durable is never shown:

- **Reservation.** A seq past the reserved block triggers a reservation, retried once. If it still
  fails, the event is dropped whole, the seq counter is rolled back and the next event retries.
- **Append.** A persistent event that cannot be appended reaches no delivery path (neither the shell's
  `emit` closure nor the broadcast fanout) and does not move `head_seq`. Its `emit_awaiting_seq` ack
  is dropped, so the waiting caller (`agent_turn_started`) gets an error instead of a seq.
- **Explaining the gap.** One ephemeral `system_log` error event takes the next seq, naming the dropped
  seq and its type. Clients already treat a gap as ephemeral and backfill an empty page, so nothing
  else changes for them. If that seq cannot be issued either, only the tracing line remains.

## Consequences

- Anything a client saw live is in the log (since [ADR-0039](0039-event-log-flushes-every-commit.md), also
  after an OS crash or power loss, on storage that honours flushes); a replay can never contradict a live view.
- A failing disk now loses events instead of showing them live-only. The loss is visible as a
  `system_log` error and the awaiting commands' errors, not silent.
- Ephemeral events never touch the log, so they cannot be dropped this way.
- Tests: `test_failed_persist_emits_nothing_and_holds_the_head`,
  `test_failed_persist_alone_never_advances_the_head` and
  `test_failed_reservation_fails_closed_and_recovers` in `engine.rs`.

See [Failing Closed](../api.md#failing-closed) and [Ordered Event Core](../architecture.md#ordered-event-core).
