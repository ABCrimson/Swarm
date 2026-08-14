//! SQLite-backed append-only event log.

use std::path::Path;

use rusqlite::{Connection, OptionalExtension};
use uuid::Uuid;

use crate::error::AppError;
use crate::events::Provenance;

/// Current schema revision, tracked via SQLite's built-in `PRAGMA
/// user_version` (an integer stored in the database header — no extra
/// table, no migration-tracking row to keep in sync). See
/// [`EventLog::migrate`].
const SCHEMA_VERSION: i64 = 1;

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
    /// UUID of the worker whose action caused this event, if known —
    /// `NULL` for every row persisted before Phase 2's migration
    /// (honestly unattributed, not a guess).
    pub origin_worker: Option<Uuid>,
    /// Seq of the event this one is causally reacting to, if known.
    pub cause_seq: Option<u64>,
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
        // A WAL checkpoint can briefly hold the writer lock; without a
        // busy timeout a concurrent read (e.g. an events_since backfill)
        // would fail instantly with SQLITE_BUSY instead of waiting it out.
        conn.busy_timeout(std::time::Duration::from_secs(2))
            .map_err(|e| AppError::EventLog(e.to_string()))?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS events (
                seq     INTEGER PRIMARY KEY,
                ts      INTEGER NOT NULL,
                type    TEXT NOT NULL,
                payload TEXT NOT NULL
            ) STRICT;
            CREATE INDEX IF NOT EXISTS idx_events_type_seq ON events(type, seq);",
        )
        .map_err(|e| AppError::EventLog(e.to_string()))?;

        Self::migrate(&conn)?;

        Ok(Self { conn })
    }

    /// Applies the `PRAGMA user_version` migration ladder, starting
    /// from whatever `CREATE TABLE IF NOT EXISTS` above already
    /// produced (legacy-shape-first — a brand-new database and an
    /// existing pre-provenance one both land here with the identical
    /// 4-column table, then walk the same ladder rungs). Each rung is
    /// idempotent and runs only when `user_version` is below it, so a
    /// second `init()` against an already-migrated database is a no-op.
    ///
    /// v0 → v1: adds `origin_worker TEXT` / `cause_seq INTEGER` (STRICT
    /// permits nullable typed columns; every existing row's new columns
    /// come back `NULL` — the truthful historical value, not a guess)
    /// and the partial composite index
    /// `idx_events_origin_seq(origin_worker, seq) WHERE origin_worker
    /// IS NOT NULL` for worker-scoped seq-range queries.
    fn migrate(conn: &Connection) -> Result<(), AppError> {
        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .map_err(|e| AppError::EventLog(e.to_string()))?;

        if version < 1 {
            conn.execute_batch(
                "ALTER TABLE events ADD COLUMN origin_worker TEXT;
                 ALTER TABLE events ADD COLUMN cause_seq INTEGER;
                 CREATE INDEX IF NOT EXISTS idx_events_origin_seq
                     ON events(origin_worker, seq) WHERE origin_worker IS NOT NULL;
                 PRAGMA user_version = 1;",
            )
            .map_err(|e| AppError::EventLog(e.to_string()))?;
        }

        debug_assert_eq!(
            SCHEMA_VERSION, 1,
            "bump this ladder when SCHEMA_VERSION grows"
        );
        Ok(())
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

    /// Appends one event, along with its causal attribution. Fails on
    /// duplicate `seq` (PRIMARY KEY).
    pub fn append(
        &mut self,
        seq: u64,
        ts: i64,
        event_type: &str,
        payload_json: &str,
        provenance: &Provenance,
    ) -> Result<(), AppError> {
        self.conn
            .execute(
                "INSERT INTO events (seq, ts, type, payload, origin_worker, cause_seq) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                (
                    seq as i64,
                    ts,
                    event_type,
                    payload_json,
                    provenance.origin_worker.map(|u| u.to_string()),
                    provenance.cause_seq.map(|s| s as i64),
                ),
            )
            .map(|_| ())
            .map_err(|e| AppError::EventLog(e.to_string()))
    }

    /// Returns up to `limit` persisted events with `seq > after_seq`, ascending.
    pub fn events_since(&self, after_seq: u64, limit: u32) -> Result<Vec<StoredEvent>, AppError> {
        // Clamp rather than cast-wrap: after_seq as i64 would go negative
        // for values > i64::MAX, which turns "give me everything past the
        // end" into "give me everything" — silently replaying the log.
        let after_seq_i64 = i64::try_from(after_seq).unwrap_or(i64::MAX);
        let mut stmt = self
            .conn
            .prepare(
                "SELECT seq, ts, type, payload, origin_worker, cause_seq FROM events \
                 WHERE seq > ?1 ORDER BY seq ASC LIMIT ?2",
            )
            .map_err(|e| AppError::EventLog(e.to_string()))?;
        let rows = stmt
            .query_map((after_seq_i64, limit), |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, Option<i64>>(5)?,
                ))
            })
            .map_err(|e| AppError::EventLog(e.to_string()))?;

        let mut out = Vec::new();
        for row in rows {
            let (seq, ts, event_type, payload, origin_worker, cause_seq) =
                row.map_err(|e| AppError::EventLog(e.to_string()))?;
            let origin_worker = origin_worker
                .map(|s| Uuid::parse_str(&s))
                .transpose()
                .map_err(|e| AppError::EventLog(format!("stored origin_worker: {e}")))?;
            out.push(StoredEvent {
                seq: seq as u64,
                ts,
                event_type,
                origin_worker,
                cause_seq: cause_seq.map(|s| s as u64),
                payload: serde_json::from_str(&payload)
                    .map_err(|e| AppError::EventLog(e.to_string()))?,
            });
        }
        Ok(out)
    }

    /// Returns the `seq` of the first persisted event of `event_type`
    /// whose JSON payload's `workerId` field equals `worker_id`, or
    /// `None` if no such event exists.
    ///
    /// Used by the ship chain (`commands/git.rs::resolve_seq_range`) to
    /// recover a never-shipped worker's `worktree_created` seq — the
    /// `idx_events_type_seq` index (on `(type, seq)`) lets this narrow
    /// to `event_type`'s rows via an index range scan in ascending
    /// `seq` order before filtering by `workerId`, rather than paging
    /// through the entire log.
    pub fn find_first_for_worker(
        &self,
        event_type: &str,
        worker_id: &str,
    ) -> Result<Option<u64>, AppError> {
        self.conn
            .query_row(
                "SELECT seq FROM events WHERE type = ?1 AND json_extract(payload, '$.workerId') = ?2 ORDER BY seq ASC LIMIT 1",
                (event_type, worker_id),
                |row| row.get::<_, i64>(0),
            )
            .optional()
            .map(|opt| opt.map(|v| v as u64))
            .map_err(|e| AppError::EventLog(e.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_append_and_read_roundtrip() {
        let mut log = EventLog::open_in_memory().unwrap();
        log.append(
            1,
            1000,
            "worker_spawned",
            r#"{"workerId":"a"}"#,
            &Provenance::default(),
        )
        .unwrap();
        log.append(
            2,
            1001,
            "worker_killed",
            r#"{"workerId":"a"}"#,
            &Provenance::default(),
        )
        .unwrap();

        let events = log.events_since(0, 100).unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].seq, 1);
        assert_eq!(events[0].event_type, "worker_spawned");
        assert_eq!(events[0].payload["workerId"], "a");
        assert_eq!(events[1].seq, 2);
        // Unattributed provenance round-trips as None, not an error.
        assert_eq!(events[0].origin_worker, None);
        assert_eq!(events[0].cause_seq, None);
    }

    #[test]
    fn test_append_and_read_roundtrip_with_provenance() {
        let mut log = EventLog::open_in_memory().unwrap();
        let origin = Uuid::new_v4();
        log.append(
            1,
            1000,
            "worker_killed",
            r#"{"workerId":"a"}"#,
            &Provenance {
                origin_worker: Some(origin),
                cause_seq: Some(41),
            },
        )
        .unwrap();

        let events = log.events_since(0, 100).unwrap();
        assert_eq!(events[0].origin_worker, Some(origin));
        assert_eq!(events[0].cause_seq, Some(41));
    }

    #[test]
    fn test_events_since_filters_and_limits() {
        let mut log = EventLog::open_in_memory().unwrap();
        for seq in 1..=10 {
            log.append(
                seq,
                1000 + seq as i64,
                "worker_output",
                "{}",
                &Provenance::default(),
            )
            .unwrap();
        }
        let events = log.events_since(7, 100).unwrap();
        assert_eq!(
            events.iter().map(|e| e.seq).collect::<Vec<_>>(),
            vec![8, 9, 10]
        );

        let limited = log.events_since(0, 3).unwrap();
        assert_eq!(limited.len(), 3);
        assert_eq!(limited[0].seq, 1);
    }

    #[test]
    fn test_max_seq_empty_and_populated() {
        let mut log = EventLog::open_in_memory().unwrap();
        assert_eq!(log.max_seq().unwrap(), 0);
        log.append(41, 1, "session_created", "{}", &Provenance::default())
            .unwrap();
        log.append(42, 2, "session_deleted", "{}", &Provenance::default())
            .unwrap();
        assert_eq!(log.max_seq().unwrap(), 42);
    }

    #[test]
    fn test_duplicate_seq_rejected() {
        let mut log = EventLog::open_in_memory().unwrap();
        log.append(1, 1, "session_created", "{}", &Provenance::default())
            .unwrap();
        assert!(
            log.append(1, 2, "session_deleted", "{}", &Provenance::default())
                .is_err()
        );
    }

    #[test]
    fn test_find_first_for_worker_returns_earliest_matching_seq() {
        let mut log = EventLog::open_in_memory().unwrap();
        log.append(
            1,
            1,
            "worktree_created",
            r#"{"workerId":"other"}"#,
            &Provenance::default(),
        )
        .unwrap();
        log.append(
            2,
            2,
            "worker_state",
            r#"{"workerId":"a"}"#,
            &Provenance::default(),
        )
        .unwrap();
        log.append(
            3,
            3,
            "worktree_created",
            r#"{"workerId":"a"}"#,
            &Provenance::default(),
        )
        .unwrap();
        log.append(
            4,
            4,
            "worktree_created",
            r#"{"workerId":"a"}"#,
            &Provenance::default(),
        )
        .unwrap();

        assert_eq!(
            log.find_first_for_worker("worktree_created", "a").unwrap(),
            Some(3)
        );
    }

    #[test]
    fn test_find_first_for_worker_none_when_absent() {
        let mut log = EventLog::open_in_memory().unwrap();
        log.append(
            1,
            1,
            "worktree_created",
            r#"{"workerId":"other"}"#,
            &Provenance::default(),
        )
        .unwrap();
        assert_eq!(
            log.find_first_for_worker("worktree_created", "missing")
                .unwrap(),
            None
        );
        assert_eq!(
            log.find_first_for_worker("nonexistent_type", "other")
                .unwrap(),
            None
        );
    }

    // ── Migration ladder ─────────────────────────────────────────────

    /// DIRECTIVE: legacy-shape-first migration. A database created with
    /// ONLY the pre-provenance 4-column schema (simulating a real user's
    /// existing `swarm-events.db`) must, after `EventLog::open`'s
    /// `init()`, end up with `origin_worker`/`cause_seq` columns added,
    /// `user_version = 1`, and its pre-existing row's new columns
    /// `NULL` (the truthful historical value — old rows were never
    /// attributed, so they must not silently gain a fabricated `None`
    /// that LOOKS the same as "we checked and found nothing" — `NULL`
    /// here means "this predates provenance entirely," which `None` in
    /// Rust cannot distinguish, but is exactly what a fresh unattributed
    /// row also produces, which is the correct, honest collapse).
    /// Opening a second time must be a no-op (idempotent ladder).
    #[test]
    fn test_migration_adds_provenance_columns_to_a_legacy_database() {
        // Build a raw legacy-shape-only database by hand — bypassing
        // EventLog::open/init entirely — to simulate a database that
        // predates this migration.
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE events (
                seq     INTEGER PRIMARY KEY,
                ts      INTEGER NOT NULL,
                type    TEXT NOT NULL,
                payload TEXT NOT NULL
            ) STRICT;
            CREATE INDEX idx_events_type_seq ON events(type, seq);
            INSERT INTO events (seq, ts, type, payload) VALUES (1, 1000, 'worker_spawned', '{}');",
        )
        .unwrap();
        // Legacy database: user_version was never touched.
        let version_before: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(version_before, 0);

        // Now run this exact database through the real migration path.
        let mut log = EventLog::init(conn).unwrap();

        let version_after: i64 = log
            .conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(version_after, 1);

        let events = log.events_since(0, 100).unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(
            events[0].origin_worker, None,
            "legacy row must be NULL, not fabricated"
        );
        assert_eq!(events[0].cause_seq, None);

        // New rows work normally post-migration.
        let origin = Uuid::new_v4();
        log.append(
            2,
            2000,
            "worker_killed",
            "{}",
            &Provenance {
                origin_worker: Some(origin),
                cause_seq: Some(1),
            },
        )
        .unwrap();
        let events = log.events_since(0, 100).unwrap();
        assert_eq!(events[1].origin_worker, Some(origin));

        // Re-running migrate() against the now-current-version database
        // must be a no-op — no error, no duplicate ALTER TABLE.
        EventLog::migrate(&log.conn).expect("second migrate() must no-op cleanly");
        let version_still: i64 = log
            .conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(version_still, 1);
    }

    #[test]
    fn test_open_in_memory_is_already_at_current_schema_version() {
        let log = EventLog::open_in_memory().unwrap();
        let version: i64 = log
            .conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION);
    }

    // ── Partial index ────────────────────────────────────────────────

    /// DIRECTIVE: `idx_events_origin_seq` must actually be used by the
    /// worker-scoped seq-range query it exists for. SQLite's
    /// partial-index prover is documented as incomplete — this is the
    /// gate the plan calls for: if the planner declines the partial
    /// index (e.g. a future SQLite version, or a query shape that
    /// doesn't match the `WHERE origin_worker IS NOT NULL` predicate),
    /// this test fails loudly instead of the index silently going
    /// unused forever.
    #[test]
    fn test_explain_query_plan_uses_the_origin_seq_partial_index() {
        let mut log = EventLog::open_in_memory().unwrap();
        let origin = Uuid::new_v4();
        for seq in 1..=5 {
            log.append(
                seq,
                seq as i64,
                "bus_message",
                "{}",
                &Provenance {
                    origin_worker: Some(origin),
                    cause_seq: None,
                },
            )
            .unwrap();
        }

        let mut stmt = log
            .conn
            .prepare(
                "EXPLAIN QUERY PLAN SELECT seq FROM events \
                 WHERE origin_worker = ?1 AND origin_worker IS NOT NULL AND seq > ?2 \
                 ORDER BY seq",
            )
            .unwrap();
        let plan_lines: Vec<String> = stmt
            .query_map((origin.to_string(), 0i64), |row| row.get::<_, String>(3))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        let plan = plan_lines.join("\n");

        assert!(
            plan.contains("idx_events_origin_seq"),
            "expected the planner to use idx_events_origin_seq, got plan:\n{plan}"
        );
    }
}
