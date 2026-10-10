//! Session teardown: runs exactly once, in its own task.

use std::process::ExitStatus;
use std::sync::Arc;
use std::sync::atomic::Ordering;

use super::PROCESS_EXITED_WITHOUT_RECEIPT;
use super::process::reap;
use super::state::{Shared, Stop};
use crate::agent::adapter::{AgentTurnStatus, ExitSummary};
use crate::agent::drained_stderr_snippet;
use crate::events::{AgentSessionExitedPayload, AgentTurnSettledPayload, Provenance, SwarmEvent};

// ── Teardown ─────────────────────────────────────────────────────────

/// Starts teardown once; later calls are no-ops. It runs in its own task
/// so a caller that stops waiting (a dropped `shutdown` future) cannot
/// leave it half done.
pub(super) fn begin_teardown(shared: &Arc<Shared>, stop: Stop) {
    if shared.teardown_started.swap(true, Ordering::AcqRel) {
        return;
    }
    tokio::spawn(run_teardown(shared.clone(), stop));
}

/// Tears the session down (once, whoever asks first) and returns the
/// exit summary every caller shares.
pub(super) async fn teardown(shared: &Arc<Shared>, stop: Stop) -> ExitSummary {
    begin_teardown(shared, stop);
    let mut status = shared.status.subscribe();
    status
        .wait_for(|status| status.exit.is_some())
        .await
        .ok()
        .and_then(|status| status.exit.clone())
        .unwrap_or(ExitSummary {
            exit_code: None,
            signal: None,
        })
}

/// Claims the in-flight turn and the child in one critical section,
/// closes stdin, stops the child (gracefully only when idle), synthesizes
/// Condition B's settlement for a turn that never got its receipt, emits
/// `agent_session_exited`, and publishes the exit summary.
pub(super) async fn run_teardown(shared: Arc<Shared>, stop: Stop) {
    let (in_flight, child) = {
        let mut inner = shared.state.lock();
        inner.closing = true;
        inner.asks.clear();
        inner.control_waiters.clear();
        let turn = inner.turn.take();
        shared.publish_in_flight(None);
        (turn, inner.child.take())
    };
    shared.stdin.close();

    let graceful = stop == Stop::Graceful && in_flight.is_none();
    let status = match child {
        Some(child) => reap(child, graceful).await,
        None => None,
    };
    let summary = ExitSummary {
        exit_code: status.and_then(|status| status.code()),
        signal: status.and_then(signal_name),
    };

    if let Some(turn) = in_flight {
        let cause = shared.teardown_cause.lock().take();
        let detail = match cause {
            Some(cause) => cause,
            None => drained_stderr_snippet(&shared.stderr_tail).await,
        };
        shared
            .sink
            .emit(SwarmEvent::AgentTurnSettled(AgentTurnSettledPayload {
                worker_id: shared.worker_id,
                turn_id: turn.id,
                status: AgentTurnStatus::Error,
                error: Some(format!("{PROCESS_EXITED_WITHOUT_RECEIPT} ({detail})")),
                cost_usd: None,
                usage: None,
                duration_ms: 0,
                num_turns: None,
            }));
    }

    // Awaiting the ack orders the settlement above (if any) and this row
    // on disk before any caller learns the session is gone.
    shared
        .sink
        .emit_awaiting_seq(
            SwarmEvent::AgentSessionExited(AgentSessionExitedPayload {
                worker_id: shared.worker_id,
                exit_code: summary.exit_code,
                signal: summary.signal.clone(),
            }),
            Provenance::default(),
        )
        .await
        .ok();

    shared
        .status
        .send_modify(|status| status.exit = Some(summary));
}

/// `"SIGKILL"` for a Unix exit status that ended on signal 9, and so on.
#[cfg(unix)]
pub(super) fn signal_name(status: ExitStatus) -> Option<String> {
    use std::os::unix::process::ExitStatusExt;
    status.signal().map(|signal| {
        match signal {
            1 => "SIGHUP",
            2 => "SIGINT",
            3 => "SIGQUIT",
            6 => "SIGABRT",
            9 => "SIGKILL",
            11 => "SIGSEGV",
            13 => "SIGPIPE",
            15 => "SIGTERM",
            other => return format!("SIG{other}"),
        }
        .to_owned()
    })
}

/// Windows has no signals: `TerminateProcess` sets an exit code.
#[cfg(not(unix))]
pub(super) fn signal_name(_status: ExitStatus) -> Option<String> {
    None
}
