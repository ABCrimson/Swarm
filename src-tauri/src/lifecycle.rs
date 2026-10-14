//! Orderly shutdown when the app quits.
//!
//! Every way the app quits (closing the last window, Cmd+Q,
//! `AppHandle::exit`, `restart`, `request_restart`) ends in
//! [`tauri::App::cleanup_before_exit`], which runs the plugins'
//! cleanup hooks, and Tauri then exits the process without running the
//! destructors of managed state. [`plugin`] registers the app's hook:
//! it shuts the runtime down, then flushes the release log. Unlike
//! `RunEvent::Exit`, the hook also runs on the exits that skip the event
//! loop (`restart` on the main thread).
//!
//! The hook runs on the main thread when the event loop ends. `exit`,
//! `restart` (off the main thread) and `request_restart` run it on the
//! calling thread instead when they cannot ask the event loop to stop;
//! from an async command that is a Tokio worker, where `Handle::block_on`
//! panics. So the shutdown runs on a scoped helper thread through a handle
//! captured at registration. The caller waits for it: up to
//! `SESSION_SHUTDOWN_TIMEOUT` for the agent sessions, then until the event
//! writer has committed every event accepted before the shutdown, however
//! slow the disk's flushes are (at most `DRAIN_CEILING`, 120 s). That is
//! acceptable only because every window is already gone and the process
//! exits right after. The hook runs its teardown once, however often it
//! is called.
//!
//! Terminal workers are left to the operating system: their PTYs close
//! with the process, which ends the shells they run. Killing them through
//! `kill_worker` instead would also remove their worktrees, which a quit
//! must never do.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use parking_lot::Mutex;
use swarm_core::error::AppError;
use swarm_core::runtime::Runtime;
use tauri::plugin::{Builder, TauriPlugin};
use tauri::{AppHandle, Manager};
use tracing_appender::non_blocking::WorkerGuard;

/// Budget for the exit teardown's agent sessions. The event writer's
/// drain that follows has no budget of its own, because a timer there
/// would drop accepted events whenever the disk's flushes are slow: it
/// waits for the writer's backlog, up to the engine's `DRAIN_CEILING`. Every window is
/// already gone when the teardown runs, so it can only delay the process
/// exit, never freeze the UI.
const SESSION_SHUTDOWN_TIMEOUT: Duration = Duration::from_millis(2500);

/// Managed state of the exit teardown: whether it has run, and the release
/// log's writer guard, which is taken last so the teardown's own lines
/// are flushed.
pub(crate) struct Teardown {
    done: AtomicBool,
    log_guard: Mutex<Option<WorkerGuard>>,
    /// How many times the shutdown actually ran.
    #[cfg(test)]
    runs: std::sync::atomic::AtomicUsize,
}

impl Teardown {
    pub(crate) fn new(log_guard: Option<WorkerGuard>) -> Self {
        Self {
            done: AtomicBool::new(false),
            log_guard: Mutex::new(log_guard),
            #[cfg(test)]
            runs: std::sync::atomic::AtomicUsize::new(0),
        }
    }
}

/// The plugin whose `cleanup_before_exit` hook shuts the app down.
///
/// Must be called inside the Tokio runtime's context (see
/// [`crate::run`]): it captures that runtime's handle for the hook.
pub(crate) fn plugin<R: tauri::Runtime>() -> TauriPlugin<R> {
    let tokio = tokio::runtime::Handle::current();
    Builder::new("swarm-lifecycle")
        .on_cleanup_before_exit(move |app| cleanup(app, &tokio))
        .build()
}

/// Shuts the managed runtime down (absent when the start failed, which
/// left nothing to shut down), then drops the log guard, once.
fn cleanup<R: tauri::Runtime>(app: &AppHandle<R>, tokio: &tokio::runtime::Handle) {
    let Some(teardown) = app.try_state::<Teardown>() else {
        return;
    };
    if teardown.done.swap(true, Ordering::AcqRel) {
        return;
    }
    if let Some(runtime) = app.try_state::<Runtime>() {
        #[cfg(test)]
        teardown.runs.fetch_add(1, Ordering::Relaxed);
        let drained =
            std::thread::scope(|scope| scope.spawn(|| tokio.block_on(shutdown(&runtime))).join());
        if let Err(payload) = drained {
            let reason = payload
                .downcast_ref::<&str>()
                .copied()
                .or_else(|| payload.downcast_ref::<String>().map(String::as_str))
                .unwrap_or("non-string panic payload");
            tracing::error!(%reason, "the shutdown panicked; exiting anyway");
        }
    }
    // Last: Tauri exits the process right after the hook, and dropping
    // the guard writes out every line the log thread still holds. The
    // `done` flag admits one caller, so the lock is never contended.
    drop(teardown.log_guard.lock().take());
}

/// Shuts `runtime` down through [`Runtime::shutdown`]: stops the metrics
/// loop, shuts every live agent session down, then drains and finalizes
/// the event log. Logs the outcome and returns it.
///
/// A session's shutdown kills its provider CLI and, for a turn still in
/// flight, records the error `agent_turn_settled` receipt the turn would
/// otherwise never get. The drain persists everything recorded before it
/// (those receipts, `worker_killed`, `ship_settled`, …), waiting for the
/// writer however slow its flushes are, and records the exact head seq,
/// so the next start continues without a seq gap.
async fn shutdown(runtime: &Runtime) -> Result<u64, AppError> {
    let outcome = runtime.shutdown(SESSION_SHUTDOWN_TIMEOUT).await;
    match &outcome {
        Ok(head_seq) => tracing::info!(head_seq, "SWARM shut down; the event log is final"),
        Err(error) => tracing::error!(%error, "shutdown did not finish; exiting anyway"),
    }
    outcome
}

#[cfg(test)]
mod tests {
    use swarm_core::commands::{Ctx, Registry};
    use swarm_core::events::{SwarmEvent, WorkerKilledPayload};
    use tauri::test::{mock_builder, mock_context, noop_assets};

    use super::*;
    use crate::test_support::{start_runtime, temp_dir};

    /// Events recorded right before the shutdown are all in the event log
    /// once `shutdown` returns, and the metrics loop is stopped. The drain
    /// waits for the writer's backlog, so this holds however slow the
    /// disk's flushes are; a fixed drain budget does not (the Windows
    /// runner's NTFS commits about 400 of the 500 in 2.5 s).
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
        let head = shutdown(&runtime)
            .await
            .expect("the drain waits until every accepted event is committed");

        assert!(runtime.metrics_cancel.is_cancelled());
        assert!(
            head >= RECORDED as u64,
            "head {head} is behind the {RECORDED} recorded events"
        );
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

    /// A mock app with the lifecycle plugin, a started runtime and the
    /// teardown state, built inside the current Tokio context.
    fn app_with_runtime(name: &str) -> tauri::App<tauri::test::MockRuntime> {
        let data_dir = temp_dir(name);
        let runtime = start_runtime(&data_dir, |_| {});
        let app = mock_builder()
            .plugin(plugin())
            .build(mock_context(noop_assets()))
            .unwrap();
        app.manage(runtime);
        let (_writer, guard) = tracing_appender::non_blocking(std::io::sink());
        app.manage(Teardown::new(Some(guard)));
        app
    }

    /// Cleaning up shuts the managed runtime down, and does it once:
    /// a second call (the exit paths can reach the hook twice) drains
    /// nothing again.
    #[test]
    fn cleanup_shuts_the_runtime_down_once() {
        let tokio = tokio::runtime::Runtime::new().unwrap();
        let _context = tokio.enter();
        let app = app_with_runtime("lifecycle-exit");
        let stopped = || app.state::<Runtime>().metrics_cancel.is_cancelled();
        let runs = || app.state::<Teardown>().runs.load(Ordering::Relaxed);
        assert!(!stopped());

        app.cleanup_before_exit();
        assert!(
            app.state::<Teardown>().log_guard.lock().is_none(),
            "the hook did not take the log guard"
        );
        assert!(stopped());
        assert_eq!(runs(), 1);

        app.cleanup_before_exit();
        assert_eq!(runs(), 1);
    }

    /// Safe on a thread inside a Tokio runtime, where `block_on` would
    /// panic: exit/restart/request_restart from an async command run the
    /// hook there when the event loop cannot be asked to stop.
    #[tokio::test(flavor = "multi_thread")]
    async fn cleanup_is_safe_on_a_tokio_worker() {
        let app = app_with_runtime("lifecycle-worker");

        app.cleanup_before_exit();
        app.cleanup_before_exit();

        assert!(app.state::<Runtime>().metrics_cancel.is_cancelled());
        assert_eq!(app.state::<Teardown>().runs.load(Ordering::Relaxed), 1);
    }

    /// Exiting after a failed start, with no runtime managed, is a no-op.
    #[test]
    fn cleanup_without_a_runtime_does_nothing() {
        let tokio = tokio::runtime::Runtime::new().unwrap();
        let _context = tokio.enter();
        let app = mock_builder()
            .plugin(plugin())
            .build(mock_context(noop_assets()))
            .unwrap();
        app.manage(Teardown::new(None));
        app.cleanup_before_exit();
        assert_eq!(app.state::<Teardown>().runs.load(Ordering::Relaxed), 0);
    }
}
