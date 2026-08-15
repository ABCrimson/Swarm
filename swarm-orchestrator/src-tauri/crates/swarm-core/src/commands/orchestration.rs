//! `events_since` registry handler — ported verbatim from
//! `swarm-desktop`'s former `commands::orchestration`. Also the
//! function [`crate::protocol`]'s `swarmd::ws::stream_from` pages
//! through directly (bypassing the registry, since replay is a
//! connection-lifecycle concern, not a one-shot RPC) — this handler
//! stays for the ad hoc single-call/backfill use the frontend already
//! makes of it.

use serde::Deserialize;
use serde_json::Value;

use crate::orchestration::{EventLog, log::StoredEvent};

use super::Ctx;

/// Maximum events returned per call — callers page by repeating the
/// call with the last received seq until fewer than the cap arrive.
pub const PAGE_LIMIT: u32 = 5000;

pub fn clamp_limit(limit: Option<u32>) -> u32 {
    limit.map(|l| l.min(PAGE_LIMIT)).unwrap_or(PAGE_LIMIT)
}

/// Reconstructs a persisted [`StoredEvent`] into the exact same JSON
/// shape a LIVE `DomainEvent` serializes to (`originWorker`/`causeSeq`
/// conditionally INSERTED, never inserted-as-null — matching
/// `DomainEvent`'s `skip_serializing_if`). The one envelope-shape
/// reconstruction site, shared by this handler's ad hoc backfill call
/// AND `swarmd`'s `stream_from` replay paging — both must produce
/// byte-identical shapes to what a live listener already receives; see
/// `swarm-core`'s `orchestration::engine` tests for the live-vs-backfill
/// pinning this mirrors.
pub fn stored_event_to_json(e: StoredEvent) -> Value {
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
    Value::Object(obj)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EventsSinceArgs {
    after_seq: u64,
    #[serde(default)]
    limit: Option<u32>,
}

pub async fn events_since(ctx: Ctx, args: Value) -> Result<Value, Value> {
    let EventsSinceArgs { after_seq, limit } = super::parse_args(args)?;
    // Two different "missing DB" cases, two different outcomes — worth
    // being explicit about which is which (security-review NIT):
    // `db_path() == None` (no path configured at all, e.g. an
    // in-memory-only engine in tests) is handled HERE, gracefully, as
    // "no events" rather than an error. That is NOT the same case as
    // `Some(path)` pointing at a file that has never actually been
    // created on disk — since `EventLog::open_readonly` now opens with
    // `SQLITE_OPEN_READ_WRITE` (never `SQLITE_OPEN_CREATE`, see its
    // doc), a genuinely absent file at `path` surfaces as a hard `Err`
    // below, not a silent empty page. In practice this second case
    // shouldn't occur: `Runtime::start` opens the writer's own
    // `EventLog::open` (which DOES create the file) before any reader
    // — including this handler — can run. If it ever does happen, the
    // loud error is the correct behavior: a configured-but-missing
    // database is a bug to surface, not a page to swallow.
    let Some(path) = ctx.engine.db_path().map(std::path::Path::to_path_buf) else {
        return super::ok_value(&Vec::<Value>::new());
    };
    let limit = clamp_limit(limit);

    let events = tokio::task::spawn_blocking(move || -> Result<Vec<Value>, String> {
        let log = EventLog::open_readonly(&path).map_err(|e| e.to_string())?;
        let events = log
            .events_since(after_seq, limit)
            .map_err(|e| e.to_string())?;
        Ok(events.into_iter().map(stored_event_to_json).collect())
    })
    .await
    .map_err(|e| Value::String(e.to_string()))?
    .map_err(Value::String)?;

    super::ok_value(&events)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_clamp_limit_caps_above_page_limit() {
        assert_eq!(clamp_limit(Some(u32::MAX)), PAGE_LIMIT);
    }

    #[test]
    fn test_clamp_limit_defaults_to_page_limit_when_absent() {
        assert_eq!(clamp_limit(None), PAGE_LIMIT);
    }

    #[test]
    fn test_clamp_limit_honors_a_small_caller_supplied_value() {
        assert_eq!(clamp_limit(Some(1)), 1);
    }
}
