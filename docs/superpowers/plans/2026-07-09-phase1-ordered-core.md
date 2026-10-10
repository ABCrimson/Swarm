# SWARM v2 Phase 1 — Ordered Event Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every piece of frontend state arrives through ONE ordered, seq-numbered event stream backed by a SQLite event log — zero polling, gap-recoverable, replayable by construction.

**Architecture:** A new Rust `orchestration` module owns a single writer thread that assigns monotonic sequence numbers, persists domain events to SQLite (WAL), and emits every event as an envelope on the single Tauri channel `swarm://events`. The existing `emit_event()` becomes a thin router into the engine, so all current call sites keep working unchanged. The frontend replaces its nine per-channel listeners with one `event-bus.ts` consumer that validates with zod, detects seq gaps, backfills via an `events_since` command, and offers a `waitFor()` receipt helper. High-frequency telemetry (PTY output, metrics ticks, logs) flows through the ordered stream but is not persisted.

**Tech Stack:** Rust 1.98.0-beta (edition 2024), rusqlite 0.40.1 (bundled), Tauri v2.11.5, tokio 1.52.3, React 19.3 canary + React Compiler, zod 4.5 canary, Vitest 4.1.10.

## Global Constraints

- All dependency versions exact-pinned: `rusqlite = "=0.40.1"` with `features = ["bundled"]`. Zero `^`/`~` anywhere.
- Rust toolchain `1.98.0-beta` (already pinned in `rust-toolchain.toml` — do not change).
- No `std::sync::Mutex` — `parking_lot` only (house rule). The event-log writer uses a dedicated `std::thread` + `std::sync::mpsc` channel, which needs no mutex.
- Event JSON convention (must match existing emitter): type tags `snake_case`, payload fields `camelCase`.
- Errors: `thiserror` variants on `crate::error::AppError`; commands map to `String` for IPC (existing convention).
- Frontend: NO `useMemo`/`useCallback`/`memo`/`forwardRef` (React Compiler). zod imports from `"zod"` (never `"zod/v4"`). ESM only. pnpm only.
- Every task ends with its verification commands passing, then a commit. Commit messages end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Run all commands from `C:\Users\alber\Desktop\Projects\Swarm\swarm-orchestrator` (Rust commands from `src-tauri/`).

**File map (locked in):**

| File | Responsibility |
|---|---|
| `src-tauri/src/orchestration/mod.rs` | Module root, re-exports |
| `src-tauri/src/orchestration/log.rs` | `EventLog` — SQLite open/append/query, schema, WAL |
| `src-tauri/src/orchestration/engine.rs` | `OrchestrationEngine` — writer thread, seq assignment, persistence policy, single-channel emission |
| `src-tauri/src/commands/orchestration.rs` | `events_since` IPC command |
| `src-tauri/src/events/emitter.rs` | `SwarmEvent` (+ new `AiStreamSettled` variant); `emit_event` routed through engine |
| `src/lib/event-bus.ts` | Single consumer: validate, dispatch, gap backfill, `waitFor` receipts |
| `src/lib/tauri.ts` | Keeps generic `invoke`/`listen`; per-channel helpers deleted at cutover |
| `src/hooks/useWorkerEvents.ts`, `useSessionEvents.ts`, `useMetrics.ts`, plus any hook calling a per-channel helper | Rewired to `onEvent()` subscriptions |

---

### Task 1: SQLite EventLog

**Files:**
- Modify: `src-tauri/Cargo.toml` (add rusqlite)
- Create: `src-tauri/src/orchestration/mod.rs`
- Create: `src-tauri/src/orchestration/log.rs`
- Modify: `src-tauri/src/lib.rs` (register module)
- Modify: `src-tauri/src/error.rs` (new variant)

**Interfaces:**
- Consumes: `crate::error::AppError` (existing thiserror enum).
- Produces: `EventLog::open(path: &std::path::Path) -> Result<EventLog, AppError>`, `EventLog::open_in_memory() -> Result<EventLog, AppError>`, `EventLog::max_seq(&self) -> Result<u64, AppError>`, `EventLog::append(&mut self, seq: u64, ts: i64, event_type: &str, payload_json: &str) -> Result<(), AppError>`, `EventLog::events_since(&self, after_seq: u64, limit: u32) -> Result<Vec<StoredEvent>, AppError>`, `pub struct StoredEvent { pub seq: u64, pub ts: i64, pub event_type: String, pub payload: serde_json::Value }`.

- [ ] **Step 1: Add the dependency**

In `src-tauri/Cargo.toml` `[dependencies]`, after the `parking_lot` line, add:

```toml
rusqlite            = { version = "=0.40.1", features = ["bundled"] }
```

- [ ] **Step 2: Add the error variant**

In `src-tauri/src/error.rs`, add one variant to `AppError` following the exact attribute style of the neighboring variants (thiserror + the enum's existing serde derive):

```rust
    /// SQLite event-log operation failed.
    #[error("event log: {0}")]
    EventLog(String),
```

- [ ] **Step 3: Create the module skeleton**

Create `src-tauri/src/orchestration/mod.rs`:

```rust
//! Event-sourced orchestration core: ordered event log + single push bus.

pub mod log;

pub use log::{EventLog, StoredEvent};
```

In `src-tauri/src/lib.rs`, after `mod commands;` add:

```rust
pub mod orchestration;
```

- [ ] **Step 4: Write the failing tests**

Create `src-tauri/src/orchestration/log.rs` containing ONLY the test module first:

```rust
//! SQLite-backed append-only event log.

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_append_and_read_roundtrip() {
        let mut log = EventLog::open_in_memory().unwrap();
        log.append(1, 1000, "worker_spawned", r#"{"workerId":"a"}"#).unwrap();
        log.append(2, 1001, "worker_killed", r#"{"workerId":"a"}"#).unwrap();

        let events = log.events_since(0, 100).unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].seq, 1);
        assert_eq!(events[0].event_type, "worker_spawned");
        assert_eq!(events[0].payload["workerId"], "a");
        assert_eq!(events[1].seq, 2);
    }

    #[test]
    fn test_events_since_filters_and_limits() {
        let mut log = EventLog::open_in_memory().unwrap();
        for seq in 1..=10 {
            log.append(seq, 1000 + seq as i64, "worker_output", "{}").unwrap();
        }
        let events = log.events_since(7, 100).unwrap();
        assert_eq!(events.iter().map(|e| e.seq).collect::<Vec<_>>(), vec![8, 9, 10]);

        let limited = log.events_since(0, 3).unwrap();
        assert_eq!(limited.len(), 3);
        assert_eq!(limited[0].seq, 1);
    }

    #[test]
    fn test_max_seq_empty_and_populated() {
        let mut log = EventLog::open_in_memory().unwrap();
        assert_eq!(log.max_seq().unwrap(), 0);
        log.append(41, 1, "session_created", "{}").unwrap();
        log.append(42, 2, "session_deleted", "{}").unwrap();
        assert_eq!(log.max_seq().unwrap(), 42);
    }

    #[test]
    fn test_duplicate_seq_rejected() {
        let mut log = EventLog::open_in_memory().unwrap();
        log.append(1, 1, "session_created", "{}").unwrap();
        assert!(log.append(1, 2, "session_deleted", "{}").is_err());
    }
}
```

- [ ] **Step 5: Run tests to verify they fail**

Run: `cargo test orchestration::log -- --nocapture` (from `src-tauri/`)
Expected: FAIL to compile — `EventLog` not defined.

- [ ] **Step 6: Implement EventLog**

Prepend to `src-tauri/src/orchestration/log.rs` (above the test module):

```rust
use std::path::Path;

use rusqlite::Connection;

use crate::error::AppError;

/// One persisted event row.
#[derive(Debug, Clone)]
pub struct StoredEvent {
    /// Monotonic sequence number (unique, gapless for persisted events is NOT guaranteed — ephemeral events consume seqs too).
    pub seq: u64,
    /// Unix timestamp in milliseconds.
    pub ts: i64,
    /// Event type tag, matching `SwarmEvent`'s serde tag (e.g. `"worker_spawned"`).
    pub event_type: String,
    /// The event payload as JSON.
    pub payload: serde_json::Value,
}

/// Append-only SQLite event log (WAL mode).
pub struct EventLog {
    conn: Connection,
}

impl EventLog {
    /// Opens (or creates) the log at `path` and applies the schema.
    pub fn open(path: &Path) -> Result<Self, AppError> {
        let conn = Connection::open(path).map_err(|e| AppError::EventLog(e.to_string()))?;
        Self::init(conn)
    }

    /// In-memory log for tests.
    pub fn open_in_memory() -> Result<Self, AppError> {
        let conn = Connection::open_in_memory().map_err(|e| AppError::EventLog(e.to_string()))?;
        Self::init(conn)
    }

    fn init(conn: Connection) -> Result<Self, AppError> {
        conn.pragma_update(None, "journal_mode", "WAL")
            .map_err(|e| AppError::EventLog(e.to_string()))?;
        conn.pragma_update(None, "synchronous", "NORMAL")
            .map_err(|e| AppError::EventLog(e.to_string()))?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS events (
                seq     INTEGER PRIMARY KEY,
                ts      INTEGER NOT NULL,
                type    TEXT NOT NULL,
                payload TEXT NOT NULL
            ) STRICT;",
        )
        .map_err(|e| AppError::EventLog(e.to_string()))?;
        Ok(Self { conn })
    }

    /// Highest stored sequence number, or 0 when empty.
    pub fn max_seq(&self) -> Result<u64, AppError> {
        self.conn
            .query_row("SELECT COALESCE(MAX(seq), 0) FROM events", [], |row| {
                row.get::<_, i64>(0)
            })
            .map(|v| v as u64)
            .map_err(|e| AppError::EventLog(e.to_string()))
    }

    /// Appends one event. Fails on duplicate `seq` (PRIMARY KEY).
    pub fn append(
        &mut self,
        seq: u64,
        ts: i64,
        event_type: &str,
        payload_json: &str,
    ) -> Result<(), AppError> {
        self.conn
            .execute(
                "INSERT INTO events (seq, ts, type, payload) VALUES (?1, ?2, ?3, ?4)",
                (seq as i64, ts, event_type, payload_json),
            )
            .map(|_| ())
            .map_err(|e| AppError::EventLog(e.to_string()))
    }

    /// Returns up to `limit` persisted events with `seq > after_seq`, ascending.
    pub fn events_since(&self, after_seq: u64, limit: u32) -> Result<Vec<StoredEvent>, AppError> {
        let mut stmt = self
            .conn
            .prepare("SELECT seq, ts, type, payload FROM events WHERE seq > ?1 ORDER BY seq ASC LIMIT ?2")
            .map_err(|e| AppError::EventLog(e.to_string()))?;
        let rows = stmt
            .query_map((after_seq as i64, limit), |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            })
            .map_err(|e| AppError::EventLog(e.to_string()))?;

        let mut out = Vec::new();
        for row in rows {
            let (seq, ts, event_type, payload) =
                row.map_err(|e| AppError::EventLog(e.to_string()))?;
            out.push(StoredEvent {
                seq: seq as u64,
                ts,
                event_type,
                payload: serde_json::from_str(&payload)
                    .map_err(|e| AppError::EventLog(e.to_string()))?,
            });
        }
        Ok(out)
    }
}
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `cargo test orchestration::log` (from `src-tauri/`)
Expected: `4 passed`.

- [ ] **Step 8: Full backend gate + commit**

Run: `cargo fmt && cargo clippy -- -D warnings && cargo test`
Expected: clippy clean, all tests pass (65 unit total after this task).

```bash
git add -A
git commit -m "feat(orchestration): SQLite append-only event log

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: OrchestrationEngine writer thread

**Files:**
- Create: `src-tauri/src/orchestration/engine.rs`
- Modify: `src-tauri/src/orchestration/mod.rs`

**Interfaces:**
- Consumes: `EventLog` (Task 1), `crate::events::SwarmEvent` (existing enum in `src-tauri/src/events/emitter.rs`).
- Produces: `pub const EVENT_CHANNEL: &str = "swarm://events"`, `OrchestrationEngine::start(app: tauri::AppHandle, log: EventLog, db_path: Option<std::path::PathBuf>) -> OrchestrationEngine`, `OrchestrationEngine::record(&self, event: SwarmEvent)`, `OrchestrationEngine::db_path(&self) -> Option<&std::path::Path>`, `pub fn is_persistent(event: &SwarmEvent) -> bool`, `pub struct DomainEvent { pub seq: u64, pub ts: i64, #[serde(flatten)] pub event: SwarmEvent }` (serializes as `{"seq":n,"ts":n,"type":"...","payload":{...}}`).
- Ordering guarantee: ONE writer thread assigns seq AND emits, so wire order == seq order, always.

- [ ] **Step 1: Write the failing tests**

Create `src-tauri/src/orchestration/engine.rs` with the test module first:

```rust
//! Single-writer orchestration engine: seq assignment, persistence, emission.

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::{SwarmEvent, SystemMetricsPayload, WorkerOutputPayload, WorkerSpawnedPayload};
    use uuid::Uuid;

    fn spawned() -> SwarmEvent {
        SwarmEvent::WorkerSpawned(WorkerSpawnedPayload {
            worker_id: Uuid::nil(),
            name: "w".to_string(),
            pid: None,
        })
    }

    #[test]
    fn test_persistence_policy() {
        assert!(is_persistent(&spawned()));
        assert!(!is_persistent(&SwarmEvent::WorkerOutput(WorkerOutputPayload {
            worker_id: Uuid::nil(),
            data: "x".to_string(),
        })));
        assert!(!is_persistent(&SwarmEvent::SystemMetrics(SystemMetricsPayload {
            cpu_percent: 0.0,
            memory_mb: 0.0,
            worker_count: 0,
            ai_req_per_sec: 0.0,
            timestamp: 0,
        })));
    }

    #[test]
    fn test_domain_event_envelope_shape() {
        let envelope = DomainEvent { seq: 7, ts: 123, event: spawned() };
        let json = serde_json::to_value(&envelope).unwrap();
        assert_eq!(json["seq"], 7);
        assert_eq!(json["ts"], 123);
        assert_eq!(json["type"], "worker_spawned");
        assert_eq!(json["payload"]["workerId"], "00000000-0000-0000-0000-000000000000");
    }

    #[test]
    fn test_writer_persists_with_monotonic_seq() {
        // Drive the writer loop directly (no Tauri AppHandle in unit tests).
        let log = EventLog::open_in_memory().unwrap();
        let (tx, rx) = std::sync::mpsc::channel::<SwarmEvent>();
        tx.send(spawned()).unwrap();
        tx.send(SwarmEvent::WorkerOutput(WorkerOutputPayload {
            worker_id: Uuid::nil(),
            data: "ephemeral".to_string(),
        }))
        .unwrap();
        tx.send(spawned()).unwrap();
        drop(tx);

        let log = run_writer_loop(rx, log, |_envelope| {});
        let stored = log.events_since(0, 100).unwrap();
        // WorkerOutput consumed seq 2 but was not persisted.
        assert_eq!(stored.iter().map(|e| e.seq).collect::<Vec<_>>(), vec![1, 3]);
        assert_eq!(stored[0].event_type, "worker_spawned");
    }

    #[test]
    fn test_writer_resumes_seq_after_restart() {
        let log = EventLog::open_in_memory().unwrap();
        let (tx, rx) = std::sync::mpsc::channel::<SwarmEvent>();
        tx.send(spawned()).unwrap();
        drop(tx);
        let mut log = run_writer_loop(rx, log, |_| {});
        // Simulate a prior run reaching seq 41.
        log.append(41, 1, "session_created", "{}").unwrap();

        let (tx2, rx2) = std::sync::mpsc::channel::<SwarmEvent>();
        let mut seen = Vec::new();
        tx2.send(spawned()).unwrap();
        drop(tx2);
        let log = run_writer_loop(rx2, log, |envelope| seen.push(envelope.seq));
        assert_eq!(seen, vec![42]);
        assert_eq!(log.max_seq().unwrap(), 42);
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test orchestration::engine` (from `src-tauri/`)
Expected: FAIL to compile — `is_persistent`, `DomainEvent`, `run_writer_loop` not defined.

- [ ] **Step 3: Implement the engine**

Prepend to `src-tauri/src/orchestration/engine.rs`:

```rust
use std::path::{Path, PathBuf};
use std::sync::mpsc::{Receiver, Sender};

use serde::Serialize;
use tauri::Emitter;

use super::log::EventLog;
use crate::events::SwarmEvent;

/// The single Tauri channel every backend event is pushed on.
pub const EVENT_CHANNEL: &str = "swarm://events";

/// Ordered envelope wrapping every [`SwarmEvent`] on the wire.
///
/// Serializes as `{"seq": n, "ts": n, "type": "...", "payload": {...}}` —
/// the flattened `SwarmEvent` contributes `type` + `payload` (its existing
/// adjacently-tagged representation), preserving all payload shapes.
#[derive(Debug, Clone, Serialize)]
pub struct DomainEvent {
    /// Monotonic sequence number. Wire order == seq order.
    pub seq: u64,
    /// Unix timestamp in milliseconds, assigned by the writer thread.
    pub ts: i64,
    #[serde(flatten)]
    pub event: SwarmEvent,
}

/// Whether an event belongs in the durable log.
///
/// High-frequency telemetry flows through the ordered stream (it still
/// consumes sequence numbers) but is not history: it cannot be backfilled
/// after a gap and is not replayed.
pub fn is_persistent(event: &SwarmEvent) -> bool {
    !matches!(
        event,
        SwarmEvent::WorkerOutput(_) | SwarmEvent::SystemMetrics(_) | SwarmEvent::SystemLog(_)
    )
}

/// Handle to the single-writer orchestration engine.
///
/// `record` is fire-and-forget from any thread; the dedicated writer
/// thread assigns seq, persists (per policy), and emits — guaranteeing
/// total order on the wire.
#[derive(Clone)]
pub struct OrchestrationEngine {
    tx: Sender<SwarmEvent>,
    db_path: Option<PathBuf>,
}

impl OrchestrationEngine {
    /// Spawns the writer thread and returns the engine handle.
    ///
    /// `db_path` is retained so read-only connections (e.g. the
    /// `events_since` command) can be opened against the same file;
    /// pass `None` for in-memory logs.
    pub fn start(app: tauri::AppHandle, log: EventLog, db_path: Option<PathBuf>) -> Self {
        let (tx, rx) = std::sync::mpsc::channel::<SwarmEvent>();
        std::thread::Builder::new()
            .name("swarm-event-writer".to_string())
            .spawn(move || {
                run_writer_loop(rx, log, move |envelope| {
                    if let Err(e) = app.emit(EVENT_CHANNEL, envelope) {
                        tracing::error!(error = %e, "failed to emit domain event");
                    }
                });
            })
            .expect("failed to spawn event writer thread");
        Self { tx, db_path }
    }

    /// Enqueues an event for ordering, persistence, and emission.
    pub fn record(&self, event: SwarmEvent) {
        if self.tx.send(event).is_err() {
            tracing::error!("event writer thread is gone; event dropped");
        }
    }

    /// Path of the SQLite log, when file-backed.
    pub fn db_path(&self) -> Option<&Path> {
        self.db_path.as_deref()
    }
}

/// The writer loop. Extracted from the thread body so unit tests can
/// drive it synchronously without a Tauri `AppHandle`.
fn run_writer_loop(
    rx: Receiver<SwarmEvent>,
    mut log: EventLog,
    mut emit: impl FnMut(&DomainEvent),
) -> EventLog {
    let mut seq = log.max_seq().unwrap_or(0);
    while let Ok(event) = rx.recv() {
        seq += 1;
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        let envelope = DomainEvent { seq, ts, event };

        if is_persistent(&envelope.event) {
            match serde_json::to_value(&envelope.event) {
                Ok(tagged) => {
                    let event_type = tagged["type"].as_str().unwrap_or("unknown").to_string();
                    let payload = tagged["payload"].to_string();
                    if let Err(e) = log.append(seq, ts, &event_type, &payload) {
                        tracing::error!(seq, error = %e, "failed to persist event");
                    }
                }
                Err(e) => tracing::error!(seq, error = %e, "failed to serialize event"),
            }
        }

        emit(&envelope);
    }
    log
}
```

Update `src-tauri/src/orchestration/mod.rs`:

```rust
//! Event-sourced orchestration core: ordered event log + single push bus.

pub mod engine;
pub mod log;

pub use engine::{is_persistent, DomainEvent, OrchestrationEngine, EVENT_CHANNEL};
pub use log::{EventLog, StoredEvent};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test orchestration` (from `src-tauri/`)
Expected: 8 passed (4 log + 4 engine).

- [ ] **Step 5: Full backend gate + commit**

Run: `cargo fmt && cargo clippy -- -D warnings && cargo test`

```bash
git add -A
git commit -m "feat(orchestration): single-writer engine with monotonic seq and persistence policy

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Route emit_event through the engine (dual-emit transition)

**Files:**
- Modify: `src-tauri/src/events/emitter.rs:244-264` (the `emit_event` function)
- Modify: `src-tauri/src/lib.rs` (construct + manage engine in `setup`)

**Interfaces:**
- Consumes: `OrchestrationEngine::start`, `EventLog::open` (Tasks 1–2).
- Produces: unchanged signature `pub fn emit_event(app: &AppHandle, event: SwarmEvent)` — every existing call site keeps working. During transition it emits BOTH the ordered envelope on `swarm://events` (via engine) AND the legacy per-channel event (removed in Task 8).

- [ ] **Step 1: Manage the engine in setup**

In `src-tauri/src/lib.rs`, add to the imports: `use orchestration::{EventLog, OrchestrationEngine};` and `use tauri::Manager;` is already present. Inside `.setup(move |app| { ... })`, immediately after the icon block (before `load_sessions`), insert:

```rust
            // Ordered event core: SQLite log + single-writer engine.
            let db_path = app
                .path()
                .app_data_dir()
                .map_err(|e| Box::<dyn std::error::Error>::from(e.to_string()))?
                .join("swarm-events.db");
            if let Some(parent) = db_path.parent() {
                std::fs::create_dir_all(parent)?;
            }
            let event_log = EventLog::open(&db_path)
                .map_err(|e| Box::<dyn std::error::Error>::from(e.to_string()))?;
            let engine =
                OrchestrationEngine::start(app.handle().clone(), event_log, Some(db_path));
            app.manage(engine);
```

- [ ] **Step 2: Route emit_event through the engine**

In `src-tauri/src/events/emitter.rs`, replace the body of `emit_event` (keep the doc comment, update its channel-mapping table note to mention the envelope channel):

```rust
#[tracing::instrument(skip(app, event), fields(event_type))]
pub fn emit_event(app: &AppHandle, event: SwarmEvent) {
    // Ordered path: the engine assigns seq and emits on `swarm://events`.
    // `try_state` because unit tests construct AppHandles without setup.
    if let Some(engine) =
        app.try_state::<crate::orchestration::OrchestrationEngine>()
    {
        engine.record(event.clone());
    }

    // Legacy per-channel path — removed in the frontend-cutover cleanup task.
    let (channel, result) = match &event {
        SwarmEvent::WorkerSpawned(p) => ("worker:spawned", app.emit("worker:spawned", p)),
        SwarmEvent::WorkerKilled(p) => ("worker:killed", app.emit("worker:killed", p)),
        SwarmEvent::WorkerOutput(p) => ("worker:output", app.emit("worker:output", p)),
        SwarmEvent::WorkerState(p) => ("worker:state", app.emit("worker:state", p)),
        SwarmEvent::SessionCreated(p) => ("session:created", app.emit("session:created", p)),
        SwarmEvent::SessionDeleted(p) => ("session:deleted", app.emit("session:deleted", p)),
        SwarmEvent::SystemMetrics(p) => ("system:metrics", app.emit("system:metrics", p)),
        SwarmEvent::AiStreamDelta(p) => ("ai:stream_delta", app.emit("ai:stream_delta", p)),
        SwarmEvent::SystemLog(p) => ("system:log", app.emit("system:log", p)),
        SwarmEvent::BusMessage(p) => ("swarm://bus-message", app.emit("swarm://bus-message", p)),
    };

    tracing::Span::current().record("event_type", tracing::field::display(&channel));

    if let Err(e) = result {
        tracing::error!(channel = channel, error = %e, "failed to emit event");
    }
}
```

- [ ] **Step 3: Full backend gate**

Run: `cargo fmt && cargo clippy -- -D warnings && cargo test` (from `src-tauri/`)
Expected: all green — no test changes needed (emit_event's signature is unchanged).

- [ ] **Step 4: Smoke-check the app still boots**

Run: `pnpm test:e2e` (from project root; uses the Vite dev server, Tauri APIs are absent in the browser so the engine path is inert there)
Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(orchestration): route emit_event through engine, dual-emit during transition

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: AiStreamSettled receipt

**Files:**
- Modify: `src-tauri/src/events/emitter.rs` (new variant + payload + tests)
- Modify: `src-tauri/src/ai/queue.rs` (emit at the two terminal sites)
- Modify: `src-tauri/src/orchestration/engine.rs` (policy: settled IS persistent — no change needed, only non-listed variants are ephemeral; verify test)

**Interfaces:**
- Consumes: existing `AiStreamDeltaPayload` flow in `ai/queue.rs` (the task spawned per request, which already guarantees a terminal `done:true` delta on success and failure — find both sites by searching `done: true` in `src-tauri/src/ai/`).
- Produces: `SwarmEvent::AiStreamSettled(AiStreamSettledPayload)` with `pub struct AiStreamSettledPayload { pub request_id: String, pub status: String, pub error: Option<String> }`, `status` one of `"ok" | "error"`. Type tag on the wire: `"ai_stream_settled"`. This is the first formal *receipt*: `waitFor` in Task 6 targets it.

- [ ] **Step 1: Write the failing test**

Add to the test module in `src-tauri/src/events/emitter.rs`:

```rust
    #[test]
    fn test_ai_stream_settled_roundtrip() {
        let event = SwarmEvent::AiStreamSettled(AiStreamSettledPayload {
            request_id: "req-9".to_string(),
            status: "error".to_string(),
            error: Some("rate limited".to_string()),
        });
        let json = serde_json::to_string(&event).expect("serialize");
        assert!(json.contains("\"type\":\"ai_stream_settled\""));
        assert!(json.contains("\"requestId\":\"req-9\""));
        let deserialized: SwarmEvent = serde_json::from_str(&json).expect("deserialize");
        if let SwarmEvent::AiStreamSettled(p) = deserialized {
            assert_eq!(p.status, "error");
            assert_eq!(p.error.as_deref(), Some("rate limited"));
        } else {
            panic!("expected AiStreamSettled variant");
        }
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test test_ai_stream_settled` (from `src-tauri/`)
Expected: FAIL to compile — variant not defined.

- [ ] **Step 3: Add the variant and payload**

In `src-tauri/src/events/emitter.rs`, add to the `SwarmEvent` enum after `AiStreamDelta`:

```rust
    /// Terminal receipt for an AI stream: exactly one per request.
    AiStreamSettled(AiStreamSettledPayload),
```

Add the payload struct after `AiStreamDeltaPayload`:

```rust
/// Payload for the `ai_stream_settled` receipt.
///
/// Emitted exactly once per AI request, after the final delta, on both
/// success and failure paths. Frontends and tests await this receipt
/// instead of polling stream state.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiStreamSettledPayload {
    /// Correlation ID matching the original AI request.
    pub request_id: String,
    /// `"ok"` or `"error"`.
    pub status: String,
    /// Error description when `status == "error"`.
    pub error: Option<String>,
}
```

In the legacy `match` inside `emit_event`, add an arm (channel `ai:stream_settled`):

```rust
        SwarmEvent::AiStreamSettled(p) => ("ai:stream_settled", app.emit("ai:stream_settled", p)),
```

- [ ] **Step 4: Emit at the terminal sites**

In `src-tauri/src/ai/queue.rs`, locate the spawned task that runs the stream (search for where `stream_message` is awaited and its `Ok`/`Err` arms — the sites that today guarantee the final `done: true` delta). Immediately after the success terminal, add:

```rust
                    emit_event(
                        &app,
                        SwarmEvent::AiStreamSettled(AiStreamSettledPayload {
                            request_id: request_id.clone(),
                            status: "ok".to_string(),
                            error: None,
                        }),
                    );
```

And after the error terminal (where the failure done-delta is emitted):

```rust
                    emit_event(
                        &app,
                        SwarmEvent::AiStreamSettled(AiStreamSettledPayload {
                            request_id: request_id.clone(),
                            status: "error".to_string(),
                            error: Some(e.to_string()),
                        }),
                    );
```

Adjust the `use crate::events::...` import in `queue.rs` to include `AiStreamSettledPayload`. Match the surrounding variable names exactly (the app handle and request id bindings already in scope at those sites).

- [ ] **Step 5: Run tests to verify they pass**

Run: `cargo test && cargo clippy -- -D warnings && cargo fmt` (from `src-tauri/`)
Expected: all green, including the new roundtrip test.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(ai): ai_stream_settled receipt, exactly once per request

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: events_since IPC command

**Files:**
- Create: `src-tauri/src/commands/orchestration.rs`
- Modify: `src-tauri/src/commands/mod.rs` (add `pub mod orchestration;` matching the sibling module declarations)
- Modify: `src-tauri/src/lib.rs` (register the command)

**Interfaces:**
- Consumes: `OrchestrationEngine::db_path()` (Task 2), `EventLog::open`, `EventLog::events_since` (Task 1).
- Produces: IPC command `events_since(after_seq: u64) -> Vec<serde_json::Value>` where each element is `{"seq":n,"ts":n,"type":"...","payload":{...}}` — the same shape as live `swarm://events` envelopes. Hard cap 5000 rows per call; the frontend loops if it gets exactly the cap.

- [ ] **Step 1: Create the command**

Create `src-tauri/src/commands/orchestration.rs`:

```rust
//! IPC commands for the ordered event core.

use crate::orchestration::{EventLog, OrchestrationEngine};

/// Maximum events returned per call; callers page by repeating the
/// call with the last received seq until fewer than the cap arrive.
const PAGE_LIMIT: u32 = 5000;

/// Returns persisted events with `seq > after_seq`, ascending, capped
/// at 5000. Shape matches live `swarm://events` envelopes. Used by the
/// frontend to backfill after a detected sequence gap and for replay.
///
/// Ephemeral events (worker output, metrics, logs) are not persisted
/// and therefore never appear here.
#[tauri::command]
#[tracing::instrument(skip(engine))]
pub async fn events_since(
    engine: tauri::State<'_, OrchestrationEngine>,
    after_seq: u64,
) -> Result<Vec<serde_json::Value>, String> {
    let Some(path) = engine.db_path().map(std::path::Path::to_path_buf) else {
        return Ok(Vec::new());
    };

    tokio::task::spawn_blocking(move || {
        let log = EventLog::open(&path).map_err(|e| e.to_string())?;
        let events = log
            .events_since(after_seq, PAGE_LIMIT)
            .map_err(|e| e.to_string())?;
        Ok(events
            .into_iter()
            .map(|e| {
                serde_json::json!({
                    "seq": e.seq,
                    "ts": e.ts,
                    "type": e.event_type,
                    "payload": e.payload,
                })
            })
            .collect())
    })
    .await
    .map_err(|e| e.to_string())?
}
```

- [ ] **Step 2: Register it**

In `src-tauri/src/commands/mod.rs` add `pub mod orchestration;` alongside the sibling `pub mod` lines. In `src-tauri/src/lib.rs`'s `invoke_handler`, after the metrics command add:

```rust
            // Orchestration commands
            commands::orchestration::events_since,
```

- [ ] **Step 3: Verify with the full gate**

Run: `cargo fmt && cargo clippy -- -D warnings && cargo test` (from `src-tauri/`)
Expected: all green. (WAL mode makes the read-only open safe while the writer thread holds its connection; the log tests from Task 1 already cover query correctness.)

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(orchestration): events_since backfill/replay command

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Frontend event bus

**Files:**
- Create: `src/lib/event-bus.ts`
- Test: `src/__tests__/lib/event-bus.test.ts`

**Interfaces:**
- Consumes: `listen` and `invoke` from `src/lib/tauri.ts` (existing generic helpers: `listen<T>(event: string, handler: (payload: T) => void): Promise<UnlistenFn>` and `invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T>` — verify the exact `invoke` signature in `src/lib/tauri.ts` and match it).
- Produces:
  - `interface DomainEvent { seq: number; ts: number; type: string; payload: unknown }`
  - `onEvent(type: string, handler: (e: DomainEvent) => void): () => void` — subscribe, returns unsubscribe
  - `connectEventBus(): Promise<() => void>` — single `swarm://events` listener; validates envelopes with zod; on `seq > lastSeq + 1` backfills via `invoke("events_since", { afterSeq: lastSeq })` (paging while full pages return) and dispatches missed events in order, skipping any seq already seen
  - `waitFor(predicate: (e: DomainEvent) => boolean, timeoutMs?: number): Promise<DomainEvent>` — receipt helper, default 5000ms, rejects on timeout
  - `resetEventBus(): void` — test-only state reset

- [ ] **Step 1: Write the failing tests**

Create `src/__tests__/lib/event-bus.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const listeners = new Map<string, (payload: unknown) => void>();
const invokeMock = vi.fn();

vi.mock("#lib/tauri", () => ({
  listen: vi.fn(async (event: string, handler: (payload: unknown) => void) => {
    listeners.set(event, handler);
    return () => listeners.delete(event);
  }),
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import {
  connectEventBus,
  type DomainEvent,
  onEvent,
  resetEventBus,
  waitFor,
} from "#lib/event-bus";

function push(e: DomainEvent): void {
  listeners.get("swarm://events")?.(e);
}

const ev = (seq: number, type = "worker_spawned"): DomainEvent => ({
  seq,
  ts: seq * 1000,
  type,
  payload: { workerId: `w-${seq}` },
});

describe("event-bus", () => {
  beforeEach(() => {
    listeners.clear();
    invokeMock.mockReset();
    resetEventBus();
  });

  it("dispatches events to type subscribers in order", async () => {
    await connectEventBus();
    const seen: number[] = [];
    onEvent("worker_spawned", (e) => seen.push(e.seq));
    push(ev(1));
    push(ev(2));
    expect(seen).toEqual([1, 2]);
  });

  it("unsubscribe stops delivery", async () => {
    await connectEventBus();
    const seen: number[] = [];
    const off = onEvent("worker_spawned", (e) => seen.push(e.seq));
    push(ev(1));
    off();
    push(ev(2));
    expect(seen).toEqual([1]);
  });

  it("backfills a seq gap via events_since and preserves order", async () => {
    invokeMock.mockResolvedValueOnce([ev(2), ev(3)]);
    await connectEventBus();
    const seen: number[] = [];
    onEvent("worker_spawned", (e) => seen.push(e.seq));

    push(ev(1));
    push(ev(4)); // gap: 2,3 missing
    await vi.waitFor(() => expect(seen).toEqual([1, 2, 3, 4]));
    expect(invokeMock).toHaveBeenCalledWith("events_since", { afterSeq: 1 });
  });

  it("does not double-dispatch backfilled events already seen live", async () => {
    invokeMock.mockResolvedValueOnce([ev(2), ev(3), ev(4)]);
    await connectEventBus();
    const seen: number[] = [];
    onEvent("worker_spawned", (e) => seen.push(e.seq));

    push(ev(1));
    push(ev(4)); // triggers backfill that ALSO contains 4
    await vi.waitFor(() => expect(seen).toEqual([1, 2, 3, 4]));
  });

  it("waitFor resolves on a matching receipt", async () => {
    await connectEventBus();
    const settled = waitFor((e) => e.type === "ai_stream_settled");
    push({ seq: 1, ts: 1, type: "ai_stream_settled", payload: { requestId: "r1", status: "ok" } });
    await expect(settled).resolves.toMatchObject({ type: "ai_stream_settled" });
  });

  it("waitFor rejects on timeout", async () => {
    vi.useFakeTimers();
    await connectEventBus();
    const settled = waitFor((e) => e.type === "never", 100);
    vi.advanceTimersByTime(150);
    await expect(settled).rejects.toThrow(/timeout/i);
    vi.useRealTimers();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run src/__tests__/lib/event-bus.test.ts`
Expected: FAIL — module `#lib/event-bus` not found.

- [ ] **Step 3: Implement the bus**

Create `src/lib/event-bus.ts`:

```ts
import * as z from "zod";
import { invoke, listen } from "#lib/tauri";

/** Ordered envelope for every backend event (mirrors Rust `DomainEvent`). */
export interface DomainEvent {
  readonly seq: number;
  readonly ts: number;
  readonly type: string;
  readonly payload: unknown;
}

const DomainEventSchema = z.object({
  seq: z.number(),
  ts: z.number(),
  type: z.string(),
  payload: z.unknown(),
});

const EVENT_CHANNEL = "swarm://events";
/** Server page size for events_since — a full page means "ask again". */
const PAGE_LIMIT = 5000;

type Handler = (e: DomainEvent) => void;

const handlers = new Map<string, Set<Handler>>();
const wildcard = new Set<Handler>();
let lastSeq = 0;
let backfilling = false;

/** Subscribe to one event type ("*" for all). Returns unsubscribe. */
export function onEvent(type: string, handler: Handler): () => void {
  const set = type === "*" ? wildcard : (handlers.get(type) ?? new Set<Handler>());
  if (type !== "*") handlers.set(type, set);
  set.add(handler);
  return () => set.delete(handler);
}

function dispatch(e: DomainEvent): void {
  if (e.seq <= lastSeq) return; // already seen (live/backfill race)
  lastSeq = e.seq;
  for (const h of handlers.get(e.type) ?? []) h(e);
  for (const h of wildcard) h(e);
}

async function backfill(afterSeq: number): Promise<void> {
  if (backfilling) return;
  backfilling = true;
  try {
    let cursor = afterSeq;
    for (;;) {
      const page = await invoke<DomainEvent[]>("events_since", { afterSeq: cursor });
      for (const raw of page) {
        const parsed = DomainEventSchema.safeParse(raw);
        if (parsed.success) dispatch(parsed.data as DomainEvent);
      }
      if (page.length < PAGE_LIMIT) break;
      cursor = page[page.length - 1]?.seq ?? cursor;
    }
  } catch (err) {
    console.error("event-bus backfill failed:", err);
  } finally {
    backfilling = false;
  }
}

/**
 * Connects the single ordered event stream. Call exactly once at app
 * bootstrap. Gaps in seq trigger a persisted-event backfill; ephemeral
 * events (worker output, metrics, logs) are not persisted and are
 * accepted as lost across a gap.
 */
export async function connectEventBus(): Promise<() => void> {
  return listen<unknown>(EVENT_CHANNEL, (raw) => {
    const parsed = DomainEventSchema.safeParse(raw);
    if (!parsed.success) {
      console.error("event-bus: invalid envelope", parsed.error);
      return;
    }
    const e = parsed.data as DomainEvent;
    if (lastSeq > 0 && e.seq > lastSeq + 1) {
      const from = lastSeq;
      void backfill(from);
    }
    dispatch(e);
  });
}

/** Awaits the first event matching `predicate` — the receipt primitive. */
export function waitFor(
  predicate: (e: DomainEvent) => boolean,
  timeoutMs = 5000,
): Promise<DomainEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error(`waitFor timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    const off = onEvent("*", (e) => {
      if (predicate(e)) {
        clearTimeout(timer);
        off();
        resolve(e);
      }
    });
  });
}

/** Test-only: clears subscriptions and seq tracking. */
export function resetEventBus(): void {
  handlers.clear();
  wildcard.clear();
  lastSeq = 0;
  backfilling = false;
}
```

Note for the implementer: `dispatch` deliberately drops `e.seq <= lastSeq`, which also skips the gap-triggering live event if the backfill already delivered it — re-check the backfill test expectations against this ordering (the live event with seq 4 arrives synchronously before the async backfill resolves, so dispatch order is 1, 4, then 2–3 are dropped-or-dispatched by seq guard... run the tests; if ordering `[1, 2, 3, 4]` fails because 4 dispatched first, buffer the gap-event: hold events arriving during `backfilling` in a `pending: DomainEvent[]` array and flush it seq-sorted after backfill completes. Implement the buffer if and only if the test demands it — the test is the contract).

- [ ] **Step 4: Run tests until they pass**

Run: `pnpm exec vitest run src/__tests__/lib/event-bus.test.ts`
Expected: 6 passed. If the ordering test fails, implement the pending-buffer described in Step 3's note and re-run.

- [ ] **Step 5: Gate + commit**

Run: `pnpm exec biome check --write . && pnpm typecheck && pnpm test`

```bash
git add -A
git commit -m "feat(frontend): single ordered event bus with gap backfill and receipts

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Cut the frontend over to the bus

**Files:**
- Modify: `src/App.tsx` (connect the bus once at mount)
- Modify: every consumer of a per-channel helper from `src/lib/tauri.ts` — enumerate them first with: `grep -rn "onWorkerSpawned\|onWorkerOutput\|onWorkerState\|onSystemMetrics\|onSessionCreated\|onSessionDeleted\|onAiStreamDelta\|onSystemLog" src --include="*.ts" --include="*.tsx"` (expected: `src/hooks/useWorkerEvents.ts`, `src/hooks/useSessionEvents.ts`, `src/hooks/useMetrics.ts`, `src/hooks/useAiStream.ts` and/or `src/hooks/useStream.ts`, log wiring in `src/lib/log-store.ts` or a hook)
- Modify: `src/lib/tauri.ts` (delete the per-channel helpers; keep generic `invoke`/`listen`)
- Test: update the corresponding hook tests under `src/__tests__/hooks/`

**Interfaces:**
- Consumes: `onEvent`, `connectEventBus` (Task 6). Event type keys are the Rust serde tags: `"worker_spawned"`, `"worker_killed"`, `"worker_output"`, `"worker_state"`, `"session_created"`, `"session_deleted"`, `"system_metrics"`, `"ai_stream_delta"`, `"ai_stream_settled"`, `"system_log"`, `"bus_message"`.
- Produces: no new API — same store updates, now sourced from one ordered stream. **This task fixes by construction the pre-existing `"ai:stream:delta"` vs `"ai:stream_delta"` channel-name mismatch in `src/lib/tauri.ts:167`.**

- [ ] **Step 1: Connect the bus at bootstrap**

In `src/App.tsx`, inside the root component add a mount effect (pattern per house style — no useCallback):

```tsx
import { useEffect } from "react";
import { connectEventBus } from "#lib/event-bus";

// inside the App component body:
  useEffect(() => {
    let dispose: (() => void) | undefined;
    let cancelled = false;
    void connectEventBus().then((off) => {
      if (cancelled) off();
      else dispose = off;
    });
    return () => {
      cancelled = true;
      dispose?.();
    };
  }, []);
```

- [ ] **Step 2: Rewire each consumer**

For every hit from the grep in **Files**, replace the per-channel helper subscription with `onEvent`. The payload arrives as `e.payload` — cast through the zod schemas already in `src/store/types.ts` where they exist. Representative transformation (apply the same shape to each site):

```ts
// BEFORE (useWorkerEvents.ts style):
// const un = await onWorkerSpawned((worker) => { ... });

// AFTER:
import { onEvent } from "#lib/event-bus";

useEffect(() => {
  const offs = [
    onEvent("worker_spawned", (e) => {
      const p = e.payload as { workerId: string; name: string; pid: number | null };
      addWorker({ id: p.workerId, name: p.name, pid: p.pid ?? undefined });
    }),
    onEvent("worker_state", (e) => {
      const p = e.payload as { workerId: string; state: WorkerState };
      updateState(p.workerId, p.state);
    }),
    onEvent("worker_killed", (e) => {
      const p = e.payload as { workerId: string };
      removeWorker(p.workerId);
    }),
  ];
  return () => {
    for (const off of offs) off();
  };
}, [addWorker, updateState, removeWorker]);
```

Keep each hook's existing store-mutation logic byte-for-byte where possible — only the subscription mechanism changes. IMPORTANT: field names inside payloads are camelCase (`workerId`, `requestId`, `sessionId`) — they were already camelCase on the legacy channels, so the store logic should not need changes. The AI stream consumer additionally gains: on `ai_stream_settled` with `status === "error"`, surface `payload.error` through the existing stream-error path (the hook's current failure handling).

- [ ] **Step 3: Delete the per-channel helpers**

In `src/lib/tauri.ts`, delete the exported `onWorkerSpawned`, `onWorkerOutput`, `onWorkerState`, `onSystemMetrics`, `onSessionCreated`, `onSessionDeleted`, `onAiStreamDelta`, `onSystemLog` functions (lines ~125–175). Keep `invoke`, `listen`, and any non-event helpers. Grep to confirm zero remaining references.

- [ ] **Step 4: Update the hook tests**

Update tests under `src/__tests__/hooks/` that mocked the old helpers: mock `#lib/event-bus`'s `onEvent` instead, capturing handlers per type and invoking them with `DomainEvent` envelopes. Follow the mock pattern from `src/__tests__/lib/event-bus.test.ts` Step 1. Every previously-passing behavioral assertion must still pass — the assertions are the contract; only the delivery mechanism changed.

- [ ] **Step 5: Full frontend gate**

Run: `pnpm exec biome check --write . && pnpm typecheck && pnpm test && pnpm test:e2e`
Expected: all green, 3/3 e2e.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor(frontend): all state flows through the single ordered event bus

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: Remove the legacy channels + docs + full verification

**Files:**
- Modify: `src-tauri/src/events/emitter.rs` (delete the legacy per-channel match; engine-only emission)
- Modify: `docs/api.md`, `docs/architecture.md` (document `swarm://events`, the envelope, `events_since`, receipts, persistence policy)
- Modify: `CHANGELOG.md` (0.11.0 entry)

**Interfaces:**
- Consumes: everything above.
- Produces: the final `emit_event`:

```rust
#[tracing::instrument(skip(app, event))]
pub fn emit_event(app: &AppHandle, event: SwarmEvent) {
    if let Some(engine) = app.try_state::<crate::orchestration::OrchestrationEngine>() {
        engine.record(event);
    } else {
        tracing::warn!("emit_event before engine setup; event dropped");
    }
}
```

- [ ] **Step 1: Delete the legacy emission** — replace `emit_event` with the version above; remove the now-unused `Emitter` import from emitter.rs if nothing else in the file uses it.

- [ ] **Step 2: Verify no frontend listener references legacy channels**

Run: `grep -rn '"worker:\|"session:\|"system:\|"ai:\|swarm://bus-message' src --include="*.ts" --include="*.tsx" | grep -v __tests__`
Expected: zero hits (Task 7 removed them). If any remain, rewire them to `onEvent` as in Task 7 Step 2.

- [ ] **Step 3: Docs** — in `docs/api.md`: replace the per-channel event reference table with the `swarm://events` envelope contract (`{seq, ts, type, payload}`), the full type-tag list including `ai_stream_settled`, the persistence policy (worker_output/system_metrics/system_log are ephemeral), and the `events_since(after_seq)` command with its 5000-row paging. In `docs/architecture.md`: add an "Ordered Event Core" section describing the writer thread, SQLite WAL log at `<app-data>/swarm-events.db`, and the receipt pattern. In `CHANGELOG.md`: add an `## 0.11.0 — 2026-MM-DD` entry titled "Phase 1: ordered event core" summarizing the above (fill the actual date at execution time).

- [ ] **Step 4: Full verification — every gate**

```bash
pnpm exec biome check --write .
pnpm typecheck
pnpm test
pnpm exec vite build
pnpm test:e2e
cd src-tauri && cargo fmt && cargo clippy -- -D warnings && cargo test && cd ..
```

Expected: all green. Then bump `version` to `0.11.0` in `package.json`, `src-tauri/tauri.conf.json`, and `src-tauri/Cargo.toml` (`cargo check` refreshes the lockfile).

- [ ] **Step 5: Manual receipt smoke test (the Phase-1 acceptance check)**

Run: `pnpm tauri:dev`. In the running app: spawn a worker from the Workers page, then in devtools console verify ordered envelopes arrive:

```js
window.__TAURI__ === undefined // withGlobalTauri is false — instead:
```

Since `withGlobalTauri` is false, verify via the UI instead: the worker appears in the topology (worker_spawned receipt consumed), terminal output streams (ephemeral events flowing), and killing the worker removes it (worker_killed). Close and relaunch the app: `<app-data>/swarm-events.db` exists and grows (check file size) — the log is persisting.

- [ ] **Step 6: Final commit**

```bash
git add -A
git commit -m "feat(orchestration)!: single ordered event channel replaces legacy per-channel events

Phase 1 of the v2 reimagining: swarm://events carries every backend
event as a seq-ordered envelope backed by a SQLite log; frontends
backfill gaps via events_since and await typed receipts instead of
polling. Legacy per-channel events removed.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Self-review notes (already applied)

- **Spec coverage:** proposal Phase-1 bullets → OrchestrationEngine (Tasks 1–2), single ordered push bus (Tasks 3, 8), typed receipts (Tasks 4, 6 `waitFor`), replay foundation (`events_since` full-log query, Task 5). Replay *UI* is deliberately out of scope for Phase 1 (data layer only) — noted in the proposal's phase text as "replay becomes re-run the log"; the UI lands with Phase 3's diff/checkpoint surfaces.
- **Type consistency:** `DomainEvent` field names (`seq`/`ts`/`type`/`payload`) match across Rust serde, the `events_since` JSON, and the zod schema. Event type keys in Task 7 match `SwarmEvent`'s serde tags exactly (including new `ai_stream_settled`).
- **Known judgment point:** Task 6's gap-ordering test may require the pending-buffer refinement documented inline — the test is the contract; the note tells the implementer exactly what to build if the simple seq-guard fails it.
