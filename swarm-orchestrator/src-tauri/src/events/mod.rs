//! Event system module.
//!
//! Re-exports all event types and the [`emit_event`] dispatcher
//! from the [`emitter`] submodule. The event system bridges
//! Rust backend state changes to the React frontend via
//! Tauri's event emission API.
//!
//! ## Event Channels
//!
//! | Channel            | Payload Type             | Trigger                        |
//! |--------------------|--------------------------|--------------------------------|
//! | `worker:spawned`   | [`WorkerSpawnedPayload`] | New worker registered          |
//! | `worker:killed`    | [`WorkerKilledPayload`]  | Worker terminated and removed  |
//! | `worker:output`    | [`WorkerOutputPayload`]  | PTY output data available      |
//! | `worker:state`     | [`WorkerStatePayload`]   | Worker state transition        |
//! | `session:created`  | [`SessionCreatedPayload`]| New session created            |
//! | `session:deleted`  | [`SessionDeletedPayload`]| Session removed                |
//! | `system:metrics`   | [`SystemMetricsPayload`] | Periodic metrics update        |
//! | `ai:stream_delta`  | [`AiStreamDeltaPayload`] | AI response text chunk         |
//! | `system:log`       | [`SystemLogPayload`]     | Backend log message            |
//! | `swarm://bus-message` | [`BusMessagePayload`] | Inter-agent bus message        |

pub mod emitter;

pub use emitter::{
    emit_event, AiStreamDeltaPayload, BusMessagePayload, SessionCreatedPayload,
    SessionDeletedPayload, SwarmEvent, SystemLogPayload, SystemMetricsPayload,
    WorkerKilledPayload, WorkerOutputPayload, WorkerSpawnedPayload, WorkerStatePayload,
};
