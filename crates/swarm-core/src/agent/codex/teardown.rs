//! Session teardown: runs exactly once; also the exit-signal name that
//! teardown's [`ExitSummary`] carries.

use std::mem::DropGuard;
use std::sync::Arc;

use super::PROCESS_EXITED_WITHOUT_RECEIPT;
use super::process::reap;
use super::state::{Shared, TurnSlot};

use crate::agent::adapter::{AgentTurnStatus, ExitSummary};
use crate::agent::drained_stderr_snippet;
use crate::events::{AgentSessionExitedPayload, AgentTurnSettledPayload, Provenance, SwarmEvent};

/// The terminating signal's name, on Unix.
#[cfg(unix)]
pub(super) fn signal_name(status: &std::process::ExitStatus) -> Option<String> {
    use std::os::unix::process::ExitStatusExt;
    /// Signals whose numbers agree across Linux and macOS.
    const NAMES: [(i32, &str); 9] = [
        (1, "SIGHUP"),
        (2, "SIGINT"),
        (3, "SIGQUIT"),
        (6, "SIGABRT"),
        (9, "SIGKILL"),
        (11, "SIGSEGV"),
        (13, "SIGPIPE"),
        (14, "SIGALRM"),
        (15, "SIGTERM"),
    ];
    status.signal().map(|signal| {
        NAMES
            .iter()
            .find(|(number, _)| *number == signal)
            .map_or_else(
                || format!("signal {signal}"),
                |(_, name)| (*name).to_string(),
            )
    })
}

/// Windows has no signals: a killed process has only an exit code.
#[cfg(not(unix))]
pub(super) fn signal_name(_status: &std::process::ExitStatus) -> Option<String> {
    None
}

/// Arms teardown for a guard dropped without being dismissed (a dropped
/// spawn future, a panicking reader): spawns [`teardown`] on the current
/// runtime, if any.
pub(super) fn teardown_on_drop(
    shared: &Arc<Shared>,
) -> DropGuard<Arc<Shared>, impl FnOnce(Arc<Shared>)> {
    DropGuard::new(Arc::clone(shared), |shared| {
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(async move {
                teardown(&shared).await;
            });
        }
    })
}

/// Tears the session down exactly once; every later call returns the
/// first call's [`ExitSummary`].
///
/// Under the state lock it marks the session closing (from then on no
/// event, request or answer is produced), claims a running turn, drops
/// every pending request's reply channel (their callers resolve as
/// closed) and forgets pending approvals. It then closes stdin, gives the
/// child [`super::Timeouts::graceful_exit`] to exit, kills and reaps it on the
/// blocking pool, and — only for a session whose start was announced —
/// synthesizes the running turn's settlement (Condition B) and emits
/// `agent_session_exited`.
pub(super) async fn teardown(shared: &Arc<Shared>) -> ExitSummary {
    let _gate = shared.teardown_gate.lock().await;

    let (running, child, writer, announced) = {
        let mut inner = shared.state.lock();
        if let Some(exit) = &inner.exit {
            return exit.clone();
        }
        inner.closing = true;
        let running = match std::mem::replace(&mut inner.turn, TurnSlot::Idle) {
            TurnSlot::Running(turn_id) => Some(turn_id),
            TurnSlot::Idle | TurnSlot::Starting => None,
        };
        inner.pending.clear();
        inner.approvals.clear();
        (
            running,
            inner.child.take(),
            inner.writer.take(),
            inner.announced,
        )
    };

    // Closing the writer's queue ends its thread, which drops stdin.
    drop(writer);
    let status = match child {
        Some(child) => {
            let grace = shared.timeouts.graceful_exit;
            tokio::task::spawn_blocking(move || reap(child, grace))
                .await
                .ok()
                .flatten()
        }
        None => None,
    };
    let exit = ExitSummary {
        exit_code: status.and_then(|status| status.code()),
        signal: status.as_ref().and_then(signal_name),
    };

    if announced {
        if let Some(turn_id) = &running {
            // Take the cause in its own statement: matching on the lock
            // expression would keep its !Send guard alive across the await.
            let cause = shared.teardown_cause.lock().take();
            let detail = match cause {
                Some(cause) => cause,
                None => drained_stderr_snippet(&shared.stderr_tail).await,
            };
            shared.emit(SwarmEvent::AgentTurnSettled(AgentTurnSettledPayload {
                worker_id: shared.worker_id,
                turn_id: turn_id.clone(),
                status: AgentTurnStatus::Error,
                error: Some(format!("{PROCESS_EXITED_WITHOUT_RECEIPT} ({detail})")),
                cost_usd: None,
                usage: None,
                duration_ms: 0,
                num_turns: None,
            }));
        }
        let persisted = shared.sink.emit_awaiting_seq(
            SwarmEvent::AgentSessionExited(AgentSessionExitedPayload {
                worker_id: shared.worker_id,
                exit_code: exit.exit_code,
                signal: exit.signal.clone(),
            }),
            Provenance::default(),
        );
        // A dropped acknowledgement means the event writer is gone or the event
        // could not be saved (it fails closed); either way there is nothing to
        // wait for.
        let _ = persisted.await;
    }

    shared.state.lock().exit = Some(exit.clone());
    shared.settled.send_modify(|settled| {
        settled.recent.extend(running);
        settled.closed = true;
    });
    exit
}
