# ADR-0013: Provider adapters: one trait pair with honest capabilities

- **Status:** Accepted
- **Date:** 2026-08-14

## Context

SWARM drives several coding-agent CLIs (Claude Code, Codex; OpenCode and Gemini are reserved) whose
protocols differ: one-way NDJSON, bidirectional JSON-RPC, HTTP with server-sent events. The rest of
the system (scheduler, event log, UI) should not care which one a worker runs.

## Decision

One Rust trait pair in `crates/swarm-core/src/agent/adapter.rs`:

- `AgentAdapter` is the stateless, provider-level launcher: `provider`, `capabilities`, `probe`,
  `spawn`.
- `AgentSession` is the stateful per-worker handle: `session_key`, `send_turn`,
  `await_turn_completion`, `cancel`, `respond_permission`, `shutdown`.

Every provider's activity lands as the same normalised `agent_*` events on the ordered stream
([ADR-0003](0003-single-writer-ordered-event-log.md)).

**Object safety without a new dependency.** The methods return a hand-written
`BoxFuture<'a, T>` (`Pin<Box<dyn Future + Send + 'a>>`), not `impl Future`. `spawn` must return
`Box<dyn AgentSession>`, and a trait with return-position `impl Trait` methods is not dyn-compatible.

**Concurrency contract, binding on every implementation.** `shutdown(&self)` (not `self: Box<Self>`)
is idempotent and returns the same cached `ExitSummary` on later calls, so a session can live behind
`Arc<dyn AgentSession>` and any holder can trigger teardown. `send_turn` while a turn is in flight
returns `AppError::AgentSessionBusy`; a session never queues (the scheduler does, see
[ADR-0018](0018-agent-turn-scheduler.md)). No internal lock is held across an `.await`. A turn in
flight when the session ends yields **exactly one** `agent_turn_settled`, synthesised by the session
if the provider never sent a receipt (status error, no cost or usage invented).

**Capabilities honesty.** `Capabilities` (`partial_deltas`, `resume`, `native_cost`,
`permission_modes`, `cancel_granularity`, `interrupt_midturn`, `worktree_aware`,
`interactive_permissions`) exists so the UI disables an affordance instead of silently no-opping it.
A capability must be backed by an observed behaviour. A new provider difference becomes a new field on
this plain data type, not a new trait method.

**Session state has three owners, no mirroring.** The provider CLI owns the conversation; SWARM stores
only an opaque `SessionKey` and the cwd. SWARM's ordered log owns history (normalised events). The
`AgentSessionRegistry` owns the live process handle, ephemeral and rebuildable from the log plus a
resume.

## Consequences

- Adding a provider is one adapter module and one arm in the `with_adapter!` mapping in
  `commands/agent.rs`; every other agent command reaches the session through the registry by worker id.
- Three conditions, found by a measurement spike on the Claude CLI in the first adapter, are
  invariants for every provider: (A) run provider CLIs in a controlled config environment, because an
  operator's own plugin and hook loadout added several seconds to the first token; (B) synthesise the
  terminal receipt on ungraceful exit; (C) never gate permissions on an allow-list, which widens what
  runs unasked rather than restricting it.
- The OpenCode and Gemini ids exist in `ProviderId` with no adapter.

See [Adapter Layer](../architecture.md#adapter-layer).
