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

pub mod emitter;

pub use emitter::{
    AiStreamDeltaPayload, AiStreamSettledPayload, BusMessagePayload, CommitCreatedPayload,
    EventSink, SessionCreatedPayload, SessionDeletedPayload, ShipProgressPayload,
    ShipSettledPayload, SwarmEvent, SystemLogPayload, SystemMetricsPayload, WorkerKilledPayload,
    WorkerOutputPayload, WorkerSpawnedPayload, WorkerStatePayload, WorktreeCreatedPayload,
    WorktreeRemovedPayload,
};
