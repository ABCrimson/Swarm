//! SQLite-backed append-only event log.

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_append_and_read_roundtrip() {
        let mut log = EventLog::open_in_memory().unwrap();
        log.append(1, 1000, "worker_spawned", r#"{"workerId":"a"}"#)
            .unwrap();
        log.append(2, 1001, "worker_killed", r#"{"workerId":"a"}"#)
            .unwrap();

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
            log.append(seq, 1000 + seq as i64, "worker_output", "{}")
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
