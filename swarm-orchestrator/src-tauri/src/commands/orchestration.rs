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
