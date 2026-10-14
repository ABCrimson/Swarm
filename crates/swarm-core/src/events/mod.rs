//! Typed domain events and the [`EventSink`] emission seam.
//!
//! Re-exports every event type from the [`emitter`] submodule. Every
//! event flows through the [`crate::orchestration::OrchestrationEngine`]
//! onto the ordered stream as a `{seq, ts, type, payload}` envelope
//! (the Tauri shell forwards it on the single `swarm://events` channel;
//! `swarmd` fans it out to its WebSocket clients). Events marked
//! EPHEMERAL below are emitted but never persisted — see
//! [`crate::orchestration::is_persistent`].
//!
//! ## Event Types
//!
//! | Type tag            | Payload Type               | Trigger                        |
//! |---------------------|----------------------------|--------------------------------|
//! | `worker_spawned`    | [`WorkerSpawnedPayload`]   | New worker registered          |
//! | `worker_killed`     | [`WorkerKilledPayload`]    | Worker terminated and removed  |
//! | `worker_output`     | [`WorkerOutputPayload`]    | PTY output data available (EPHEMERAL) |
//! | `worker_state`      | [`WorkerStatePayload`]     | Worker state transition        |
//! | `session_created`   | [`SessionCreatedPayload`]  | New session created            |
//! | `session_deleted`   | [`SessionDeletedPayload`]  | Session removed                |
//! | `session_worker_added` | [`SessionWorkerAddedPayload`] | A worker joined a session's `workerIds` |
//! | `session_worker_removed` | [`SessionWorkerRemovedPayload`] | A worker was pruned from a session's `workerIds` |
//! | `system_metrics`    | [`SystemMetricsPayload`]   | Periodic metrics update (EPHEMERAL) |
//! | `system_log`        | [`SystemLogPayload`]       | Backend log message (EPHEMERAL) |
//! | `bus_message`       | [`BusMessagePayload`]      | Inter-agent bus message        |
//! | `worktree_created`  | [`WorktreeCreatedPayload`] | Worker's git worktree created  |
//! | `worktree_removed`  | [`WorktreeRemovedPayload`] | Worker's git worktree removed/preserved |
//! | `ship_progress`     | [`ShipProgressPayload`]    | One step of an in-flight ship operation |
//! | `ship_settled`      | [`ShipSettledPayload`]     | Terminal receipt for a ship operation |
//! | `commit_created`    | [`CommitCreatedPayload`]   | Ship chain created a commit    |
//! | `worker_input`      | [`WorkerInputPayload`]     | Bytes written to a worker's PTY stdin (EPHEMERAL when typed at the terminal) |
//! | `agent_turn_started`| [`AgentTurnStartedPayload`]| An AI/agent turn started (causal root) |
//! | `file_written`      | [`FileWrittenPayload`]     | A file was written via `write_file` |
//! | `agent_session_started` | [`AgentSessionStartedPayload`] | A provider-adapter session started |
//! | `agent_turn_delta`  | [`AgentTurnDeltaPayload`]  | One streamed sub-message chunk (EPHEMERAL) |
//! | `agent_block`       | [`AgentBlockPayload`]      | One complete content block within a turn |
//! | `agent_tool_call`    | [`AgentToolCallPayload`]   | A provider-agent tool call |
//! | `agent_tool_result`  | [`AgentToolResultPayload`] | The result of a provider-agent tool call |
//! | `agent_permission_request` | [`AgentPermissionRequestPayload`] | A tool call awaits approval, or was denied |
//! | `agent_turn_settled` | [`AgentTurnSettledPayload`] | Terminal receipt for one provider-adapter turn |
//! | `agent_session_exited` | [`AgentSessionExitedPayload`] | A provider-adapter session's process exited |
//!
//! ## Provenance
//!
//! Every event's envelope (the [`crate::orchestration::DomainEvent`]
//! wrapping a `SwarmEvent`) can additionally carry a [`Provenance`]:
//! `{originWorker, causeSeq}`. `originWorker` is the CAUSER; a
//! payload's own `workerId` is the SUBJECT — for a tool-driven spawn
//! the two differ, and that difference is the causal edge. The engine
//! records provenance, it never infers it — see
//! [`EventSink::emit_with`]'s invariant doc.

pub mod emitter;

pub use emitter::{
    AgentBlockPayload, AgentPermissionRequestPayload, AgentSessionExitedPayload,
    AgentSessionStartedPayload, AgentToolCallPayload, AgentToolResultPayload,
    AgentTurnDeltaPayload, AgentTurnSettledPayload, AgentTurnStartedPayload, BusMessagePayload,
    CommitCreatedPayload, EventSink, FileWrittenPayload, InputSource, Provenance,
    SessionCreatedPayload, SessionDeletedPayload, SessionWorkerAddedPayload,
    SessionWorkerRemovedPayload, ShipProgressPayload, ShipSettledPayload, SwarmEvent,
    SystemLogPayload, SystemMetricsPayload, WorkerInputPayload, WorkerKilledPayload,
    WorkerOutputPayload, WorkerSpawnedPayload, WorkerStatePayload, WorktreeCreatedPayload,
    WorktreeRemovedPayload,
};
pub(crate) use emitter::{Backlog, WriterCmd, WriterMsg};
