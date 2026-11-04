//! Session teardown: runs exactly once, in its own task.

use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;

use super::SHUTDOWN_GRACE;
use super::process::reap;
use super::state::{Shared, Stop};
use crate::agent::adapter::{AgentTurnStatus, ExitSummary};
use crate::agent::{PROCESS_EXITED_WITHOUT_RECEIPT, drained_stderr_snippet, signal_name};
use crate::events::{AgentSessionExitedPayload, AgentTurnSettledPayload, Provenance, SwarmEvent};
use crate::worker::proc::{ExitSequence, stop_tree};

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
/// stops the child and its process tree on the blocking pool
/// ([`stop_tree`]: an idle CLI gets its stdin EOF and a grace to exit, a
/// busy one is killed before its stdin closes), synthesizes Condition B's
/// settlement for a turn that never got its receipt, emits
/// `agent_session_exited`, and publishes the exit summary.
async fn run_teardown(shared: Arc<Shared>, stop: Stop) {
    let (in_flight, child) = {
        let mut inner = shared.state.lock();
        inner.closing = true;
        inner.asks.clear();
        inner.control_waiters.clear();
        let turn = inner.turn.take();
        shared.publish_in_flight(None);
        (turn, inner.child.take())
    };
    // An idle CLI ends its session at stdin EOF; a busy one is killed at
    // once (a zero grace kills before stdin closes, so the CLI cannot exit
    // on its EOF first). Either way the tree goes too: a Bash tool call's
    // processes run under the CLI.
    let grace = if stop == Stop::Graceful && in_flight.is_none() {
        SHUTDOWN_GRACE
    } else {
        Duration::ZERO
    };
    let status = match child {
        Some(mut child) => {
            let closing = Arc::clone(&shared);
            let stopped = tokio::task::spawn_blocking(move || {
                stop_tree(
                    &mut child,
                    || closing.stdin.close(),
                    ExitSequence::CloseStdinThenWait,
                    grace,
                );
                child
            })
            .await;
            match stopped {
                // Only collects the status, or kills the child itself if
                // the tree kill could not run.
                Ok(child) => reap(child).await,
                Err(error) => {
                    // The closure never ran, so stdin is still open: an
                    // idle CLI still gets its EOF.
                    shared.stdin.close();
                    tracing::error!(worker_id = %shared.worker_id, %error, "claude adapter: the stop task failed");
                    None
                }
            }
        }
        None => {
            shared.stdin.close();
            None
        }
    };
    let summary = ExitSummary {
        exit_code: status.and_then(|status| status.code()),
        signal: status.as_ref().and_then(signal_name),
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
