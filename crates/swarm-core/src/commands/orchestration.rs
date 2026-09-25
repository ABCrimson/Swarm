//! `events_since`: a page of persisted events, in the live envelope's
//! shape. `swarmd` replays history to a reconnecting client through the
//! same [`EventLog::events_since`] read directly (replay belongs to the
//! connection, not to one `rpc`); this handler serves one-off backfills.

use serde::Deserialize;
use serde_json::Value;

use super::Ctx;
use crate::orchestration::{EventLog, StoredEvent};

/// Maximum events returned per call. Callers page by repeating the call
/// with the last received seq until fewer than this arrive.
pub const PAGE_LIMIT: u32 = 5000;

/// A caller's requested page size, capped at [`PAGE_LIMIT`] (and
/// [`PAGE_LIMIT`] when absent).
pub fn clamp_limit(limit: Option<u32>) -> u32 {
    limit.map_or(PAGE_LIMIT, |l| l.min(PAGE_LIMIT))
}

/// A persisted event as the JSON a live `DomainEvent` serializes to.
///
/// Prefer serializing the [`StoredEvent`] itself (it has the same
/// `Serialize` shape) straight into the output; this `Value` detour
/// exists for callers that need a tree.
pub fn stored_event_to_json(e: StoredEvent) -> Value {
    serde_json::to_value(e).unwrap_or(Value::Null)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EventsSinceArgs {
    after_seq: u64,
    #[serde(default)]
    limit: Option<u32>,
}

/// The persisted events after `afterSeq`, oldest first, at most
/// `limit` (see [`clamp_limit`]).
///
/// An engine with no database file (an in-memory test engine) has no
/// history, so the page is empty. A configured file that is missing is
/// an error, not an empty page: [`crate::runtime::Runtime::start`]
/// creates it before any handler can run, so its absence is a bug.
pub async fn events_since(ctx: Ctx, args: Value) -> Result<Value, Value> {
    let EventsSinceArgs { after_seq, limit } = super::parse_args(args)?;
    let Some(path) = ctx.engine.db_path().map(std::path::Path::to_path_buf) else {
        return super::ok_value(&Vec::<StoredEvent>::new());
    };
    let limit = clamp_limit(limit);

    let events = tokio::task::spawn_blocking(move || {
        EventLog::open_readonly(&path)?.events_since(after_seq, limit)
    })
    .await
    .map_err(|e| Value::String(e.to_string()))?
    .map_err(|e| Value::String(e.to_string()))?;

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
