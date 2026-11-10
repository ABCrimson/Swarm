//! The attention badge: how many workers wait on a permission question.
//!
//! A provider that needs a human decision emits `agent_permission_request`
//! without a suggested decision (one with a suggested decision reports a
//! denial the provider already made, and asks nothing). The event stream
//! has no event for an answered question, because the webview closes it
//! in its own store, so the shell keeps its own set: a question opens on
//! that event (from the [`crate::startup`] event callback), closes when
//! `agent_permission_respond` for it succeeds (from
//! [`crate::commands`]), and every question of a worker closes when its
//! turn settles or its session exits, since none can outlive the turn
//! that asked it.
//!
//! The badge is the number of distinct workers with an open question. It
//! is the dock badge on macOS and the launcher badge on Linux; Windows
//! has no badge count (tauri-runtime-wry ignores `set_badge_count` there).
//! When the number rises while the main window is unfocused, the window
//! requests the user's attention on every OS. Everything is driven from
//! Rust: the webview has no permission for any of it.

use std::collections::HashSet;
use std::sync::Arc;

use parking_lot::Mutex;
use serde_json::Value;
use swarm_core::agent::PermissionId;
use swarm_core::events::SwarmEvent;
use swarm_core::worker::registry::WorkerId;
use tauri::{AppHandle, Manager, UserAttentionType};

use crate::MAIN_WINDOW;

/// The open permission questions, keyed by the asking worker and the
/// request id: an id is unique only per worker (each provider session
/// numbers its own requests). A pure type, so the counting is tested
/// without a window.
#[derive(Debug, Default)]
pub(crate) struct OpenQuestions {
    asks: HashSet<(WorkerId, PermissionId)>,
}

impl OpenQuestions {
    /// Opens or closes questions for one event of the ordered stream.
    pub(crate) fn observe(&mut self, event: &SwarmEvent) {
        match event {
            SwarmEvent::AgentPermissionRequest(request) if request.suggested_decision.is_none() => {
                self.asks
                    .insert((request.worker_id, request.request_id.clone()));
            }
            SwarmEvent::AgentTurnSettled(settled) => self.release(settled.worker_id),
            SwarmEvent::AgentSessionExited(exited) => self.release(exited.worker_id),
            _ => {}
        }
    }

    /// Closes `worker`'s question `request_id`, which was just answered.
    pub(crate) fn answered(&mut self, worker: WorkerId, request_id: &str) {
        self.asks.remove(&(worker, request_id.to_owned()));
    }

    /// Closes every question of `worker`.
    fn release(&mut self, worker: WorkerId) {
        self.asks.retain(|(asker, _)| *asker != worker);
    }

    /// How many distinct workers wait on an answer: the badge.
    pub(crate) fn workers_waiting(&self) -> usize {
        self.asks
            .iter()
            .map(|(worker, _)| worker)
            .collect::<HashSet<_>>()
            .len()
    }
}

/// The question a command call answered: `agent_permission_respond`'s
/// `workerId` and `requestId`, once the command has succeeded. `None` for
/// any other command, a failed call, or arguments without both (the
/// worker id must parse as a UUID).
fn answered_request<'a>(
    command: &str,
    args: &'a Value,
    succeeded: bool,
) -> Option<(WorkerId, &'a str)> {
    if !succeeded || command != "agent_permission_respond" {
        return None;
    }
    let worker = WorkerId::parse_str(args.get("workerId")?.as_str()?).ok()?;
    Some((worker, args.get("requestId")?.as_str()?))
}

/// Managed state: the open questions, shared by the event callback and
/// the command forwarders.
#[derive(Clone, Default)]
pub(crate) struct Attention {
    questions: Arc<Mutex<OpenQuestions>>,
}

impl Attention {
    /// Applies one event of the ordered stream and updates the badge.
    /// Every other event (terminal output among them) returns before the
    /// lock.
    pub(crate) fn on_event<R: tauri::Runtime>(&self, app: &AppHandle<R>, event: &SwarmEvent) {
        if !matches!(
            event,
            SwarmEvent::AgentPermissionRequest(_)
                | SwarmEvent::AgentTurnSettled(_)
                | SwarmEvent::AgentSessionExited(_)
        ) {
            return;
        }
        self.update(
            |questions| questions.observe(event),
            |before, after| {
                show(app, before, after);
            },
        );
    }

    /// Closes the question a successful `agent_permission_respond`
    /// answered, if `command` was one, and updates the badge.
    pub(crate) fn on_command<R: tauri::Runtime>(
        &self,
        app: &AppHandle<R>,
        command: &str,
        args: &Value,
        succeeded: bool,
    ) {
        if let Some((worker, request_id)) = answered_request(command, args, succeeded) {
            self.update(
                |questions| questions.answered(worker, request_id),
                |before, after| {
                    show(app, before, after);
                },
            );
        }
    }

    /// Runs `change` and, when the badge number moved, `notify` with the
    /// number before and after. `notify` runs under the lock, so changes
    /// from the event writer thread and the command tasks reach it in the
    /// order they were made.
    fn update(&self, change: impl FnOnce(&mut OpenQuestions), notify: impl FnOnce(usize, usize)) {
        let mut questions = self.questions.lock();
        let before = questions.workers_waiting();
        change(&mut questions);
        let after = questions.workers_waiting();
        if before != after {
            notify(before, after);
        }
    }
}

/// Queues the badge update on the main thread, which applies queued tasks
/// in order. There `is_focused` is answered directly; from another
/// thread it would block on the event loop.
fn show<R: tauri::Runtime>(app: &AppHandle<R>, before: usize, after: usize) {
    let handle = app.clone();
    let queued = app.run_on_main_thread(move || {
        let Some(window) = handle.get_webview_window(MAIN_WINDOW) else {
            return;
        };
        let count = (after > 0).then(|| i64::try_from(after).unwrap_or(i64::MAX));
        if let Err(error) = window.set_badge_count(count) {
            tracing::warn!(%error, "failed to set the attention badge");
        }
        if after > before
            && !window.is_focused().unwrap_or(false)
            && let Err(error) =
                window.request_user_attention(Some(UserAttentionType::Informational))
        {
            tracing::warn!(%error, "failed to request the user's attention");
        }
    });
    if let Err(error) = queued {
        tracing::warn!(%error, "failed to queue the attention badge update");
    }
}

#[cfg(test)]
mod tests {
    use swarm_core::agent::{AgentTurnStatus, PermissionDecision};
    use swarm_core::events::{
        AgentPermissionRequestPayload, AgentSessionExitedPayload, AgentTurnSettledPayload,
    };

    use super::*;

    const WORKER: WorkerId = WorkerId::from_u128(1);

    fn ask(worker: WorkerId, request: &str) -> SwarmEvent {
        SwarmEvent::AgentPermissionRequest(AgentPermissionRequestPayload {
            worker_id: worker,
            turn_id: "turn".into(),
            request_id: request.into(),
            tool: "Bash".into(),
            input: serde_json::Value::Null,
            suggested_decision: None,
            denial_subclass: None,
            message: None,
        })
    }

    fn settle(worker: WorkerId) -> SwarmEvent {
        SwarmEvent::AgentTurnSettled(AgentTurnSettledPayload {
            worker_id: worker,
            turn_id: "turn".into(),
            status: AgentTurnStatus::Ok,
            error: None,
            cost_usd: None,
            usage: None,
            duration_ms: 1,
            num_turns: None,
        })
    }

    fn exit(worker: WorkerId) -> SwarmEvent {
        SwarmEvent::AgentSessionExited(AgentSessionExitedPayload {
            worker_id: worker,
            exit_code: Some(0),
            signal: None,
        })
    }

    #[test]
    fn a_question_waits() {
        let mut questions = OpenQuestions::default();
        questions.observe(&ask(WORKER, "r1"));
        assert_eq!(questions.workers_waiting(), 1);
    }

    #[test]
    fn an_answer_closes_the_question() {
        let mut questions = OpenQuestions::default();
        questions.observe(&ask(WORKER, "r1"));
        questions.answered(WORKER, "r1");
        assert_eq!(questions.workers_waiting(), 0);
    }

    #[test]
    fn a_settled_turn_closes_its_workers_questions() {
        let mut questions = OpenQuestions::default();
        questions.observe(&ask(WORKER, "r1"));
        questions.observe(&settle(WORKER));
        assert_eq!(questions.workers_waiting(), 0);
    }

    #[test]
    fn an_exited_session_closes_its_workers_questions() {
        let mut questions = OpenQuestions::default();
        questions.observe(&ask(WORKER, "r1"));
        questions.observe(&exit(WORKER));
        assert_eq!(questions.workers_waiting(), 0);
    }

    /// A request with a suggested decision reports a denial the provider
    /// already made: nothing is left to answer.
    #[test]
    fn a_denial_report_asks_nothing() {
        let mut questions = OpenQuestions::default();
        let SwarmEvent::AgentPermissionRequest(mut payload) = ask(WORKER, "r1") else {
            unreachable!()
        };
        payload.suggested_decision = Some(PermissionDecision::Deny);
        questions.observe(&SwarmEvent::AgentPermissionRequest(payload));
        assert_eq!(questions.workers_waiting(), 0);
    }

    /// The badge counts workers, not questions.
    #[test]
    fn two_questions_from_one_worker_count_once() {
        let mut questions = OpenQuestions::default();
        questions.observe(&ask(WORKER, "r1"));
        questions.observe(&ask(WORKER, "r2"));
        assert_eq!(questions.workers_waiting(), 1);
        questions.answered(WORKER, "r1");
        assert_eq!(questions.workers_waiting(), 1);
    }

    /// Request ids are unique only per worker: the same id from two
    /// workers is two questions, and answering one leaves the other.
    #[test]
    fn the_same_request_id_from_two_workers_is_two_questions() {
        let other = WorkerId::from_u128(2);
        let mut questions = OpenQuestions::default();
        questions.observe(&ask(WORKER, "7"));
        questions.observe(&ask(other, "7"));
        assert_eq!(questions.workers_waiting(), 2);
        questions.answered(WORKER, "7");
        assert_eq!(questions.workers_waiting(), 1);
    }

    /// Another worker's settled turn leaves this worker's question open.
    #[test]
    fn a_settled_turn_leaves_other_workers_questions() {
        let mut questions = OpenQuestions::default();
        questions.observe(&ask(WORKER, "r1"));
        questions.observe(&ask(WorkerId::from_u128(2), "r2"));
        questions.observe(&settle(WorkerId::from_u128(2)));
        assert_eq!(questions.workers_waiting(), 1);
    }

    /// Only a successful `agent_permission_respond` closes a question,
    /// and the request id is read from its camelCase arguments.
    #[test]
    fn only_a_successful_respond_reports_an_answer() {
        let args = serde_json::json!({
            "workerId": WORKER.to_string(),
            "requestId": "r1",
            "decision": "allow",
        });
        assert_eq!(
            answered_request("agent_permission_respond", &args, true),
            Some((WORKER, "r1"))
        );
        assert_eq!(
            answered_request("agent_permission_respond", &args, false),
            None
        );
        assert_eq!(answered_request("kill_worker", &args, true), None);
        let no_worker = serde_json::json!({ "requestId": "r1" });
        assert_eq!(
            answered_request("agent_permission_respond", &no_worker, true),
            None
        );
        let bad_worker = serde_json::json!({ "workerId": "w", "requestId": "r1" });
        assert_eq!(
            answered_request("agent_permission_respond", &bad_worker, true),
            None
        );
    }

    /// The badge is shown only when the count moves, and attention is
    /// requested only when it rises.
    #[test]
    fn changes_are_reported_only_when_the_count_moves() {
        let attention = Attention::default();
        let moved = |change: &dyn Fn(&mut OpenQuestions)| {
            let mut moved = None;
            attention.update(change, |before, after| moved = Some((before, after)));
            moved
        };
        assert_eq!(moved(&|q| q.observe(&ask(WORKER, "r1"))), Some((0, 1)));
        assert_eq!(moved(&|q| q.observe(&ask(WORKER, "r2"))), None);
        assert_eq!(moved(&|q| q.answered(WORKER, "r1")), None);
        assert_eq!(moved(&|q| q.observe(&settle(WORKER))), Some((1, 0)));
    }
}
