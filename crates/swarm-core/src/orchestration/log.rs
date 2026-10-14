//! SQLite-backed append-only event log.
//!
//! One `events` row per persisted [`crate::events::SwarmEvent`] (see
//! [`super::is_persistent`] for which ones), keyed by the seq the
//! [`super::OrchestrationEngine`]'s writer thread assigned it, plus a
//! small `meta` table holding the writer's seq reservation (see
//! [`EventLog::resume_seq`]). The writer owns the only read-write
//! connection; readers open their own through
//! [`EventLog::open_readonly`].

use std::path::Path;
use std::time::Duration;

use rusqlite::{Connection, OpenFlags, OptionalExtension, Row};
use serde::Serialize;
use uuid::Uuid;

use crate::error::AppError;
use crate::events::Provenance;

/// Current schema revision, tracked in SQLite's own `PRAGMA
/// user_version` header field. See [`EventLog::migrate`].
const SCHEMA_VERSION: i64 = 2;

/// How long a connection waits on another connection's lock (e.g. a WAL
/// checkpoint) before failing with `SQLITE_BUSY`.
const BUSY_TIMEOUT: Duration = Duration::from_secs(2);

/// Upper bound, in bytes, the `-wal` file is truncated back to after a
/// checkpoint, so one large burst does not leave a large file behind.
const WAL_SIZE_LIMIT_BYTES: i64 = 4 * 1024 * 1024;

/// `PRAGMA synchronous` value SQLite reports for EXTRA (0 OFF, 1 NORMAL,
/// 2 FULL, 3 EXTRA).
const SYNCHRONOUS_EXTRA: i64 = 3;

/// `meta` key holding the highest seq the writer may have handed out.
const SEQ_RESERVED_KEY: &str = "seq_reserved";

/// The columns every range reader selects, in [`StoredEvent`]'s field
/// order (which is also the live envelope's JSON key order).
const EVENT_COLUMNS: &str = "seq, ts, origin_worker, cause_seq, type, payload";

/// One persisted event row.
///
/// Serializes to the same JSON a live [`super::DomainEvent`] does —
/// same keys in the same order, `originWorker`/`causeSeq` omitted rather
/// than `null` when absent — so a client cannot tell a replayed event
/// from the live one. Only the key order INSIDE `payload` can differ:
/// the payload is read back as a [`serde_json::Value`], whose object
/// keys are sorted.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredEvent {
    /// Unique, monotonic sequence number. Persisted seqs have gaps:
    /// ephemeral events consume seqs too, and a restart skips any seqs
    /// the previous run reserved but never used.
    pub seq: u64,
    /// Unix timestamp in milliseconds.
    pub ts: i64,
    /// UUID of the worker whose action caused this event, if known —
    /// `NULL` for rows persisted before provenance existed (honestly
    /// unattributed, not a guess).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub origin_worker: Option<Uuid>,
    /// Seq of the event this one is causally reacting to, if known.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cause_seq: Option<u64>,
    /// Event type tag, matching [`crate::events::SwarmEvent::type_tag`]
    /// (e.g. `"worker_spawned"`).
    #[serde(rename = "type")]
    pub event_type: String,
    /// The event payload as JSON.
    pub payload: serde_json::Value,
}

impl StoredEvent {
    /// Maps one row selected as [`EVENT_COLUMNS`].
    fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        let (seq, ts, origin_worker, cause_seq, event_type, payload): (
            i64,
            i64,
            Option<String>,
            Option<i64>,
            String,
            String,
        ) = row.try_into()?;
        Ok(Self {
            seq: seq.cast_unsigned(),
            ts,
            origin_worker: origin_worker
                .as_deref()
                .map(Uuid::parse_str)
                .transpose()
                .map_err(|e| conversion_error(2, e))?,
            cause_seq: cause_seq.map(i64::cast_unsigned),
            event_type,
            payload: serde_json::from_str(&payload).map_err(|e| conversion_error(5, e))?,
        })
    }
}

/// Creates `path` if missing and limits it, and its `-wal`/`-shm`
/// siblings when present, to the owner. Done before SQLite opens the file
/// so no window exists in which a fresh log is world-readable.
#[cfg(unix)]
fn restrict_to_owner(path: &Path) -> std::io::Result<()> {
    use std::fs::{self, OpenOptions, Permissions};
    use std::io::ErrorKind;
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

    OpenOptions::new()
        .append(true)
        .create(true)
        .mode(0o600)
        .open(path)?;
    fs::set_permissions(path, Permissions::from_mode(0o600))?;
    for suffix in ["-wal", "-shm"] {
        let mut sibling = path.as_os_str().to_owned();
        sibling.push(suffix);
        match fs::set_permissions(&sibling, Permissions::from_mode(0o600)) {
            Err(e) if e.kind() != ErrorKind::NotFound => return Err(e),
            _ => {}
        }
    }
    Ok(())
}

/// A stored TEXT column that does not parse as the type it must hold.
fn conversion_error(
    column: usize,
    error: impl std::error::Error + Send + Sync + 'static,
) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(column, rusqlite::types::Type::Text, Box::new(error))
}

/// Append-only SQLite event log (WAL mode).
#[derive(Debug)]
pub struct EventLog {
    conn: Connection,
}

impl EventLog {
    /// Opens (or creates) the log at `path` and brings its schema up to
    /// date. Used by the writer; readers should prefer
    /// [`Self::open_readonly`].
    ///
    /// On Unix the file and any existing `-wal`/`-shm` siblings are
    /// restricted to the owner (`0600`) first: the log stores agent tool
    /// inputs and results verbatim, and SQLite would otherwise create it
    /// `0644`, readable by any local account that can reach the data dir.
    /// A new `-wal`/`-shm` inherits the main file's mode.
    ///
    /// # Errors
    ///
    /// [`AppError::EventLog`] if the file cannot be opened or restricted,
    /// a migration fails, or the file was written by a newer build (a
    /// schema version this build does not know).
    pub fn open(path: &Path) -> Result<Self, AppError> {
        #[cfg(unix)]
        restrict_to_owner(path).map_err(|e| AppError::EventLog(e.to_string()))?;
        Self::init(Connection::open(path)?)
    }

    /// Opens an EXISTING log at `path` for reads: no schema work, and
    /// `PRAGMA query_only` makes SQLite reject any write through it.
    ///
    /// The connection is opened `SQLITE_OPEN_READ_WRITE` (never
    /// `SQLITE_OPEN_CREATE`), not `SQLITE_OPEN_READ_ONLY`: a WAL
    /// reader must be able to write the `-shm` index to coordinate with
    /// the writer, and a strictly read-only connection can fail to see
    /// committed-but-not-yet-checkpointed frames. `query_only` keeps
    /// the read-only guarantee at the SQL level instead.
    ///
    /// # Errors
    ///
    /// [`AppError::EventLog`] if `path` does not exist or cannot be
    /// opened.
    pub fn open_readonly(path: &Path) -> Result<Self, AppError> {
        let conn = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        conn.busy_timeout(BUSY_TIMEOUT)?;
        conn.pragma_update(None, "query_only", true)?;
        Ok(Self { conn })
    }

    /// In-memory log, for tests.
    ///
    /// # Errors
    ///
    /// [`AppError::EventLog`] if SQLite cannot allocate the database.
    #[cfg(test)]
    pub fn open_in_memory() -> Result<Self, AppError> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(mut conn: Connection) -> Result<Self, AppError> {
        let mode: String =
            conn.pragma_update_and_check(None, "journal_mode", "WAL", |row| row.get(0))?;
        // An in-memory database reports "memory"; anything else that is
        // not WAL means the filesystem refused it, and readers will
        // contend with the writer instead of reading a snapshot.
        if !mode.eq_ignore_ascii_case("wal") && !mode.eq_ignore_ascii_case("memory") {
            tracing::warn!(journal_mode = %mode, "event log could not switch to WAL mode");
        }
        // Flush on every commit (ADR-0039), so a committed append (already
        // emitted: persist before emit) and a committed seq reservation
        // survive an OS crash or power loss, not just a process crash:
        // - EXTRA, not NORMAL or FULL: in WAL mode EXTRA is FULL (the WAL
        //   is synced after every commit), and if the filesystem refuses
        //   WAL above, EXTRA is the level SQLite documents as durable in
        //   rollback mode, where FULL is not necessarily.
        // - fullfsync: on macOS SQLite calls a plain fsync(), which leaves
        //   the data in the drive cache, unless this is on (F_FULLFSYNC);
        //   it is a no-op elsewhere.
        // Both are per connection. The read-only connections never commit;
        // the last connection to close may run the final checkpoint, which
        // syncs at its own default level.
        conn.pragma_update(None, "synchronous", "EXTRA")?;
        conn.pragma_update(None, "fullfsync", true)?;
        // These pragmas do not echo their value, so read them back:
        // running weaker than documented must fail the open.
        let synchronous: i64 = conn.pragma_query_value(None, "synchronous", |row| row.get(0))?;
        let fullfsync: i64 = conn.pragma_query_value(None, "fullfsync", |row| row.get(0))?;
        if synchronous != SYNCHRONOUS_EXTRA || fullfsync != 1 {
            return Err(AppError::EventLog(format!(
                "SQLite reports synchronous={synchronous} (need EXTRA, {SYNCHRONOUS_EXTRA}) and                  fullfsync={fullfsync} (need 1); the event log refuses to run with weaker durability."
            )));
        }
        conn.pragma_update(None, "journal_size_limit", WAL_SIZE_LIMIT_BYTES)?;
        conn.busy_timeout(BUSY_TIMEOUT)?;
        Self::migrate(&mut conn)?;
        Ok(Self { conn })
    }

    /// Runs `sql` (one or more statements) inside one transaction, so a
    /// schema change and the `PRAGMA user_version` bump that records it
    /// (itself transactional) commit atomically: a crash mid-rung rolls
    /// the whole rung back instead of leaving, say, a column added but
    /// the version unchanged — which would fail every later launch with
    /// "duplicate column name". A rung that errors partway rolls back on
    /// `Drop` without reaching `commit`.
    fn run_rung(conn: &mut Connection, sql: &str) -> Result<(), AppError> {
        let tx = conn.transaction()?;
        tx.execute_batch(sql)?;
        tx.commit()?;
        Ok(())
    }

    /// Walks the `PRAGMA user_version` migration ladder. Each rung runs
    /// atomically (see [`Self::run_rung`]) and only when `user_version`
    /// is below it, so opening an up-to-date database performs no write
    /// at all, and a crash always leaves a well-defined version to
    /// retry from.
    ///
    /// - v0 (fresh file, or a pre-provenance log): the base `events`
    ///   table and its `(type, seq)` index.
    /// - v0 → v1: nullable `origin_worker TEXT` / `cause_seq INTEGER`
    ///   columns; existing rows read back `NULL`, the truthful value.
    /// - v1 → v2: the `meta` table (seq reservation), and the unused
    ///   `idx_events_origin_seq` partial index is dropped (no query
    ///   filters on `origin_worker`; worker-scoped reads match the
    ///   payload's `workerId`).
    fn migrate(conn: &mut Connection) -> Result<(), AppError> {
        const _: () = assert!(SCHEMA_VERSION == 2, "extend the ladder below");

        let version: i64 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
        if version > SCHEMA_VERSION {
            return Err(AppError::EventLog(format!(
                "Event Log Schema v{version} Is Newer Than This Build Supports \
                 (v{SCHEMA_VERSION}); Update SWARM Orchestrator."
            )));
        }
        if version < 1 {
            Self::run_rung(
                conn,
                "CREATE TABLE IF NOT EXISTS events (
                     seq     INTEGER PRIMARY KEY,
                     ts      INTEGER NOT NULL,
                     type    TEXT NOT NULL,
                     payload TEXT NOT NULL
                 ) STRICT;
                 CREATE INDEX IF NOT EXISTS idx_events_type_seq ON events(type, seq);",
            )?;
            Self::run_rung(
                conn,
                "ALTER TABLE events ADD COLUMN origin_worker TEXT;
                 ALTER TABLE events ADD COLUMN cause_seq INTEGER;
                 PRAGMA user_version = 1;",
            )?;
        }
        if version < 2 {
            Self::run_rung(
                conn,
                "DROP INDEX IF EXISTS idx_events_origin_seq;
                 CREATE TABLE IF NOT EXISTS meta (
                     key   TEXT PRIMARY KEY,
                     value INTEGER NOT NULL
                 ) STRICT, WITHOUT ROWID;
                 PRAGMA user_version = 2;",
            )?;
        }
        Ok(())
    }

    /// Highest persisted sequence number, or 0 when empty.
    ///
    /// # Errors
    ///
    /// [`AppError::EventLog`] on a SQLite failure.
    pub fn max_seq(&self) -> Result<u64, AppError> {
        let max: i64 =
            self.conn
                .query_row("SELECT COALESCE(MAX(seq), 0) FROM events", [], |row| {
                    row.get(0)
                })?;
        Ok(max.cast_unsigned())
    }

    /// The seq a new writer must continue after: the highest seq any
    /// previous writer on this file may have issued. That is the larger
    /// of the highest persisted seq and the writer's last reservation
    /// (`reserve_seqs`), because ephemeral events consume seqs
    /// without leaving a row — resuming from [`Self::max_seq`] alone
    /// would hand out seqs that clients already saw before a restart.
    ///
    /// # Errors
    ///
    /// [`AppError::EventLog`] on a SQLite failure.
    pub fn resume_seq(&self) -> Result<u64, AppError> {
        let reserved: Option<i64> = self
            .conn
            .query_row(
                "SELECT value FROM meta WHERE key = ?1",
                [SEQ_RESERVED_KEY],
                |row| row.get(0),
            )
            .optional()?;
        Ok(self.max_seq()?.max(reserved.map_or(0, i64::cast_unsigned)))
    }

    /// Records that seqs up to and including `through` may be handed
    /// out. The writer calls this BEFORE issuing a seq past its previous
    /// reservation (so a crash can never lose a seq it issued), and
    /// again at a clean shutdown with its exact head (so a clean restart
    /// continues without a gap).
    pub(super) fn reserve_seqs(&mut self, through: u64) -> Result<(), AppError> {
        self.conn
            .prepare_cached(
                "INSERT INTO meta (key, value) VALUES (?1, ?2) \
                 ON CONFLICT (key) DO UPDATE SET value = excluded.value",
            )?
            .execute((SEQ_RESERVED_KEY, through.cast_signed()))?;
        Ok(())
    }

    /// Test hook: renames `table` away so the next write to it fails,
    /// to exercise the writer's fail-closed paths. Undo with
    /// [`Self::repair_table`].
    #[cfg(test)]
    pub(super) fn break_table(&self, table: &str) {
        self.conn
            .execute_batch(&format!("ALTER TABLE {table} RENAME TO {table}_broken"))
            .unwrap();
    }

    /// Test hook: undoes [`Self::break_table`].
    #[cfg(test)]
    pub(super) fn repair_table(&self, table: &str) {
        self.conn
            .execute_batch(&format!("ALTER TABLE {table}_broken RENAME TO {table}"))
            .unwrap();
    }

    /// Lets SQLite refresh its planner statistics on a connection that
    /// will live for the whole process (`PRAGMA optimize=0x10002`, the
    /// at-open form SQLite recommends for long-lived connections).
    pub(super) fn optimize_on_open(&self) -> Result<(), AppError> {
        self.conn.execute_batch("PRAGMA optimize = 0x10002;")?;
        Ok(())
    }

    /// Clean-shutdown bookkeeping for the writer: records `head` as the
    /// exact seq reservation, refreshes planner statistics, and
    /// checkpoints the WAL back into the main file.
    pub(super) fn finalize(&mut self, head: u64) -> Result<(), AppError> {
        self.reserve_seqs(head)?;
        self.conn.execute_batch("PRAGMA optimize;")?;
        self.conn
            .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()))?;
        Ok(())
    }

    /// Appends one event, along with its causal attribution.
    ///
    /// # Errors
    ///
    /// [`AppError::EventLog`] on a SQLite failure, including a duplicate
    /// `seq` (the PRIMARY KEY) or a connection opened with
    /// [`Self::open_readonly`].
    pub fn append(
        &mut self,
        seq: u64,
        ts: i64,
        event_type: &str,
        payload_json: &str,
        provenance: &Provenance,
    ) -> Result<(), AppError> {
        self.conn
            .prepare_cached(
                "INSERT INTO events (seq, ts, type, payload, origin_worker, cause_seq) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            )?
            .execute((
                seq.cast_signed(),
                ts,
                event_type,
                payload_json,
                provenance.origin_worker.map(|u| u.to_string()),
                provenance.cause_seq.map(u64::cast_signed),
            ))?;
        Ok(())
    }

    /// Returns up to `limit` persisted events with `seq > after_seq`,
    /// ascending.
    ///
    /// # Errors
    ///
    /// [`AppError::EventLog`] on a SQLite failure or a corrupt row.
    pub fn events_since(&self, after_seq: u64, limit: u32) -> Result<Vec<StoredEvent>, AppError> {
        // Clamp rather than cast-wrap: a wrapped (negative) cursor would
        // turn "everything past the end" into "everything".
        let after_seq = i64::try_from(after_seq).unwrap_or(i64::MAX);
        let events = self
            .conn
            .prepare_cached(&format!(
                "SELECT {EVENT_COLUMNS} FROM events WHERE seq > ?1 ORDER BY seq ASC LIMIT ?2"
            ))?
            .query_map((after_seq, limit), StoredEvent::from_row)?
            .collect::<rusqlite::Result<_>>()?;
        Ok(events)
    }

    /// Returns up to `limit` of one worker's events of the given
    /// `event_types` within `(from_seq, to_seq]`, ascending by seq, plus
    /// whether matching rows beyond `limit` were cut off. Built for
    /// `commands::git::ship_context`.
    ///
    /// Both filters run in SQL, so `limit` is spent entirely on rows the
    /// caller can use (a range-wide cap applied before filtering to one
    /// worker would let other workers' rows crowd this worker's out).
    /// When more than `limit` rows match, the NEWEST `limit` are kept:
    /// the query reads newest-first with one extra sentinel row that
    /// proves truncation, then reverses to ascending order.
    ///
    /// `worker_id` matches the payload's `workerId`: `agent_*` events
    /// stamp no envelope `originWorker`, so the payload is the only
    /// reliable subject field. Returns `(vec![], false)` without
    /// touching the database when `event_types` is empty or `limit` is
    /// `0`.
    ///
    /// # Errors
    ///
    /// [`AppError::EventLog`] on a SQLite failure or a corrupt row.
    pub fn events_for_worker_between(
        &self,
        event_types: &[&str],
        worker_id: &str,
        from_seq: u64,
        to_seq: u64,
        limit: u32,
    ) -> Result<(Vec<StoredEvent>, bool), AppError> {
        if event_types.is_empty() || limit == 0 {
            return Ok((Vec::new(), false));
        }

        let from_seq = i64::try_from(from_seq).unwrap_or(i64::MAX);
        let to_seq = i64::try_from(to_seq).unwrap_or(i64::MAX);
        let fetch_limit = i64::from(limit) + 1;
        let placeholders = std::iter::repeat_n("?", event_types.len())
            .collect::<Vec<_>>()
            .join(", ");

        let mut params: Vec<&dyn rusqlite::ToSql> = Vec::with_capacity(event_types.len() + 4);
        params.extend([&from_seq as &dyn rusqlite::ToSql, &to_seq]);
        params.extend(event_types.iter().map(|t| t as &dyn rusqlite::ToSql));
        params.extend([&worker_id as &dyn rusqlite::ToSql, &fetch_limit]);

        let mut events: Vec<StoredEvent> = self
            .conn
            .prepare_cached(&format!(
                "SELECT {EVENT_COLUMNS} FROM events \
                 WHERE seq > ? AND seq <= ? AND type IN ({placeholders}) \
                 AND json_extract(payload, '$.workerId') = ? \
                 ORDER BY seq DESC LIMIT ?"
            ))?
            .query_map(params.as_slice(), StoredEvent::from_row)?
            .collect::<rusqlite::Result<_>>()?;

        let truncated = events.len() > limit as usize;
        events.truncate(limit as usize);
        events.reverse();
        Ok((events, truncated))
    }

    /// Returns the `seq` of the first persisted event of `event_type`
    /// whose payload's `workerId` equals `worker_id`, or `None` if there
    /// is none. The ship chain uses it to find a never-shipped worker's
    /// `worktree_created` seq; the `(type, seq)` index narrows the scan
    /// to `event_type`'s rows in ascending order.
    ///
    /// # Errors
    ///
    /// [`AppError::EventLog`] on a SQLite failure.
    pub fn find_first_for_worker(
        &self,
        event_type: &str,
        worker_id: &str,
    ) -> Result<Option<u64>, AppError> {
        let seq: Option<i64> = self
            .conn
            .prepare_cached(
                "SELECT seq FROM events WHERE type = ?1 \
                 AND json_extract(payload, '$.workerId') = ?2 ORDER BY seq ASC LIMIT 1",
            )?
            .query_row((event_type, worker_id), |row| row.get(0))
            .optional()?;
        Ok(seq.map(i64::cast_unsigned))
    }
}

#[cfg(test)]
mod tests {
    use std::assert_matches;

    use super::*;

    fn append(log: &mut EventLog, seq: u64, event_type: &str, payload: &str) {
        log.append(
            seq,
            seq.cast_signed(),
            event_type,
            payload,
            &Provenance::default(),
        )
        .unwrap();
    }

    fn user_version(conn: &Connection) -> i64 {
        conn.pragma_query_value(None, "user_version", |r| r.get(0))
            .unwrap()
    }

    #[test]
    fn test_append_and_read_roundtrip() {
        let mut log = EventLog::open_in_memory().unwrap();
        append(&mut log, 1, "worker_spawned", r#"{"workerId":"a"}"#);
        append(&mut log, 2, "worker_killed", r#"{"workerId":"a"}"#);

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
            append(&mut log, seq, "worker_output", "{}");
        }
        let events = log.events_since(7, 100).unwrap();
        assert_eq!(
            events.iter().map(|e| e.seq).collect::<Vec<_>>(),
            vec![8, 9, 10]
        );

        let limited = log.events_since(0, 3).unwrap();
        assert_eq!(limited.len(), 3);
        assert_eq!(limited[0].seq, 1);

        // A cursor past i64::MAX clamps instead of wrapping negative
        // (which would replay the whole log).
        assert!(log.events_since(u64::MAX, 100).unwrap().is_empty());
    }

    #[test]
    fn test_corrupt_stored_payload_is_an_event_log_error() {
        let mut log = EventLog::open_in_memory().unwrap();
        append(&mut log, 1, "worker_spawned", "{not json");
        assert_matches!(log.events_since(0, 10), Err(AppError::EventLog(_)));
    }

    // ── events_for_worker_between ────────────────────────────────────

    fn append_agent_tool_call(log: &mut EventLog, seq: u64, worker_id: &str) {
        append(
            log,
            seq,
            "agent_tool_call",
            &format!(
                r#"{{"workerId":"{worker_id}","turnId":"t{seq}","toolUseId":"u{seq}","name":"Read","input":{{}}}}"#
            ),
        );
    }

    #[test]
    fn test_events_for_worker_between_filters_by_worker_in_sql() {
        let mut log = EventLog::open_in_memory().unwrap();
        // Interleave two workers' rows across the range.
        append_agent_tool_call(&mut log, 1, "a");
        append_agent_tool_call(&mut log, 2, "b");
        append_agent_tool_call(&mut log, 3, "a");
        append_agent_tool_call(&mut log, 4, "b");

        let (events, truncated) = log
            .events_for_worker_between(&["agent_tool_call"], "a", 0, 10, 100)
            .unwrap();
        assert!(!truncated);
        assert_eq!(events.iter().map(|e| e.seq).collect::<Vec<_>>(), vec![1, 3]);
    }

    #[test]
    fn test_events_for_worker_between_filters_by_type() {
        let mut log = EventLog::open_in_memory().unwrap();
        append_agent_tool_call(&mut log, 1, "a");
        append(
            &mut log,
            2,
            "worker_output",
            r#"{"workerId":"a","data":"hi"}"#,
        );

        let (events, _) = log
            .events_for_worker_between(&["agent_tool_call"], "a", 0, 10, 100)
            .unwrap();
        assert_eq!(events.iter().map(|e| e.seq).collect::<Vec<_>>(), vec![1]);
    }

    /// A range with more matching rows than `limit` keeps the NEWEST
    /// rows (never the oldest) and reports the truncation.
    #[test]
    fn test_events_for_worker_between_truncation_keeps_newest_and_reports_it() {
        let mut log = EventLog::open_in_memory().unwrap();
        for seq in 1..=5 {
            append_agent_tool_call(&mut log, seq, "a");
        }

        let (events, truncated) = log
            .events_for_worker_between(&["agent_tool_call"], "a", 0, 10, 3)
            .unwrap();
        assert!(truncated, "5 matching rows against a limit of 3");
        assert_eq!(
            events.iter().map(|e| e.seq).collect::<Vec<_>>(),
            vec![3, 4, 5]
        );
    }

    #[test]
    fn test_events_for_worker_between_exact_limit_is_not_reported_as_truncated() {
        let mut log = EventLog::open_in_memory().unwrap();
        for seq in 1..=3 {
            append_agent_tool_call(&mut log, seq, "a");
        }
        let (events, truncated) = log
            .events_for_worker_between(&["agent_tool_call"], "a", 0, 10, 3)
            .unwrap();
        assert!(!truncated);
        assert_eq!(events.len(), 3);
    }

    #[test]
    fn test_events_for_worker_between_empty_event_types_or_zero_limit_short_circuits() {
        let mut log = EventLog::open_in_memory().unwrap();
        append_agent_tool_call(&mut log, 1, "a");
        // With the table gone every query errors, so only a call that
        // never touches the database can still return `Ok`.
        log.break_table("events");

        let (events, truncated) = log.events_for_worker_between(&[], "a", 0, 10, 100).unwrap();
        assert!(events.is_empty());
        assert!(!truncated);
        let (events, truncated) = log
            .events_for_worker_between(&["agent_tool_call"], "a", 0, 10, 0)
            .unwrap();
        assert!(events.is_empty());
        assert!(!truncated);
        assert!(
            log.events_for_worker_between(&["agent_tool_call"], "a", 0, 10, 100)
                .is_err()
        );
    }

    #[test]
    fn test_events_for_worker_between_respects_the_seq_range_bounds() {
        let mut log = EventLog::open_in_memory().unwrap();
        for seq in 1..=10 {
            append_agent_tool_call(&mut log, seq, "a");
        }
        let (events, _) = log
            .events_for_worker_between(&["agent_tool_call"], "a", 3, 7, 100)
            .unwrap();
        assert_eq!(
            events.iter().map(|e| e.seq).collect::<Vec<_>>(),
            vec![4, 5, 6, 7]
        );
    }

    // ── max_seq / resume_seq / reservation ───────────────────────────

    #[test]
    fn test_max_seq_empty_and_populated() {
        let mut log = EventLog::open_in_memory().unwrap();
        assert_eq!(log.max_seq().unwrap(), 0);
        append(&mut log, 41, "session_created", "{}");
        append(&mut log, 42, "session_deleted", "{}");
        assert_eq!(log.max_seq().unwrap(), 42);
    }

    #[test]
    fn test_resume_seq_is_the_larger_of_persisted_and_reserved() {
        let mut log = EventLog::open_in_memory().unwrap();
        assert_eq!(log.resume_seq().unwrap(), 0);

        append(&mut log, 5, "session_created", "{}");
        assert_eq!(log.resume_seq().unwrap(), 5, "no reservation yet");

        log.reserve_seqs(1024).unwrap();
        assert_eq!(
            log.resume_seq().unwrap(),
            1024,
            "an ephemeral tail up to the reservation may have been issued"
        );

        // A later reservation replaces (not accumulates) the old one.
        log.reserve_seqs(7).unwrap();
        assert_eq!(log.resume_seq().unwrap(), 7);

        // A persisted row past the reservation still wins.
        append(&mut log, 9, "session_deleted", "{}");
        assert_eq!(log.resume_seq().unwrap(), 9);
    }

    #[test]
    fn test_finalize_records_the_exact_head() {
        let mut log = EventLog::open_in_memory().unwrap();
        log.reserve_seqs(2048).unwrap();
        log.finalize(1500).unwrap();
        assert_eq!(log.resume_seq().unwrap(), 1500);
    }

    #[test]
    fn test_duplicate_seq_rejected() {
        let mut log = EventLog::open_in_memory().unwrap();
        append(&mut log, 1, "session_created", "{}");
        assert!(
            log.append(1, 2, "session_deleted", "{}", &Provenance::default())
                .is_err()
        );
    }

    #[test]
    fn test_find_first_for_worker_returns_earliest_matching_seq() {
        let mut log = EventLog::open_in_memory().unwrap();
        append(&mut log, 1, "worktree_created", r#"{"workerId":"other"}"#);
        append(&mut log, 2, "worker_state", r#"{"workerId":"a"}"#);
        append(&mut log, 3, "worktree_created", r#"{"workerId":"a"}"#);
        append(&mut log, 4, "worktree_created", r#"{"workerId":"a"}"#);

        assert_eq!(
            log.find_first_for_worker("worktree_created", "a").unwrap(),
            Some(3)
        );
    }

    #[test]
    fn test_find_first_for_worker_none_when_absent() {
        let mut log = EventLog::open_in_memory().unwrap();
        append(&mut log, 1, "worktree_created", r#"{"workerId":"other"}"#);
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

    // ── File-backed readers ──────────────────────────────────────────

    /// A temp database file plus a guard that removes it (and its WAL
    /// siblings) on drop, so a failing assertion still cleans up.
    fn temp_db() -> (
        std::path::PathBuf,
        std::mem::DropGuard<std::path::PathBuf, impl FnOnce(std::path::PathBuf)>,
    ) {
        let path = std::env::temp_dir().join(format!("swarm-log-test-{}.db", Uuid::new_v4()));
        let guard = std::mem::DropGuard::new(path.clone(), |path: std::path::PathBuf| {
            for suffix in ["-wal", "-shm"] {
                let mut sibling = path.clone().into_os_string();
                sibling.push(suffix);
                let _ = std::fs::remove_file(sibling);
            }
            let _ = std::fs::remove_file(&path);
        });
        (path, guard)
    }

    /// An integer pragma as SQLite reports it.
    fn pragma(log: &EventLog, name: &str) -> i64 {
        log.conn
            .pragma_query_value(None, name, |r| r.get(0))
            .unwrap()
    }

    /// The log must flush on every commit (ADR-0039): WAL mode, so a
    /// commit syncs the WAL; `synchronous=EXTRA`, which equals FULL in WAL
    /// mode and is the level SQLite documents as durable if WAL is ever
    /// refused; and `fullfsync=1`, so macOS issues F_FULLFSYNC instead of
    /// a plain fsync that leaves the data in the drive cache.
    #[test]
    fn test_open_flushes_every_commit_to_stable_storage() {
        let (path, _cleanup) = temp_db();
        let log = EventLog::open(&path).unwrap();
        let mode: String = log
            .conn
            .pragma_query_value(None, "journal_mode", |r| r.get(0))
            .unwrap();
        assert_eq!(mode, "wal");
        assert_eq!(pragma(&log, "fullfsync"), 1, "fullfsync must be on");
        assert_eq!(pragma(&log, "synchronous"), 3, "synchronous must be EXTRA");
    }

    #[test]
    fn test_open_in_memory_still_initializes() {
        let log = EventLog::open_in_memory().unwrap();
        assert_eq!(log.max_seq().unwrap(), 0);
    }

    #[test]
    fn test_open_readonly_reads_but_rejects_writes() {
        let (path, _cleanup) = temp_db();
        let mut writer = EventLog::open(&path).unwrap();
        append(&mut writer, 1, "worker_spawned", r#"{"workerId":"a"}"#);

        let mut reader = EventLog::open_readonly(&path).unwrap();
        assert_eq!(reader.events_since(0, 10).unwrap().len(), 1);
        assert_matches!(
            reader.append(2, 2, "worker_killed", "{}", &Provenance::default()),
            Err(AppError::EventLog(_))
        );
        assert_eq!(
            writer.max_seq().unwrap(),
            1,
            "the rejected write left no row"
        );
    }

    #[cfg(unix)]
    fn mode_of(path: &std::path::Path) -> u32 {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(path).unwrap().permissions().mode() & 0o777
    }

    #[cfg(unix)]
    fn sibling(path: &std::path::Path, suffix: &str) -> std::path::PathBuf {
        let mut sibling = path.as_os_str().to_owned();
        sibling.push(suffix);
        sibling.into()
    }

    /// A fresh log is created owner-only, and so is its WAL.
    #[cfg(unix)]
    #[test]
    fn test_open_creates_the_log_owner_only() {
        let (path, _cleanup) = temp_db();
        let mut log = EventLog::open(&path).unwrap();
        append(&mut log, 1, "worker_spawned", "{}");
        assert_eq!(mode_of(&path), 0o600);
        assert_eq!(mode_of(&sibling(&path, "-wal")), 0o600);
    }

    /// A log an older build left at `0644` (with its WAL) is tightened on
    /// the next open.
    #[cfg(unix)]
    #[test]
    fn test_open_tightens_an_existing_world_readable_log() {
        use std::os::unix::fs::PermissionsExt;

        let (path, _cleanup) = temp_db();
        // Held open so its WAL still exists when the second open runs.
        let mut first = EventLog::open(&path).unwrap();
        append(&mut first, 1, "worker_spawned", "{}");
        for suffix in ["", "-wal"] {
            let file = sibling(&path, suffix);
            std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o644)).unwrap();
        }

        let mut log = EventLog::open(&path).unwrap();
        append(&mut log, 2, "worker_spawned", "{}");
        assert_eq!(mode_of(&path), 0o600);
        assert_eq!(mode_of(&sibling(&path, "-wal")), 0o600);
    }

    #[test]
    fn test_open_readonly_never_creates_a_missing_file() {
        let (path, _cleanup) = temp_db();
        assert!(EventLog::open_readonly(&path).is_err());
        assert!(!path.exists());
    }

    // ── Migration ladder ─────────────────────────────────────────────

    const LEGACY_SCHEMA: &str = "CREATE TABLE events (
            seq     INTEGER PRIMARY KEY,
            ts      INTEGER NOT NULL,
            type    TEXT NOT NULL,
            payload TEXT NOT NULL
        ) STRICT;
        CREATE INDEX idx_events_type_seq ON events(type, seq);";

    /// A database with only the pre-provenance 4-column schema (a real
    /// user's old `swarm-events.db`) ends up at the current version with
    /// its old row's provenance columns `NULL` (never fabricated), and a
    /// second `migrate` is a no-op.
    #[test]
    fn test_migration_upgrades_a_legacy_database() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(LEGACY_SCHEMA).unwrap();
        conn.execute(
            "INSERT INTO events (seq, ts, type, payload) VALUES (1, 1000, 'worker_spawned', '{}')",
            [],
        )
        .unwrap();
        assert_eq!(user_version(&conn), 0);

        let mut log = EventLog::init(conn).unwrap();
        assert_eq!(user_version(&log.conn), SCHEMA_VERSION);

        let events = log.events_since(0, 100).unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].origin_worker, None);
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
        assert_eq!(
            log.events_since(1, 10).unwrap()[0].origin_worker,
            Some(origin)
        );

        // `query_only` fails any write with SQLITE_READONLY, so an `Ok`
        // proves the up-to-date path performs no write at all.
        log.conn.pragma_update(None, "query_only", true).unwrap();
        EventLog::migrate(&mut log.conn).expect("a second migrate performs no write");
        log.conn.pragma_update(None, "query_only", false).unwrap();
        assert_eq!(user_version(&log.conn), SCHEMA_VERSION);
    }

    /// A v1 database (provenance columns plus the since-dropped
    /// `idx_events_origin_seq` partial index) gains the `meta` table and
    /// loses the unused index.
    #[test]
    fn test_migration_from_v1_adds_meta_and_drops_the_origin_index() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(LEGACY_SCHEMA).unwrap();
        conn.execute_batch(
            "ALTER TABLE events ADD COLUMN origin_worker TEXT;
             ALTER TABLE events ADD COLUMN cause_seq INTEGER;
             CREATE INDEX idx_events_origin_seq
                 ON events(origin_worker, seq) WHERE origin_worker IS NOT NULL;
             PRAGMA user_version = 1;",
        )
        .unwrap();

        let mut log = EventLog::init(conn).unwrap();
        assert_eq!(user_version(&log.conn), 2);
        assert!(!index_list(&log.conn).contains(&"idx_events_origin_seq".to_string()));
        log.reserve_seqs(10).unwrap();
        assert_eq!(log.resume_seq().unwrap(), 10);
    }

    /// A file written by a NEWER build is refused rather than silently
    /// appended to under assumptions that may no longer hold.
    #[test]
    fn test_migration_refuses_a_newer_schema() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(&format!("PRAGMA user_version = {};", SCHEMA_VERSION + 1))
            .unwrap();
        assert_matches!(
            EventLog::init(conn),
            Err(AppError::EventLog(msg)) if msg.contains("Newer Than This Build")
        );
    }

    fn table_info(conn: &Connection, table: &str) -> Vec<(String, String, i64)> {
        conn.prepare(&format!("PRAGMA table_info({table})"))
            .unwrap()
            .query_map([], |row| Ok((row.get(1)?, row.get(2)?, row.get(3)?)))
            .unwrap()
            .map(Result::unwrap)
            .collect()
    }

    fn index_list(conn: &Connection) -> Vec<String> {
        let mut names: Vec<String> = conn
            .prepare("PRAGMA index_list(events)")
            .unwrap()
            .query_map([], |row| row.get(1))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        names.sort();
        names
    }

    /// A fresh database and one migrated from the legacy shape land on
    /// an IDENTICAL schema — same columns, same indexes, same `meta`.
    #[test]
    fn test_fresh_and_migrated_schemas_converge() {
        let fresh = EventLog::open_in_memory().unwrap();

        let legacy = Connection::open_in_memory().unwrap();
        legacy.execute_batch(LEGACY_SCHEMA).unwrap();
        let migrated = EventLog::init(legacy).unwrap();

        for table in ["events", "meta"] {
            assert_eq!(
                table_info(&fresh.conn, table),
                table_info(&migrated.conn, table),
                "fresh vs. migrated {table} columns diverged"
            );
        }
        assert_eq!(index_list(&fresh.conn), index_list(&migrated.conn));
        assert_eq!(user_version(&fresh.conn), SCHEMA_VERSION);
    }

    /// A rung that fails partway leaves the database exactly as it was
    /// (rolled back) — never with its first statement applied and the
    /// version unchanged, which would fail every later launch.
    #[test]
    fn test_run_rung_rolls_back_atomically_on_partial_failure() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(LEGACY_SCHEMA).unwrap();

        let result = EventLog::run_rung(
            &mut conn,
            "ALTER TABLE events ADD COLUMN probe_column TEXT;
             THIS IS NOT VALID SQL;",
        );
        assert!(result.is_err(), "a partially-invalid rung must fail");

        let columns = table_info(&conn, "events");
        assert!(
            !columns.iter().any(|(name, ..)| name == "probe_column"),
            "a failed rung must roll back its earlier statements too, got columns: {columns:?}"
        );
    }

    /// Throughput of the engine's real write shape under each
    /// `synchronous` level: one autocommit `INSERT` per persistent event
    /// (`OrchestrationEngine::persist`) plus one seq-block reservation
    /// per 1024 seqs (`SEQ_RESERVATION_BLOCK`). Prints, never asserts.
    /// Set `TMPDIR` to pick the filesystem under test, and see
    /// `docs/performance.md` for the recorded numbers.
    #[test]
    #[ignore = "throughput measurement; run explicitly"]
    fn measure_append_throughput_by_synchronous_level() {
        const APPENDS: u64 = 3000;
        const RESERVATION_BLOCK: u64 = 1024;

        for (level, name) in [("NORMAL", "NORMAL"), ("FULL", "FULL"), ("EXTRA", "EXTRA")] {
            let (path, _cleanup) = temp_db();
            let mut log = EventLog::open(&path).unwrap();
            log.conn.pragma_update(None, "synchronous", level).unwrap();
            let payload = serde_json::json!({
                "workerId": Uuid::new_v4(),
                "toolName": "Bash",
                "input": { "command": "x".repeat(300) },
            })
            .to_string();
            let mut latencies = Vec::with_capacity(usize::try_from(APPENDS).unwrap());
            let mut reserved = 0;
            let started = std::time::Instant::now();
            for seq in 1..=APPENDS {
                let t = std::time::Instant::now();
                if seq > reserved {
                    reserved = seq + RESERVATION_BLOCK - 1;
                    log.reserve_seqs(reserved).unwrap();
                }
                log.append(
                    seq,
                    seq.cast_signed(),
                    "agent_tool_call",
                    &payload,
                    &Provenance::default(),
                )
                .unwrap();
                latencies.push(t.elapsed());
            }
            let total = started.elapsed();
            latencies.sort_unstable();
            let pct = |p: usize| latencies[(latencies.len() * p / 100).min(latencies.len() - 1)];
            #[expect(clippy::cast_precision_loss, reason = "a printed rate")]
            let rate = APPENDS as f64 / total.as_secs_f64();
            println!(
                "synchronous={name} dir={} appends={APPENDS} payload_bytes={} \
                 events_per_s={rate:.0} p50={:?} p99={:?} max={:?}",
                path.parent().unwrap().display(),
                payload.len(),
                pct(50),
                pct(99),
                latencies[latencies.len() - 1],
            );
        }
    }
}
