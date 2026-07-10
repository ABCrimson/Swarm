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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::{SwarmEvent, WorkerSpawnedPayload};
    use crate::orchestration::DomainEvent;
    use uuid::Uuid;

    /// Pins the two independently-defined wire envelopes together: the
    /// `DomainEvent` serde shape emitted live by the writer thread
    /// (`orchestration/engine.rs`) and the hand-built `serde_json::json!`
    /// this command reconstructs for a backfill. If either drifts, a live
    /// listener and a post-gap backfill would see differently-shaped
    /// envelopes for the same event.
    #[test]
    fn test_live_and_backfilled_envelope_shapes_match() {
        let event = SwarmEvent::WorkerSpawned(WorkerSpawnedPayload {
            worker_id: Uuid::nil(),
            name: "w".to_string(),
            pid: Some(42),
        });

        // Live shape: exactly what the writer thread emits on swarm://events.
        let live = DomainEvent {
            seq: 7,
            ts: 1_700_000_000_000,
            event: event.clone(),
        };
        let live_json = serde_json::to_value(&live).unwrap();

        // Backfilled shape: persist the same event, then reconstruct the
        // JSON exactly as `events_since` does above.
        let tagged = serde_json::to_value(&event).unwrap();
        let event_type = tagged["type"].as_str().unwrap().to_string();
        let payload_json = tagged["payload"].to_string();

        let mut log = EventLog::open_in_memory().unwrap();
        log.append(live.seq, live.ts, &event_type, &payload_json)
            .unwrap();
        let stored = log.events_since(0, 10).unwrap();
        assert_eq!(stored.len(), 1);
        let e = &stored[0];
        let backfilled_json = serde_json::json!({
            "seq": e.seq,
            "ts": e.ts,
            "type": e.event_type,
            "payload": e.payload,
        });

        assert_eq!(live_json, backfilled_json);
    }
}
