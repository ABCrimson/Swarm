//! IPC commands for the ordered event core.

use swarm_core::orchestration::{EventLog, OrchestrationEngine};

/// Maximum events returned per call; callers page by repeating the
/// call with the last received seq until fewer than the cap arrive.
const PAGE_LIMIT: u32 = 5000;

/// Clamps a caller-supplied `limit` to `PAGE_LIMIT`, defaulting to
/// `PAGE_LIMIT` when absent. Extracted so the clamp math itself is
/// unit-testable without a live `OrchestrationEngine` state.
fn clamp_limit(limit: Option<u32>) -> u32 {
    limit.map(|l| l.min(PAGE_LIMIT)).unwrap_or(PAGE_LIMIT)
}

/// Returns persisted events with `seq > after_seq`, ascending, capped
/// at `limit` (default/max 5000 — see [`PAGE_LIMIT`]). Shape matches
/// live `swarm://events` envelopes, including the optional
/// `originWorker`/`causeSeq` provenance fields (present only when the
/// stored row carries them — see
/// [`test_live_and_backfilled_envelope_shapes_match`]). Used by the
/// frontend to backfill after a detected sequence gap, for replay, and
/// (Phase 7's causality inspector) for single-row backward hops via a
/// small `limit`.
///
/// Ephemeral events (worker output, metrics, logs) are not persisted
/// and therefore never appear here.
#[tauri::command]
#[tracing::instrument(skip(engine))]
pub async fn events_since(
    engine: tauri::State<'_, OrchestrationEngine>,
    after_seq: u64,
    limit: Option<u32>,
) -> Result<Vec<serde_json::Value>, String> {
    let Some(path) = engine.db_path().map(std::path::Path::to_path_buf) else {
        return Ok(Vec::new());
    };
    let limit = clamp_limit(limit);

    tokio::task::spawn_blocking(move || {
        let log = EventLog::open(&path).map_err(|e| e.to_string())?;
        let events = log
            .events_since(after_seq, limit)
            .map_err(|e| e.to_string())?;
        Ok(events
            .into_iter()
            .map(|e| {
                // Built as a Map (not the `json!` macro) so
                // originWorker/causeSeq are conditionally INSERTED, not
                // inserted-as-null — matching DomainEvent's
                // `skip_serializing_if` exactly, which is what
                // `test_live_and_backfilled_envelope_shapes_match`
                // pins down.
                let mut obj = serde_json::Map::new();
                obj.insert("seq".to_string(), serde_json::json!(e.seq));
                obj.insert("ts".to_string(), serde_json::json!(e.ts));
                if let Some(w) = e.origin_worker {
                    obj.insert("originWorker".to_string(), serde_json::json!(w));
                }
                if let Some(c) = e.cause_seq {
                    obj.insert("causeSeq".to_string(), serde_json::json!(c));
                }
                obj.insert("type".to_string(), serde_json::json!(e.event_type));
                obj.insert("payload".to_string(), e.payload);
                serde_json::Value::Object(obj)
            })
            .collect())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use swarm_core::events::{Provenance, SwarmEvent, WorkerSpawnedPayload};
    use swarm_core::orchestration::DomainEvent;
    use uuid::Uuid;

    /// Reconstructs the backfilled JSON shape exactly as the
    /// `events_since` command above does, for use by both tests below.
    fn backfilled_json_for(seq: u64, log: &EventLog) -> serde_json::Value {
        let stored = log.events_since(0, 10).unwrap();
        let e = stored.into_iter().find(|e| e.seq == seq).unwrap();
        let mut obj = serde_json::Map::new();
        obj.insert("seq".to_string(), serde_json::json!(e.seq));
        obj.insert("ts".to_string(), serde_json::json!(e.ts));
        if let Some(w) = e.origin_worker {
            obj.insert("originWorker".to_string(), serde_json::json!(w));
        }
        if let Some(c) = e.cause_seq {
            obj.insert("causeSeq".to_string(), serde_json::json!(c));
        }
        obj.insert("type".to_string(), serde_json::json!(e.event_type));
        obj.insert("payload".to_string(), e.payload);
        serde_json::Value::Object(obj)
    }

    /// Pins the two independently-defined wire envelopes together: the
    /// `DomainEvent` serde shape emitted live by the writer thread
    /// (`orchestration/engine.rs`) and the hand-built JSON this command
    /// reconstructs for a backfill. If either drifts, a live listener
    /// and a post-gap backfill would see differently-shaped envelopes
    /// for the same event. Unattributed (no provenance) case.
    #[test]
    fn test_live_and_backfilled_envelope_shapes_match() {
        let event = SwarmEvent::WorkerSpawned(WorkerSpawnedPayload {
            worker_id: Uuid::nil(),
            name: "w".to_string(),
            pid: Some(42),
            isolation: None,
        });

        // Live shape: exactly what the writer thread emits on swarm://events.
        let live = DomainEvent {
            seq: 7,
            ts: 1_700_000_000_000,
            origin_worker: None,
            cause_seq: None,
            event: event.clone(),
        };
        let live_json = serde_json::to_value(&live).unwrap();

        // Backfilled shape: persist the same event, then reconstruct the
        // JSON exactly as `events_since` does above.
        let tagged = serde_json::to_value(&event).unwrap();
        let event_type = tagged["type"].as_str().unwrap().to_string();
        let payload_json = tagged["payload"].to_string();

        let mut log = EventLog::open_in_memory().unwrap();
        log.append(
            live.seq,
            live.ts,
            &event_type,
            &payload_json,
            &Provenance::default(),
        )
        .unwrap();

        assert_eq!(live_json, backfilled_json_for(live.seq, &log));
    }

    /// Same tripwire as above, extended with a STAMPED event — the
    /// specific gap this test closes: a forgotten `originWorker`/
    /// `causeSeq` field in the hand-built backfill JSON.
    #[test]
    fn test_live_and_backfilled_envelope_shapes_match_when_stamped() {
        let worker_id = Uuid::new_v4();
        let origin = Uuid::new_v4();
        let event = SwarmEvent::WorkerSpawned(WorkerSpawnedPayload {
            worker_id,
            name: "w".to_string(),
            pid: Some(42),
            isolation: None,
        });
        let provenance = Provenance {
            origin_worker: Some(origin),
            cause_seq: Some(3),
        };

        let live = DomainEvent {
            seq: 8,
            ts: 1_700_000_000_001,
            origin_worker: provenance.origin_worker,
            cause_seq: provenance.cause_seq,
            event: event.clone(),
        };
        let live_json = serde_json::to_value(&live).unwrap();
        assert_eq!(live_json["originWorker"], origin.to_string());
        assert_eq!(live_json["causeSeq"], 3);

        let tagged = serde_json::to_value(&event).unwrap();
        let event_type = tagged["type"].as_str().unwrap().to_string();
        let payload_json = tagged["payload"].to_string();

        let mut log = EventLog::open_in_memory().unwrap();
        log.append(live.seq, live.ts, &event_type, &payload_json, &provenance)
            .unwrap();

        assert_eq!(live_json, backfilled_json_for(live.seq, &log));
    }

    #[test]
    fn test_clamp_limit_caps_above_page_limit() {
        assert_eq!(clamp_limit(Some(u32::MAX)), PAGE_LIMIT);
        assert_eq!(clamp_limit(Some(PAGE_LIMIT + 1)), PAGE_LIMIT);
    }

    #[test]
    fn test_clamp_limit_defaults_to_page_limit_when_absent() {
        assert_eq!(clamp_limit(None), PAGE_LIMIT);
    }

    #[test]
    fn test_clamp_limit_honors_a_small_caller_supplied_value() {
        // Phase 7's single-row backward hop needs a small limit honored as-is.
        assert_eq!(clamp_limit(Some(1)), 1);
    }

    #[test]
    fn test_events_since_small_limit_returns_exactly_that_many_rows() {
        let mut log = EventLog::open_in_memory().unwrap();
        for seq in 1..=3u64 {
            log.append(
                seq,
                seq as i64,
                "worker_state",
                "{}",
                &Provenance::default(),
            )
            .unwrap();
        }
        let page = log.events_since(0, 1).unwrap();
        assert_eq!(page.len(), 1);
    }
}
