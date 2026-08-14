//! Event system module.
//!
//! Re-exports all event types and the [`EventSink`] emission seam
//! from the [`emitter`] submodule. The event system bridges backend
//! state changes to any embedding shell: every event flows through
//! the [`crate::orchestration::OrchestrationEngine`] onto the ordered
//! stream as a `{seq, ts, type, payload}` envelope (the Tauri shell
//! forwards it onto the single `swarm://events` channel).
//!
//! ## Event Types
//!
//! | Type tag            | Payload Type               | Trigger                        |
//! |---------------------|----------------------------|--------------------------------|
//! | `worker_spawned`    | [`WorkerSpawnedPayload`]   | New worker registered          |
//! | `worker_killed`     | [`WorkerKilledPayload`]    | Worker terminated and removed  |
//! | `worker_output`     | [`WorkerOutputPayload`]    | PTY output data available      |
//! | `worker_state`      | [`WorkerStatePayload`]     | Worker state transition        |
//! | `session_created`   | [`SessionCreatedPayload`]  | New session created            |
//! | `session_deleted`   | [`SessionDeletedPayload`]  | Session removed                |
//! | `system_metrics`    | [`SystemMetricsPayload`]   | Periodic metrics update        |
//! | `ai_stream_delta`   | [`AiStreamDeltaPayload`]   | AI response text chunk         |
//! | `ai_stream_settled` | [`AiStreamSettledPayload`] | AI stream terminal receipt     |
//! | `system_log`        | [`SystemLogPayload`]       | Backend log message            |
//! | `bus_message`       | [`BusMessagePayload`]      | Inter-agent bus message        |
//! | `worktree_created`  | [`WorktreeCreatedPayload`] | Worker's git worktree created  |
//! | `worktree_removed`  | [`WorktreeRemovedPayload`] | Worker's git worktree removed/preserved |
//! | `ship_progress`     | [`ShipProgressPayload`]    | One step of an in-flight ship operation |
//! | `ship_settled`      | [`ShipSettledPayload`]     | Terminal receipt for a ship operation |
//! | `commit_created`    | [`CommitCreatedPayload`]   | Ship chain created a commit    |
//! | `worker_input`      | [`WorkerInputPayload`]     | Bytes written to a worker's PTY stdin |
//! | `agent_turn_started`| [`AgentTurnStartedPayload`]| An AI/agent turn started (causal root) |
//! | `file_written`      | [`FileWrittenPayload`]     | A file was written via `write_file` |
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

pub(crate) use emitter::WriterMsg;
pub use emitter::{
    AgentTurnStartedPayload, AiStreamDeltaPayload, AiStreamSettledPayload, BusMessagePayload,
    CommitCreatedPayload, EventSink, FileWrittenPayload, Provenance, SessionCreatedPayload,
    SessionDeletedPayload, ShipProgressPayload, ShipSettledPayload, SwarmEvent, SystemLogPayload,
    SystemMetricsPayload, WorkerInputPayload, WorkerKilledPayload, WorkerOutputPayload,
    WorkerSpawnedPayload, WorkerStatePayload, WorktreeCreatedPayload, WorktreeRemovedPayload,
};
