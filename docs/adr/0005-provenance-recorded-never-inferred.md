# ADR-0005: Provenance is recorded, never inferred

- **Status:** Accepted
- **Date:** 2026-08-14

## Context

The product claim is that an operator can see what caused what: which worker's turn spawned another
worker, which tool call wrote a file. A system can approximate that by guessing ("the last AI turn
probably caused this spawn"), and a guess shown as a fact is worse than showing nothing.

## Decision

Every event may carry a `Provenance { origin_worker, cause_seq }`, stamped on the envelope as
`originWorker` and `causeSeq` (absent, not `null`, when unattributed) and stored in nullable
`origin_worker` and `cause_seq` columns. The engine records provenance; it never derives it. Every
value traces back to an explicit caller-supplied argument: an IPC argument, a bus message's own
sender, or the seq a turn learned from `agent_turn_started`.

The two fields mean different things from the payload's `workerId`. The payload names the **subject**
(whose worker spawned, whose PTY got input). `originWorker` names the **causer**. For a tool-driven
action the two differ, and that difference is the causal edge.

`agent_turn_started` returns the seq it was assigned through an acknowledgement oneshot
(`emit_awaiting_seq`), so a chat turn can cite its own seq as `causeSeq` for the tool calls it makes.
The wait is bounded (5 s).

Rows written before provenance existed read back `NULL`, which is the truthful value.

## Consequences

- Only some call sites populate provenance. The honest table lives in
  [architecture.md](../architecture.md#provenance-who-populates-it); anything not listed carries none.
- The graph and the inspector built on this ([ADR-0006](0006-measured-causality-graph.md)) can only
  show what was recorded.
- Session create and delete accept provenance arguments but no shipped caller passes them, since
  session changes are user-initiated.
