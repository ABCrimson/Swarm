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
fn clamp_limit(limit: Option<u32>) -> u32 {
    limit.map_or(PAGE_LIMIT, |l| l.min(PAGE_LIMIT))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EventsSinceArgs {
    after_seq: u64,
    #[serde(default)]
    limit: Option<u32>,
}

/// The persisted events after `afterSeq`, oldest first, at most
/// `limit` (capped at [`PAGE_LIMIT`]).
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

    /// The page starts strictly after `afterSeq` and honors `limit`.
    #[tokio::test]
    async fn test_events_since_pages_after_the_given_seq() {
        use crate::events::{Provenance, SwarmEvent, WorkerKilledPayload};
        use crate::runtime::{Runtime, RuntimeConfig};

        let (dir, _cleanup) = crate::state_file::tests::temp_dir("events-since");
        let rt = Runtime::start(
            RuntimeConfig {
                paths: crate::Paths { data_dir: dir },
                shell_name: "swarm-desktop",
                bind: None,
            },
            |_| {},
        )
        .unwrap();
        let mut seqs = Vec::new();
        for _ in 0..3 {
            let ack = rt.sink.emit_awaiting_seq(
                SwarmEvent::WorkerKilled(WorkerKilledPayload {
                    worker_id: Default::default(),
                }),
                Provenance::default(),
            );
            seqs.push(ack.await.unwrap());
        }
        rt.engine.flush().await.unwrap();

        let page = events_since(
            Ctx::from_runtime(&rt),
            serde_json::json!({"afterSeq": seqs[0], "limit": 1}),
        )
        .await
        .unwrap();
        let page = page.as_array().unwrap();
        assert_eq!(page.len(), 1);
        let seq = page[0]["seq"].as_u64().unwrap();
        // Startup events can interleave.
        assert!(seq > seqs[0] && seq <= seqs[1], "{seq}");

        let (ctx, _dir, _events) = crate::commands::test_support::test_ctx();
        assert_eq!(
            events_since(ctx, serde_json::json!({"afterSeq": 0})).await,
            Ok(serde_json::json!([]))
        );
    }
}
