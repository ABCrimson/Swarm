# ADR-0018: One agent-turn scheduler with per-worker admission

- **Status:** Accepted
- **Date:** 2026-08-14 (per-worker admission 2026-09-23)

## Context

Concurrent agent turns are the scarce resource: twenty provider processes running tools against one
repository is a bad idea. The old Rust AI stack had a priority queue (`ai/queue.rs`) that owned a
concrete Anthropic client. The stack was deleted when the Rust-side API client was dropped
([ADR-0019](0019-webview-chat-beside-adapters.md)), but the queue machinery was worth keeping.

## Decision

`AgentScheduler` (`agent/scheduler.rs`) carries that machinery over, generic over an injected
`executor` closure so it knows nothing about providers. `Runtime::start` builds one for both shells,
with an executor that finds the worker's live session in the `AgentSessionRegistry`, holds that
worker's turn lock for the whole turn, calls `send_turn`, awaits the settlement, and synthesises the
terminal `agent_turn_settled` for a turn that cannot start.

Admission rules:

- A request is dispatched only when a concurrency permit is free **and** its worker has no running
  turn. Follow-ups for a busy worker wait in the queue without holding a permit, so they never starve
  other workers. (The first version let queued follow-ups hold global permits.)
- Among admissible requests the highest `TurnPriority` (`low`, `normal`, `high`, `critical`) wins, then
  the oldest. Priority is decided at dispatch time. There is no preemption.
- Backpressure counts requests waiting for dispatch: `AppError::QueueFull` at 256.
- The limit defaults to 3 and is clamped to `1..=16`; `set_agent_concurrency` changes it live and the
  value is persisted (`agent_concurrency`) and restored at start. Tokio's `Semaphore` cannot resize,
  so an increase adds permits and a decrease forgets them, with in-flight permits forgotten on release.
- A panicking executor still releases its permit and its worker slot.

`agent_send_turn` is fire-and-forget by design: it confirms admission, not completion, and the
frontend renders from the live `agent_*` stream.

## Consequences

- The frontend's separate `useAiStore` concurrency gate for the webview chat is independent of this
  one; Settings pushes the agent value only on a real change.
- The turn lock lives in the session entry and dies with it; replacing a live session shuts the old one
  down instead of orphaning its child.
