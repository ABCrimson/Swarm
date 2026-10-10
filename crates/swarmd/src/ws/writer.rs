//! The connection's writer task: drains the control and event lanes into
//! the socket (see "Lanes and ordering" in the [`super`] module doc).

use axum::extract::ws::{Message, Utf8Bytes};
use futures_util::{Sink, SinkExt};
use tokio::sync::mpsc;

/// Frames the writer coalesces into one flush.
const WRITE_BATCH: usize = 64;

/// Drains both lanes into the socket, control first, coalescing whatever is
/// already queued into one flush. Returns after writing a close frame, or
/// once both lanes are closed and empty.
pub(super) async fn write_frames<S: Sink<Message> + Unpin>(
    mut sink: S,
    mut events: mpsc::Receiver<Utf8Bytes>,
    mut control: mpsc::Receiver<Message>,
) -> Result<(), S::Error> {
    loop {
        let first = tokio::select! {
            biased;
            Some(message) = control.recv() => message,
            Some(text) = events.recv() => Message::Text(text),
            else => return Ok(()),
        };
        let mut closing = matches!(first, Message::Close(_));
        sink.feed(first).await?;
        let mut batched = 1;
        while !closing && batched < WRITE_BATCH {
            let next = match control.try_recv() {
                Ok(message) => message,
                Err(_) => match events.try_recv() {
                    Ok(text) => Message::Text(text),
                    Err(_) => break,
                },
            };
            closing = matches!(next, Message::Close(_));
            sink.feed(next).await?;
            batched += 1;
        }
        sink.flush().await?;
        if closing {
            return Ok(());
        }
    }
}

#[cfg(test)]
mod tests {
    use axum::extract::ws::close_code;

    use super::*;
    use crate::ws::{CONTROL_LANE_CAPACITY, EVENT_LANE_CAPACITY, close_message};

    /// The text of every message a writer produced, in wire order.
    fn texts(written: &[Message]) -> Vec<&str> {
        written
            .iter()
            .map(|message| match message {
                Message::Text(text) => text.as_str(),
                Message::Close(_) => "<close>",
                other => panic!("unexpected message {other:?}"),
            })
            .collect()
    }

    /// An `rpcResult` queued behind a flood of events is written first, and
    /// the events keep their order after it. The writer used to serve the
    /// event lane first, so the result waited for the whole flood to drain.
    #[tokio::test]
    async fn test_writer_serves_rpc_results_before_a_queued_event_flood() {
        const FLOOD: usize = 1000;
        let (events_tx, events_rx) = mpsc::channel(EVENT_LANE_CAPACITY);
        let (control_tx, control_rx) = mpsc::channel(CONTROL_LANE_CAPACITY);
        for seq in 0..FLOOD {
            events_tx
                .try_send(Utf8Bytes::from(format!("event {seq}")))
                .unwrap();
        }
        control_tx
            .try_send(Message::Text("rpcResult".into()))
            .unwrap();
        drop((events_tx, control_tx));

        let mut written = Vec::new();
        write_frames(&mut written, events_rx, control_rx)
            .await
            .unwrap();
        let written = texts(&written);
        assert_eq!(written.len(), FLOOD + 1);
        assert_eq!(written[0], "rpcResult", "the control lane goes first");
        let events: Vec<_> = (0..FLOOD).map(|seq| format!("event {seq}")).collect();
        assert_eq!(written[1..], events, "events keep their FIFO order");
    }

    /// A close frame on the control lane ends the writer at once, without
    /// first draining the queued events.
    #[tokio::test]
    async fn test_writer_stops_after_a_close_frame() {
        let (events_tx, events_rx) = mpsc::channel(EVENT_LANE_CAPACITY);
        let (control_tx, control_rx) = mpsc::channel(CONTROL_LANE_CAPACITY);
        for seq in 0..10 {
            events_tx
                .try_send(Utf8Bytes::from(seq.to_string()))
                .unwrap();
        }
        control_tx
            .try_send(close_message(close_code::AWAY, "Bye."))
            .unwrap();

        let mut written = Vec::new();
        write_frames(&mut written, events_rx, control_rx)
            .await
            .unwrap();
        assert_eq!(texts(&written), ["<close>"]);
    }
}
