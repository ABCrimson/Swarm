//! Orderly shutdown when the app quits.
//!
//! The ways the app quits (closing the last window, Cmd+Q,
//! `AppHandle::exit`, `AppHandle::request_restart`) end the event loop
//! with [`RunEvent::Exit`], after which Tauri exits the process without
//! running the destructors of managed state. The run-event callback
//! therefore shuts the runtime down itself, on the main thread, while
//! handling that event.
//!
//! Two exits skip that event, and with it this teardown:
//! `AppHandle::restart` called on the main thread restarts the process
//! directly (off the main thread it goes through the event), and `exit`
//! falls back to `std::process::exit` when the event loop cannot be
//! asked to stop. The app calls neither `restart` nor `request_restart`;
//! a future restart must use `request_restart`.
//!
//! Terminal workers are left to the operating system: their PTYs close
//! with the process, which ends the shells they run. Killing them through
//! `kill_worker` instead would also remove their worktrees, which a quit
//! must never do.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use swarm_core::events::{Provenance, SwarmEvent, SystemLogPayload};
use swarm_core::runtime::Runtime;
use tauri::{AppHandle, Manager, RunEvent};
use tokio::task::JoinSet;

/// Upper bound on the exit teardown. Every window is already gone when it
/// runs, so this can only delay the process exit, never freeze the UI.
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(5);

/// The app's run-event callback.
pub(crate) fn on_run_event<R: tauri::Runtime>(app: &AppHandle<R>, event: RunEvent) {
    if let RunEvent::Exit = event
        // Absent when the start failed, which left nothing to shut down.
        && let Some(runtime) = app.try_state::<Runtime>()
    {
        tauri::async_runtime::block_on(async {
            if tokio::time::timeout(SHUTDOWN_TIMEOUT, shutdown(&runtime))
                .await
                .is_err()
            {
                tracing::warn!(timeout = ?SHUTDOWN_TIMEOUT, "shutdown timed out; exiting anyway");
            }
        });
    }
}

/// Shuts `runtime` down: stops the metrics loop, shuts every live agent
/// session down, then waits until the event writer has persisted every
/// event recorded before this call.
///
/// A session's shutdown kills its provider CLI and, for a turn still in
/// flight, records the error `agent_turn_settled` receipt the turn would
/// otherwise never get. The final wait is a barrier: the writer handles
/// events strictly in order, so once it acknowledges one more event,
/// everything queued ahead of it (those receipts, `worker_killed`,
/// `ship_settled`, …) is in the event log.
pub(crate) async fn shutdown(runtime: &Runtime) {
    runtime.metrics_cancel.cancel();

    let mut sessions = JoinSet::new();
    for worker in runtime.registry.list_workers() {
        if let Some(session) = runtime.agent_session_registry.remove(&worker.id) {
            sessions.spawn(async move {
                if let Err(error) = session.shutdown().await {
                    tracing::warn!(worker_id = %worker.id, %error, "agent session shutdown failed");
                }
            });
        }
    }
    while let Some(joined) = sessions.join_next().await {
        if let Err(error) = joined {
            tracing::error!(%error, "agent session shutdown task failed");
        }
    }

    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| {
            i64::try_from(elapsed.as_millis()).unwrap_or(i64::MAX)
        });
    let drained = runtime.sink.emit_awaiting_seq(
        SwarmEvent::SystemLog(SystemLogPayload {
            level: "info".to_owned(),
            message: "SWARM Is Shutting Down".to_owned(),
            target: "swarm_desktop".to_owned(),
            timestamp,
        }),
        Provenance::default(),
    );
    if drained.await.is_err() {
        tracing::warn!("the event writer stopped before the shutdown barrier");
    }
}

#[cfg(test)]
mod tests {
    use swarm_core::commands::{Ctx, Registry};
    use swarm_core::events::WorkerKilledPayload;
    use tauri::test::{mock_builder, mock_context, noop_assets};

    use super::*;
    use crate::test_support::{start_runtime, temp_dir};

    /// Events recorded right before the shutdown are all in the event log
    /// once `shutdown` returns, and the metrics loop is stopped.
    #[tokio::test(flavor = "multi_thread")]
    async fn shutdown_persists_everything_recorded_before_it() {
        let data_dir = temp_dir("lifecycle-drain");
        let runtime = start_runtime(&data_dir, |_| {});

        const RECORDED: usize = 500;
        for _ in 0..RECORDED {
            runtime
                .sink
                .emit(SwarmEvent::WorkerKilled(WorkerKilledPayload {
                    worker_id: Default::default(),
                }));
        }
        shutdown(&runtime).await;

        assert!(runtime.metrics_cancel.is_cancelled());
        let persisted = Registry::new()
            .dispatch(
                "events_since",
                Ctx::from_runtime(&runtime),
                serde_json::json!({ "afterSeq": 0 }),
            )
            .await
            .unwrap();
        let killed = persisted
            .as_array()
            .unwrap()
            .iter()
            .filter(|event| event["type"] == "worker_killed")
            .count();
        assert_eq!(killed, RECORDED);
    }

    /// The app's run-event callback shuts the managed runtime down when
    /// the event loop exits, and on no other event.
    #[test]
    fn the_exit_event_shuts_the_managed_runtime_down() {
        let tokio = tokio::runtime::Runtime::new().unwrap();
        let _context = tokio.enter();
        let data_dir = temp_dir("lifecycle-exit");
        let runtime = start_runtime(&data_dir, |_| {});
        let app = mock_builder().build(mock_context(noop_assets())).unwrap();
        app.manage(runtime);
        let stopped = || app.state::<Runtime>().metrics_cancel.is_cancelled();

        on_run_event(app.handle(), RunEvent::Ready);
        assert!(!stopped());

        on_run_event(app.handle(), RunEvent::Exit);
        assert!(stopped());
    }

    /// Exiting after a failed start, with no runtime managed, is a no-op.
    #[test]
    fn the_exit_event_without_a_runtime_does_nothing() {
        let app = mock_builder().build(mock_context(noop_assets())).unwrap();
        on_run_event(app.handle(), RunEvent::Exit);
    }
}
