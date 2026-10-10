//! The connection's feeder task: the replay for a warm `hello`,
//! `replayEnd`, then live events (see "Event stream" and "Lanes and
//! ordering" in the [`super`] module doc).

use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::extract::ws::Utf8Bytes;
use tokio::sync::broadcast::error::RecvError;
use tokio::sync::{broadcast, mpsc};

use swarm_core::error::AppError;
use swarm_core::orchestration::{DomainEvent, EventLog, is_persistent};
use swarm_core::protocol::ServerFrame;

#[cfg(doc)]
use super::EVENT_LANE_CAPACITY;
use super::frame;

/// Queued frames above which new ephemeral events are dropped; well below
/// [`EVENT_LANE_CAPACITY`], so an ephemeral flood cannot take the room a
/// persistent frame needs.
const EPHEMERAL_WATERMARK: usize = 512;

/// Why [`feed`] stopped.
#[derive(Debug, thiserror::Error)]
pub(super) enum FeedEnd {
    #[error("the connection's writer stopped")]
    Disconnected,
    #[error("the event engine stopped")]
    EngineStopped,
    #[error("event replay failed: {0}")]
    Replay(String),
}

/// Runs blocking SQLite work on the blocking pool.
async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, AppError> + Send + 'static,
) -> Result<T, FeedEnd> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|error| FeedEnd::Replay(error.to_string()))?
        .map_err(|error| FeedEnd::Replay(error.to_string()))
}

/// Feeds the event lane for one connection: the replay for a warm `hello`,
/// `replayEnd`, then live events (healing lag by replay) until the
/// connection or the engine goes away.
pub(super) async fn feed(
    live: broadcast::Receiver<Arc<DomainEvent>>,
    log_path: Option<PathBuf>,
    last_seq: Option<u64>,
    server_seq: u64,
    events: mpsc::Sender<Utf8Bytes>,
    page_size: u32,
) -> FeedEnd {
    stream_events(
        live,
        log_path.as_deref(),
        last_seq,
        server_seq,
        &events,
        page_size,
    )
    .await
    .into_err()
}

async fn stream_events(
    mut live: broadcast::Receiver<Arc<DomainEvent>>,
    log_path: Option<&Path>,
    last_seq: Option<u64>,
    server_seq: u64,
    events: &mpsc::Sender<Utf8Bytes>,
    page_size: u32,
) -> Result<!, FeedEnd> {
    let mut cursor = match last_seq {
        Some(last_seq) => replay(log_path, last_seq, events, page_size).await?,
        None => server_seq,
    };
    events
        .send(frame(&ServerFrame::ReplayEnd { seq: cursor }))
        .await
        .map_err(|_| FeedEnd::Disconnected)?;

    loop {
        match live.recv().await {
            Ok(event) if event.seq > cursor => {
                forward(&event, events).await?;
                cursor = event.seq;
            }
            // Already delivered by a replay.
            Ok(_) => {}
            Err(RecvError::Lagged(skipped)) => {
                tracing::warn!(
                    skipped,
                    cursor,
                    "WebSocket client lagged the event fanout; healing by replay"
                );
                cursor = replay(log_path, cursor, events, page_size).await?;
            }
            Err(RecvError::Closed) => return Err(FeedEnd::EngineStopped),
        }
    }
}

/// Enqueues one live event on the lane its persistence class calls for.
/// An ephemeral event over the watermark is dropped before it is
/// serialized, so a stalled client costs the feeder no JSON work.
async fn forward(event: &DomainEvent, events: &mpsc::Sender<Utf8Bytes>) -> Result<(), FeedEnd> {
    let persistent = is_persistent(&event.event);
    if !persistent && events.max_capacity() - events.capacity() >= EPHEMERAL_WATERMARK {
        return Ok(());
    }
    let text = match serde_json::to_string(event) {
        Ok(text) => Utf8Bytes::from(text),
        Err(error) => {
            tracing::error!(seq = event.seq, %error, "failed to serialize a live event; skipping it");
            return Ok(());
        }
    };
    if persistent {
        events.send(text).await.map_err(|_| FeedEnd::Disconnected)
    } else {
        // Full or closed: dropped, like any ephemeral event under load.
        let _ = events.try_send(text);
        Ok(())
    }
}

/// Sends every persisted event after `cursor`, page by page, and returns the
/// last seq sent (`cursor` itself when there was nothing to send).
async fn replay(
    log_path: Option<&Path>,
    mut cursor: u64,
    events: &mpsc::Sender<Utf8Bytes>,
    page_size: u32,
) -> Result<u64, FeedEnd> {
    let Some(path) = log_path.map(Path::to_path_buf) else {
        // An in-memory log has nothing to replay from.
        return Ok(cursor);
    };
    let mut log = blocking(move || EventLog::open_readonly(&path)).await?;
    loop {
        let (reader, page) =
            blocking(move || log.events_since(cursor, page_size).map(|page| (log, page))).await?;
        log = reader;
        let last_page = page.len() < page_size as usize;
        for stored in page {
            let seq = stored.seq;
            // Serialized straight from the row: the same JSON as a live
            // `DomainEvent`, with no intermediate `Value` tree.
            let text =
                serde_json::to_string(&stored).map_err(|e| FeedEnd::Replay(e.to_string()))?;
            events
                .send(text.into())
                .await
                .map_err(|_| FeedEnd::Disconnected)?;
            cursor = seq;
        }
        if last_page {
            return Ok(cursor);
        }
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use serde_json::Value;
    use swarm_core::events::{FileWrittenPayload, Provenance, SwarmEvent, SystemLogPayload};

    use super::*;

    fn persisted(seq: u64) -> DomainEvent {
        DomainEvent {
            seq,
            ts: 0,
            origin_worker: None,
            cause_seq: None,
            event: SwarmEvent::FileWritten(FileWrittenPayload {
                path: format!("/tmp/{seq}"),
                bytes: 1,
            }),
        }
    }

    fn ephemeral(seq: u64) -> DomainEvent {
        DomainEvent {
            seq,
            ts: 0,
            origin_worker: None,
            cause_seq: None,
            event: SwarmEvent::SystemLog(SystemLogPayload {
                level: "info".to_owned(),
                message: format!("tick {seq}"),
                target: "test".to_owned(),
                timestamp: 0,
            }),
        }
    }

    /// A file-backed log holding `seqs` as persisted events.
    fn log_with(dir: &Path, seqs: impl IntoIterator<Item = u64>) -> PathBuf {
        let path = dir.join("events.db");
        let mut log = EventLog::open(&path).unwrap();
        for seq in seqs {
            let event = persisted(seq);
            let tagged = serde_json::to_value(&event.event).unwrap();
            log.append(
                seq,
                0,
                tagged["type"].as_str().unwrap(),
                &tagged["payload"].to_string(),
                &Provenance::default(),
            )
            .unwrap();
        }
        path
    }

    /// Everything the feeder put on the lane so far, as (`seq` or `None` for
    /// control frames, `frame` tag).
    fn drain(rx: &mut mpsc::Receiver<Utf8Bytes>) -> Vec<(Option<u64>, Option<String>)> {
        std::iter::from_fn(|| rx.try_recv().ok())
            .map(|text| {
                let value: Value = serde_json::from_str(&text).unwrap();
                (
                    value["seq"].as_u64(),
                    value["frame"].as_str().map(str::to_owned),
                )
            })
            .collect()
    }

    fn seqs(frames: &[(Option<u64>, Option<String>)]) -> Vec<u64> {
        frames
            .iter()
            .filter(|(_, frame)| frame.is_none())
            .filter_map(|(seq, _)| *seq)
            .collect()
    }

    /// A warm attach replays exactly the persisted events after `lastSeq`,
    /// then drops live events the replay already covered.
    #[tokio::test]
    async fn test_warm_attach_replays_then_deduplicates_live_events() {
        let dir = tempfile::tempdir().unwrap();
        let path = log_with(dir.path(), 1..=5);
        let (live_tx, live_rx) = broadcast::channel(16);
        for seq in 4..=6 {
            live_tx.send(Arc::new(persisted(seq))).unwrap();
        }
        let (tx, mut rx) = mpsc::channel(64);
        let feeder = tokio::spawn(feed(live_rx, Some(path), Some(2), 5, tx, 2));
        tokio::task::yield_now().await;
        drop(live_tx);
        assert!(matches!(feeder.await.unwrap(), FeedEnd::EngineStopped));

        let frames = drain(&mut rx);
        assert_eq!(seqs(&frames), [3, 4, 5, 6]);
        let replay_end = frames
            .iter()
            .position(|(_, frame)| frame.as_deref() == Some("replayEnd"))
            .unwrap();
        assert_eq!(
            replay_end, 3,
            "replayEnd follows the replayed events: {frames:?}"
        );
        assert_eq!(frames[replay_end].0, Some(5));
    }

    /// A receiver that lagged the fanout is healed from the log, with no gap
    /// and no duplicate.
    #[tokio::test]
    async fn test_lagged_receiver_heals_by_replay() {
        let dir = tempfile::tempdir().unwrap();
        let path = log_with(dir.path(), 1..=10);
        let (live_tx, live_rx) = broadcast::channel(2);
        for seq in 1..=10 {
            live_tx.send(Arc::new(persisted(seq))).unwrap();
        }
        let (tx, mut rx) = mpsc::channel(64);
        let feeder = tokio::spawn(feed(live_rx, Some(path), None, 0, tx, 3));
        tokio::task::yield_now().await;
        drop(live_tx);
        assert!(matches!(feeder.await.unwrap(), FeedEnd::EngineStopped));
        assert_eq!(seqs(&drain(&mut rx)), (1..=10).collect::<Vec<_>>());
    }

    /// A replay that cannot read the log is a failure, never a silent
    /// "caught up".
    #[tokio::test]
    async fn test_unreadable_log_fails_the_replay() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("missing").join("events.db");
        let (_live_tx, live_rx) = broadcast::channel(2);
        let (tx, mut rx) = mpsc::channel(8);
        let end = feed(live_rx, Some(missing), Some(0), 0, tx, 10).await;
        assert!(matches!(end, FeedEnd::Replay(_)), "{end:?}");
        assert!(
            drain(&mut rx).is_empty(),
            "no replayEnd after a failed replay"
        );
    }

    #[tokio::test]
    async fn test_ephemeral_events_are_dropped_above_the_watermark() {
        let (tx, mut rx) = mpsc::channel(EPHEMERAL_WATERMARK * 2);
        for seq in 0..EPHEMERAL_WATERMARK as u64 + 10 {
            forward(&ephemeral(seq), &tx).await.unwrap();
        }
        forward(&persisted(9999), &tx).await.unwrap();
        let frames = drain(&mut rx);
        assert_eq!(frames.len(), EPHEMERAL_WATERMARK + 1);
        assert_eq!(
            frames.last().unwrap().0,
            Some(9999),
            "persistent events are never dropped"
        );
    }

    /// Terminal keystroke echoes are ephemeral: on a full lane they are
    /// dropped instead of blocking the feeder, while machine-issued input
    /// is persistent and waits for room.
    #[tokio::test]
    async fn test_terminal_worker_input_rides_the_ephemeral_lane() {
        use swarm_core::events::{InputSource, WorkerInputPayload};
        let input = |seq, source| DomainEvent {
            event: SwarmEvent::WorkerInput(WorkerInputPayload {
                worker_id: uuid::Uuid::nil(),
                bytes: 1,
                source,
                preview: None,
            }),
            ..persisted(seq)
        };
        let (tx, _rx) = mpsc::channel(EPHEMERAL_WATERMARK);
        for seq in 0..EPHEMERAL_WATERMARK as u64 {
            tx.try_send(Utf8Bytes::from(seq.to_string())).unwrap();
        }
        let wait = Duration::from_millis(100);
        let terminal =
            tokio::time::timeout(wait, forward(&input(1, InputSource::Terminal), &tx)).await;
        assert!(
            matches!(terminal, Ok(Ok(()))),
            "terminal input must not block"
        );
        let tool = tokio::time::timeout(wait, forward(&input(2, InputSource::Tool), &tx)).await;
        assert!(
            tool.is_err(),
            "machine-issued input waits for room on the lane"
        );
    }
}
