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

use std::time::Duration;

use swarm_core::runtime::Runtime;
use tauri::{AppHandle, Manager, RunEvent};

/// Budget for each of the exit teardown's two phases (agent sessions,
/// then the event writer's drain), so the whole teardown takes at most
/// about 5 s. Every window is already gone when it runs, so it can only
/// delay the process exit, never freeze the UI.
const SHUTDOWN_PHASE_TIMEOUT: Duration = Duration::from_millis(2500);

/// The app's run-event callback.
pub(crate) fn on_run_event<R: tauri::Runtime>(app: &AppHandle<R>, event: RunEvent) {
    if let RunEvent::Exit = event
        // Absent when the start failed, which left nothing to shut down.
        && let Some(runtime) = app.try_state::<Runtime>()
    {
        tauri::async_runtime::block_on(shutdown(&runtime));
    }
}

/// Shuts `runtime` down through [`Runtime::shutdown`]: stops the metrics
/// loop, shuts every live agent session down, then drains and finalizes
/// the event log.
///
/// A session's shutdown kills its provider CLI and, for a turn still in
/// flight, records the error `agent_turn_settled` receipt the turn would
/// otherwise never get. The drain persists everything recorded before it
/// (those receipts, `worker_killed`, `ship_settled`, …) and records the
/// exact head seq, so the next start continues without a seq gap.
pub(crate) async fn shutdown(runtime: &Runtime) {
    match runtime.shutdown(SHUTDOWN_PHASE_TIMEOUT).await {
        Ok(head_seq) => tracing::info!(head_seq, "SWARM shut down; the event log is final"),
        Err(error) => tracing::warn!(%error, "shutdown did not finish; exiting anyway"),
    }
}

#[cfg(test)]
mod tests {
    use swarm_core::commands::{Ctx, Registry};
    use swarm_core::events::{SwarmEvent, WorkerKilledPayload};
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
