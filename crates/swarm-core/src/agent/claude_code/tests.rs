//! Unit tests for [`super`]: the pure helpers directly, and every
//! session path end to end against `fake_claude_cli.mjs` (run with
//! `node`), which speaks the CLI's protocol with its real ordering.

use std::path::PathBuf;
use std::time::{Duration, Instant};

use serde_json::{Value, json};

use super::wire::{self, AccountInfo, Delta, Inbound, InitializeResponse, SignIn, StreamEvent};
use super::*;
use crate::orchestration::{EventLog, OrchestrationEngine};

// ── Harness ──────────────────────────────────────────────────────────

/// How long any single wait in these tests may take before it fails.
const WAIT: Duration = Duration::from_secs(10);

fn fixture(name: &str) -> String {
    format!(
        "{}/tests/fixtures/claude_code/{name}",
        env!("CARGO_MANIFEST_DIR")
    )
}

/// Every event the engine ordered (ephemeral ones included), serialized
/// as the wire envelope: `{ seq, ts, type, payload }`.
#[derive(Clone, Default)]
struct Recorder(Arc<parking_lot::Mutex<Vec<Value>>>);

impl Recorder {
    fn payloads(&self, kind: &str) -> Vec<Value> {
        self.0
            .lock()
            .iter()
            .filter(|event| event["type"] == kind)
            .map(|event| event["payload"].clone())
            .collect()
    }

    fn count(&self, kind: &str) -> usize {
        self.payloads(kind).len()
    }

    fn kinds(&self) -> Vec<String> {
        self.0
            .lock()
            .iter()
            .filter_map(|event| event["type"].as_str().map(str::to_owned))
            .collect()
    }

    async fn wait_until(&self, what: &str, done: impl Fn(&Self) -> bool) {
        let deadline = Instant::now() + WAIT;
        while !done(self) {
            assert!(
                Instant::now() < deadline,
                "timed out waiting for {what}; events so far: {:?}",
                self.kinds()
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    async fn wait_for(&self, kind: &str, count: usize) {
        self.wait_until(&format!("{count} x {kind}"), |events| {
            events.count(kind) >= count
        })
        .await;
    }
}

struct Harness {
    recorder: Recorder,
    sink: EventSink,
    db_path: Option<PathBuf>,
    cwd: PathBuf,
}

impl Harness {
    /// An in-memory engine; assertions read the [`Recorder`].
    fn new() -> Self {
        Self::build(false)
    }

    /// A file-backed engine, for assertions on what persists.
    fn persisted() -> Self {
        Self::build(true)
    }

    fn build(persist: bool) -> Self {
        let recorder = Recorder::default();
        let db_path = persist
            .then(|| std::env::temp_dir().join(format!("swarm-claude-code-{}.db", Uuid::new_v4())));
        let log = match &db_path {
            Some(path) => EventLog::open(path).expect("open file-backed log"),
            None => EventLog::open_in_memory().expect("open in-memory log"),
        };
        let events = recorder.clone();
        let engine = OrchestrationEngine::start(log, db_path.clone(), move |event| {
            events
                .0
                .lock()
                .push(serde_json::to_value(event).expect("event serializes"));
        });
        let cwd = std::env::temp_dir().join(format!("swarm-claude-code-cwd-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&cwd).expect("create test cwd");
        Self {
            recorder,
            sink: engine.sink(),
            db_path,
            cwd,
        }
    }

    fn adapter(&self, scenario: &str) -> ClaudeCodeAdapter {
        ClaudeCodeAdapter::with_test_binary(
            self.sink.clone(),
            "node",
            vec![fixture("fake_claude_cli.mjs"), fixture(scenario)],
        )
    }

    fn spec(&self) -> AgentSpawnSpec {
        AgentSpawnSpec {
            worker_id: Uuid::new_v4(),
            cwd: self.cwd.display().to_string(),
            model: Some("sonnet".to_owned()),
            resume: None,
            permission_mode: None,
        }
    }

    async fn try_spawn(
        &self,
        scenario: &str,
        spec: AgentSpawnSpec,
    ) -> Result<Box<dyn AgentSession>, AppError> {
        self.adapter(scenario).spawn(spec).await
    }

    async fn spawn(&self, scenario: &str) -> Box<dyn AgentSession> {
        self.try_spawn(scenario, self.spec())
            .await
            .expect("spawn against the fake claude cli")
    }

    /// Rows the engine persisted, as `(type, payload)`.
    fn persisted_rows(&self) -> Vec<(String, Value)> {
        let path = self.db_path.as_ref().expect("a persisted harness");
        EventLog::open(path)
            .expect("reopen log")
            .events_since(0, 1000)
            .expect("read events")
            .into_iter()
            .map(|row| (row.event_type, row.payload))
            .collect()
    }
}

impl Drop for Harness {
    fn drop(&mut self) {
        if let Some(path) = &self.db_path {
            for suffix in ["", "-wal", "-shm"] {
                std::fs::remove_file(format!("{}{suffix}", path.display())).ok();
            }
        }
        std::fs::remove_dir_all(&self.cwd).ok();
    }
}

async fn send(session: &dyn AgentSession, prompt: &str) -> TurnId {
    session
        .send_turn(TurnInput {
            prompt: prompt.to_owned(),
        })
        .await
        .expect("send_turn")
}

fn settled_for(events: &Recorder, turn: &str) -> Vec<Value> {
    events
        .payloads("agent_turn_settled")
        .into_iter()
        .filter(|settled| settled["turnId"] == turn)
        .collect()
}

fn assert_close(actual: &Value, expected: f64) {
    let actual = actual.as_f64().expect("a number");
    assert!(
        (actual - expected).abs() < 1e-9,
        "expected {expected}, got {actual}"
    );
}

// ── Turns ────────────────────────────────────────────────────────────

/// The spawn handshake needs no `system/init` (the CLI sends none before
/// the first prompt), the turn streams and settles, and persistence
/// keeps everything but the ephemeral deltas.
#[tokio::test]
async fn happy_turn_settles_ok_and_persists_every_class_but_deltas() {
    let harness = Harness::persisted();
    let session = harness.spawn("happy_turn.mjs").await;
    let turn = send(session.as_ref(), "Explain binary search in one sentence.").await;
    harness.recorder.wait_for("agent_turn_settled", 1).await;
    session.shutdown().await.expect("shutdown");

    let started = harness.recorder.payloads("agent_session_started");
    assert_eq!(started.len(), 1);
    assert_eq!(started[0]["sessionKey"], *session.session_key());
    assert_eq!(
        started[0]["model"], "claude-sonnet-5",
        "the alias resolves through the handshake's model list"
    );
    assert_eq!(started[0]["capabilities"]["cancelGranularity"], "graceful");
    assert_eq!(started[0]["capabilities"]["interactivePermissions"], true);

    let deltas = harness.recorder.payloads("agent_turn_delta");
    let text: String = deltas
        .iter()
        .map(|delta| delta["text"].as_str().expect("delta text"))
        .collect();
    assert_eq!(
        text,
        "Binary search finds a value in a sorted collection by repeatedly cutting the search space in half."
    );
    assert!(deltas.iter().all(|delta| delta["turnId"] == turn));

    let settled = settled_for(&harness.recorder, &turn);
    assert_eq!(settled.len(), 1);
    assert_eq!(settled[0]["status"], "ok");
    assert!(settled[0]["error"].is_null());
    assert_close(&settled[0]["costUsd"], 0.032_856_6);
    assert_eq!(settled[0]["durationMs"], 3378);
    assert_eq!(settled[0]["numTurns"], 1);

    let exited = harness.recorder.payloads("agent_session_exited");
    assert_eq!(exited.len(), 1);
    assert_eq!(
        exited[0]["exitCode"], 0,
        "an idle session exits on stdin EOF"
    );

    let persisted: Vec<String> = harness
        .persisted_rows()
        .into_iter()
        .map(|(kind, _)| kind)
        .collect();
    for kind in [
        "agent_session_started",
        "agent_block",
        "agent_turn_settled",
        "agent_session_exited",
    ] {
        assert!(persisted.iter().any(|row| row == kind), "{kind} persists");
    }
    assert!(
        !persisted.iter().any(|row| row == "agent_turn_delta"),
        "agent_turn_delta is ephemeral, got: {persisted:?}"
    );
}

/// Both turns run on one process under one session key, and each
/// settlement carries its own cost although the CLI reports a running
/// total.
#[tokio::test]
async fn two_turns_share_one_process_and_report_per_turn_cost() {
    let harness = Harness::new();
    let session = harness.spawn("two_turn.mjs").await;
    let key = session.session_key().clone();

    let first = send(session.as_ref(), "Reply with exactly the single word: ONE").await;
    harness.recorder.wait_for("agent_turn_settled", 1).await;
    let second = send(session.as_ref(), "Reply with exactly the single word: TWO").await;
    harness.recorder.wait_for("agent_turn_settled", 2).await;
    assert_eq!(*session.session_key(), key);
    assert_ne!(first, second);
    session.shutdown().await.expect("shutdown");

    assert_eq!(harness.recorder.count("agent_session_started"), 1);
    let first = settled_for(&harness.recorder, &first);
    let second = settled_for(&harness.recorder, &second);
    assert_eq!((first.len(), second.len()), (1, 1));
    assert_close(&first[0]["costUsd"], 0.061_965_9);
    assert_close(&second[0]["costUsd"], 0.074_196_1 - 0.061_965_9);
}

/// A resumed session keeps the key it was given and, not knowing what
/// the earlier process spent, reports no cost for its first turn rather
/// than the whole session's total.
#[tokio::test]
async fn resumed_session_keeps_its_key_and_withholds_the_unknowable_first_cost() {
    let harness = Harness::new();
    let key = Uuid::new_v4().to_string();
    let spec = AgentSpawnSpec {
        resume: Some(key.clone()),
        ..harness.spec()
    };
    let session = harness
        .try_spawn("happy_turn.mjs", spec)
        .await
        .expect("spawn with resume");
    assert_eq!(*session.session_key(), key);
    let turn = send(session.as_ref(), "hi").await;
    harness.recorder.wait_for("agent_turn_settled", 1).await;
    session.shutdown().await.expect("shutdown");

    let settled = settled_for(&harness.recorder, &turn);
    assert_eq!(settled[0]["status"], "ok");
    assert!(settled[0]["costUsd"].is_null());
    assert_eq!(
        harness.recorder.payloads("agent_session_started")[0]["sessionKey"],
        key
    );
}

/// Every call pairs with its result by id, and no delta is empty (the
/// thinking and signature deltas current models stream carry no text).
#[tokio::test]
async fn tool_turn_pairs_calls_with_results_and_emits_no_empty_deltas() {
    let harness = Harness::new();
    let session = harness.spawn("tool_turn.mjs").await;
    let turn = send(session.as_ref(), "read data.txt").await;
    harness.recorder.wait_for("agent_turn_settled", 1).await;
    session.shutdown().await.expect("shutdown");

    let calls = harness.recorder.payloads("agent_tool_call");
    let results = harness.recorder.payloads("agent_tool_result");
    let ids = |rows: &[Value]| {
        rows.iter()
            .map(|row| row["toolUseId"].as_str().expect("id").to_owned())
            .collect::<Vec<_>>()
    };
    assert_eq!(
        ids(&calls),
        [
            "toolu_01Q2d77HjKTeVx6NBTKLWQdZ",
            "toolu_01HpvhGbVUtQ4YH4H1E1nUoX"
        ]
    );
    assert_eq!(ids(&calls), ids(&results));
    assert_eq!(calls[0]["name"], "Read");
    assert_eq!(calls[0]["input"]["file_path"], "C:\\spike\\repo\\data.txt");
    assert!(results.iter().all(|result| result["isError"] == false));

    let deltas = harness.recorder.payloads("agent_turn_delta");
    assert!(
        deltas
            .iter()
            .all(|delta| delta["text"].as_str().is_some_and(|text| !text.is_empty())),
        "no empty deltas: {deltas:?}"
    );
    assert!(deltas.iter().any(|delta| delta["kind"] == "tool_use"));
    assert!(
        !deltas.iter().any(|delta| delta["kind"] == "thinking"),
        "empty thinking deltas are dropped"
    );

    let blocks = harness.recorder.payloads("agent_block");
    let tool_use_indexes: Vec<&Value> = blocks
        .iter()
        .filter(|block| block["kind"] == "tool_use")
        .map(|block| &block["blockIndex"])
        .collect();
    assert_eq!(tool_use_indexes, [&json!(1), &json!(1)]);
    assert_eq!(settled_for(&harness.recorder, &turn)[0]["numTurns"], 3);
}

/// CONFIRMED regression: the CLI reports API failures with
/// `subtype: "success"` and `is_error: true`; the turn must settle as an
/// error carrying the provider's explanation and diagnostics.
#[tokio::test]
async fn api_error_reported_as_success_settles_as_an_error() {
    let harness = Harness::new();
    let session = harness.spawn("api_error.mjs").await;
    let turn = send(session.as_ref(), "Reply with exactly: pong").await;
    harness.recorder.wait_for("agent_turn_settled", 1).await;
    session.shutdown().await.expect("shutdown");

    let settled = settled_for(&harness.recorder, &turn);
    assert_eq!(settled.len(), 1);
    assert_eq!(settled[0]["status"], "error");
    let error = settled[0]["error"].as_str().expect("error text");
    assert!(
        error.starts_with("There's an issue with the selected model (claude-does-not-exist-9)"),
        "{error}"
    );
    assert!(
        error
            .ends_with("(Terminal Reason: api_error, API Status: 404, Stop Reason: stop_sequence)"),
        "{error}"
    );
}

/// A subagent's frames (`parent_tool_use_id` set) never reach the
/// top-level transcript, not even when they arrive inside an open
/// top-level block.
#[tokio::test]
async fn subagent_traffic_never_touches_the_top_level_transcript() {
    let harness = Harness::new();
    let session = harness.spawn("subagent_turn.mjs").await;
    let turn = send(session.as_ref(), "Use a subagent to say pong.").await;
    harness.recorder.wait_for("agent_turn_settled", 1).await;
    session.shutdown().await.expect("shutdown");

    let calls = harness.recorder.payloads("agent_tool_call");
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0]["name"], "Agent");
    let results = harness.recorder.payloads("agent_tool_result");
    assert_eq!(results.len(), 1);
    assert_eq!(results[0]["toolUseId"], "toolu_01YNXucFFjH6YhH1Fv1N1TVA");

    let deltas = harness.recorder.payloads("agent_turn_delta");
    assert!(
        !deltas
            .iter()
            .any(|delta| delta["text"] == "subagent stream"),
        "subagent deltas are dropped"
    );
    let agent_block = harness
        .recorder
        .payloads("agent_block")
        .into_iter()
        .find(|block| block["kind"] == "tool_use")
        .expect("the Agent tool_use block");
    assert_eq!(
        agent_block["blockIndex"], 1,
        "the subagent's block 0 did not clobber the open top-level block 1"
    );
    let texts: Vec<Value> = harness
        .recorder
        .payloads("agent_block")
        .into_iter()
        .filter(|block| block["kind"] == "text")
        .map(|block| block["content"]["text"].clone())
        .collect();
    assert_eq!(texts, [json!("DONE")]);
    assert_eq!(settled_for(&harness.recorder, &turn)[0]["status"], "ok");
}

/// A turn the CLI starts on its own while SWARM's prompt is queued is
/// neither attributed to the SWARM turn nor allowed to settle it, and
/// its cost is not billed to it.
#[tokio::test]
async fn a_turn_the_cli_started_itself_is_not_pinned_on_the_swarm_turn() {
    let harness = Harness::new();
    let session = harness.spawn("foreign_turn.mjs").await;
    let turn = send(session.as_ref(), "hi").await;
    harness.recorder.wait_for("agent_turn_settled", 1).await;
    session.shutdown().await.expect("shutdown");

    let settled = harness.recorder.payloads("agent_turn_settled");
    assert_eq!(settled.len(), 1);
    assert_eq!(settled[0]["turnId"], turn);
    assert_eq!(settled[0]["status"], "ok");
    assert_close(&settled[0]["costUsd"], 0.02);
    let texts: Vec<Value> = harness
        .recorder
        .payloads("agent_block")
        .into_iter()
        .map(|block| block["content"]["text"].clone())
        .collect();
    assert_eq!(texts, [json!("SWARM answer.")]);
}

/// On a CLI without `command_lifecycle` frames the turn starts with its
/// `system/init`.
#[tokio::test]
async fn a_cli_without_lifecycle_frames_starts_the_turn_on_init() {
    let harness = Harness::new();
    let session = harness.spawn("no_lifecycle.mjs").await;
    let turn = send(session.as_ref(), "hi").await;
    harness.recorder.wait_for("agent_turn_settled", 1).await;
    session.shutdown().await.expect("shutdown");

    assert_eq!(settled_for(&harness.recorder, &turn)[0]["status"], "ok");
    assert_eq!(harness.recorder.count("agent_block"), 1);
    assert_eq!(
        harness.recorder.payloads("agent_block")[0]["content"]["text"],
        "Binary search halves the search space each step."
    );
}

/// A lifecycle frame that closes the live turn without a `result`
/// settles it as an error: `completed` as "Turn Ended Without A Result",
/// `cancelled` as "Turn Cancelled".
#[tokio::test]
async fn a_lifecycle_close_without_a_result_settles_the_turn() {
    for (scenario, want) in [
        ("lifecycle_closes_turn.mjs", TURN_ENDED_WITHOUT_RESULT),
        ("lifecycle_cancels_turn.mjs", TURN_CANCELLED),
    ] {
        let harness = Harness::new();
        let session = harness.spawn(scenario).await;
        let turn = send(session.as_ref(), "hi").await;
        harness.recorder.wait_for("agent_turn_settled", 1).await;
        session.shutdown().await.expect("shutdown");

        let settled = settled_for(&harness.recorder, &turn);
        assert_eq!(settled.len(), 1, "{scenario}");
        assert_eq!(settled[0]["status"], "error", "{scenario}");
        assert_eq!(settled[0]["error"], want, "{scenario}");
    }
}

// ── Permissions ──────────────────────────────────────────────────────

/// Runs a denial scenario and returns its single permission report.
async fn denial_report_of(scenario: &str) -> Value {
    let harness = Harness::new();
    let session = harness.spawn(scenario).await;
    send(session.as_ref(), "attempt the gated action").await;
    harness.recorder.wait_for("agent_turn_settled", 1).await;
    session.shutdown().await.expect("shutdown");

    let reports = harness.recorder.payloads("agent_permission_request");
    assert_eq!(
        reports.len(),
        1,
        "a denial reported by both `permission_denied` and `result.permission_denials` surfaces once: {reports:?}"
    );
    let report = reports.into_iter().next().expect("one report");
    assert_eq!(report["suggestedDecision"], "deny");
    assert!(
        report["message"]
            .as_str()
            .is_some_and(|text| !text.is_empty())
    );
    assert!(
        report["input"].is_object(),
        "the refused call's input is reported"
    );
    report
}

#[tokio::test]
async fn permission_mode_denial_is_classified_mode() {
    let report = denial_report_of("permission_denied_mode.mjs").await;
    assert_eq!(report["denialSubclass"], "mode");
    assert_eq!(report["tool"], "Write");
    assert_eq!(report["input"]["content"], "MUTATED-BY-PLAN-MODE");
}

#[tokio::test]
async fn ungranted_write_denial_is_classified_ungranted_write() {
    let report = denial_report_of("permission_denied_ungranted_write.mjs").await;
    assert_eq!(report["denialSubclass"], "ungranted_write");
}

#[tokio::test]
async fn redirection_guard_denial_is_classified_redirection_guard() {
    let report = denial_report_of("permission_denied_redirection_guard.mjs").await;
    assert_eq!(report["denialSubclass"], "redirection_guard");
    assert_eq!(report["requestId"], "toolu_01Krx9FDsr1UA2azVteYasdT");
}

/// A deny-rule refusal that only `result.permission_denials` records
/// still surfaces, with the tool result's text as its message.
#[tokio::test]
async fn a_denial_known_only_from_the_result_is_still_reported() {
    let report = denial_report_of("glob_deny.mjs").await;
    assert_eq!(report["requestId"], "toolu_01EchoDeniedByGlobRule");
    assert_eq!(report["tool"], "Bash");
    assert_eq!(report["input"]["command"], "echo hi");
    assert_eq!(
        report["message"],
        "Permission to use Bash with command echo hi has been denied."
    );
    assert!(report["denialSubclass"].is_null());
}

/// Waits for the turn's pending `can_use_tool` ask and returns it.
async fn pending_ask(events: &Recorder) -> Value {
    events.wait_for("agent_permission_request", 1).await;
    let ask = events.payloads("agent_permission_request").remove(0);
    assert!(
        ask["suggestedDecision"].is_null(),
        "a pending ask suggests nothing"
    );
    ask
}

/// The tool result the fake CLI wrote for the turn's Write call.
fn write_result(events: &Recorder) -> Value {
    events
        .payloads("agent_tool_result")
        .into_iter()
        .find(|result| {
            result["toolUseId"]
                .as_str()
                .is_some_and(|id| id.starts_with("toolu_01InteractiveWrite"))
        })
        .expect("the Write tool result")
}

#[tokio::test]
async fn interactive_permission_allow_round_trips_to_the_cli() {
    let harness = Harness::new();
    let session = harness.spawn("interactive_permission.mjs").await;
    let turn = send(session.as_ref(), "Write probe1.txt").await;
    let ask = pending_ask(&harness.recorder).await;
    assert_eq!(ask["turnId"], turn);
    assert_eq!(ask["tool"], "Write");
    assert_eq!(
        ask["message"], "probe1.txt",
        "the live Write ask has no decision_reason or title: its description is the message"
    );

    let request_id = ask["requestId"].as_str().expect("request id").to_owned();
    session
        .respond_permission(request_id.clone(), PermissionDecision::Allow)
        .await
        .expect("respond");
    harness.recorder.wait_for("agent_turn_settled", 1).await;

    let echoed: Value = serde_json::from_str(
        write_result(&harness.recorder)["content"]
            .as_str()
            .expect("the echoed answer"),
    )
    .expect("the answer is JSON");
    assert_eq!(echoed["subtype"], "success");
    assert_eq!(echoed["request_id"], request_id);
    assert_eq!(echoed["response"]["behavior"], "allow");
    assert_eq!(echoed["response"]["updatedInput"], ask["input"]);
    assert_eq!(echoed["response"]["toolUseID"], "toolu_01InteractiveWrite1");
    assert_eq!(settled_for(&harness.recorder, &turn)[0]["status"], "ok");

    // A second answer to the same ask is a no-op, not an error.
    session
        .respond_permission(request_id, PermissionDecision::Deny)
        .await
        .expect("a stale answer is a no-op");
    session.shutdown().await.expect("shutdown");
}

#[tokio::test]
async fn interactive_permission_deny_round_trips_to_the_cli() {
    let harness = Harness::new();
    let session = harness.spawn("interactive_permission.mjs").await;
    let turn = send(session.as_ref(), "Write probe1.txt").await;
    let ask = pending_ask(&harness.recorder).await;
    session
        .respond_permission(
            ask["requestId"].as_str().expect("request id").to_owned(),
            PermissionDecision::Deny,
        )
        .await
        .expect("respond");
    harness.recorder.wait_for("agent_turn_settled", 1).await;
    session.shutdown().await.expect("shutdown");

    let result = write_result(&harness.recorder);
    assert_eq!(result["isError"], true);
    assert_eq!(result["content"], DENIED_BY_USER);
    assert_eq!(
        harness.recorder.count("agent_permission_request"),
        1,
        "the result's denial record does not re-report the answered ask"
    );
    assert_eq!(settled_for(&harness.recorder, &turn)[0]["status"], "ok");
}

#[tokio::test]
async fn an_unanswered_ask_is_denied_after_the_decision_timeout() {
    let harness = Harness::new();
    let session = harness.spawn("interactive_permission.mjs").await;
    let turn = send(session.as_ref(), "Write probe1.txt").await;
    pending_ask(&harness.recorder).await;
    harness.recorder.wait_for("agent_turn_settled", 1).await;
    session.shutdown().await.expect("shutdown");

    assert_eq!(
        write_result(&harness.recorder)["content"],
        PERMISSION_TIMED_OUT
    );
    assert_eq!(settled_for(&harness.recorder, &turn)[0]["status"], "ok");
}

/// An ask whose approval card is the input surface is denied at once
/// and reported as a denial, never offered as a one-tap Allow.
#[tokio::test]
async fn an_ask_that_needs_the_cli_dialog_is_denied_and_reported() {
    let harness = Harness::new();
    let session = harness.spawn("user_interaction_ask.mjs").await;
    let turn = send(session.as_ref(), "Set up a test suite.").await;
    harness.recorder.wait_for("agent_turn_settled", 1).await;

    let reports = harness.recorder.payloads("agent_permission_request");
    assert_eq!(reports.len(), 1, "reported once, not again from the result");
    let report = &reports[0];
    assert_eq!(report["turnId"], turn);
    assert_eq!(report["tool"], "AskUserQuestion");
    assert_eq!(report["requestId"], "toolu_01AskUserQuestionCard");
    assert_eq!(report["suggestedDecision"], "deny");
    assert_eq!(report["message"], UNSUPPORTED_REQUEST);
    assert_eq!(
        report["input"]["questions"][0]["header"], "Runner",
        "the report shows what was asked"
    );

    let result = harness
        .recorder
        .payloads("agent_tool_result")
        .into_iter()
        .find(|result| result["toolUseId"] == "toolu_01AskUserQuestionCard")
        .expect("the AskUserQuestion tool result");
    assert_eq!(result["isError"], true);
    assert_eq!(
        result["content"], UNSUPPORTED_REQUEST,
        "the CLI got the deny"
    );
    assert_eq!(settled_for(&harness.recorder, &turn)[0]["status"], "ok");

    session.shutdown().await.expect("shutdown");
}

#[tokio::test]
async fn answering_an_unknown_request_is_a_no_op() {
    let harness = Harness::new();
    let session = harness.spawn("happy_turn.mjs").await;
    session
        .respond_permission("toolu_not_pending".to_owned(), PermissionDecision::Allow)
        .await
        .expect("no-op");
    session.shutdown().await.expect("shutdown");
}

// ── Cancel ───────────────────────────────────────────────────────────

/// `cancel` interrupts in band: the turn settles as cancelled from the
/// CLI's own receipt, and the same process serves the next turn.
#[tokio::test]
async fn cancel_interrupts_the_turn_and_keeps_the_session() {
    let harness = Harness::new();
    let session = harness.spawn("interrupt.mjs").await;
    let first = send(session.as_ref(), "Count to 300 in words.").await;
    tokio::time::timeout(WAIT, session.cancel(first.clone()))
        .await
        .expect("cancel returns")
        .expect("cancel");
    harness.recorder.wait_for("agent_turn_settled", 1).await;

    let settled = settled_for(&harness.recorder, &first);
    assert_eq!(settled.len(), 1);
    assert_eq!(settled[0]["status"], "error");
    assert_eq!(settled[0]["error"], TURN_CANCELLED);
    assert!(
        settled[0]["costUsd"].is_null(),
        "a zeroed running total is no cost"
    );
    assert_eq!(harness.recorder.count("agent_session_exited"), 0);

    let second = send(session.as_ref(), "Still there?").await;
    harness.recorder.wait_for("agent_turn_settled", 2).await;
    let settled = settled_for(&harness.recorder, &second);
    assert_eq!(settled[0]["status"], "ok");
    assert_close(&settled[0]["costUsd"], 0.0121);
    session.shutdown().await.expect("shutdown");
}

/// With no receipt after the interrupt, cancel falls back to a kill,
/// which still settles the turn exactly once (Condition B).
#[tokio::test]
async fn cancel_without_a_receipt_falls_back_to_a_kill() {
    let harness = Harness::new();
    let session = harness.spawn("hang_mid_turn.mjs").await;
    let turn = send(session.as_ref(), "start something long").await;
    tokio::time::timeout(WAIT, session.cancel(turn.clone()))
        .await
        .expect("cancel returns")
        .expect("cancel");

    let settled = settled_for(&harness.recorder, &turn);
    assert_eq!(settled.len(), 1);
    assert_eq!(settled[0]["error"], PROCESS_EXITED_WITHOUT_RECEIPT);
    assert_eq!(harness.recorder.count("agent_session_exited"), 1);
    assert!(matches!(
        session
            .send_turn(TurnInput {
                prompt: "again".to_owned()
            })
            .await,
        Err(AppError::Ipc(_))
    ));
}

#[tokio::test]
async fn cancelling_a_settled_turn_is_a_no_op() {
    let harness = Harness::new();
    let session = harness.spawn("two_turn.mjs").await;
    let first = send(session.as_ref(), "ONE").await;
    harness.recorder.wait_for("agent_turn_settled", 1).await;
    session.cancel(first).await.expect("no-op cancel");
    session
        .cancel("never-sent".to_owned())
        .await
        .expect("no-op cancel");

    send(session.as_ref(), "TWO").await;
    harness.recorder.wait_for("agent_turn_settled", 2).await;
    assert!(
        harness
            .recorder
            .payloads("agent_turn_settled")
            .iter()
            .all(|settled| settled["status"] == "ok")
    );
    session.shutdown().await.expect("shutdown");
}

// ── Teardown (Condition B) ───────────────────────────────────────────

#[tokio::test]
async fn shutdown_mid_turn_synthesizes_exactly_one_settlement() {
    let harness = Harness::new();
    let session = harness.spawn("hang_mid_turn.mjs").await;
    let turn = send(session.as_ref(), "start something long").await;
    harness.recorder.wait_for("agent_turn_delta", 1).await;

    let summary = session.shutdown().await.expect("shutdown");
    assert_ne!(summary.exit_code, Some(0), "a busy session is killed");
    #[cfg(unix)]
    assert_eq!(summary.signal.as_deref(), Some("SIGKILL"));

    let settled = settled_for(&harness.recorder, &turn);
    assert_eq!(settled.len(), 1);
    assert_eq!(settled[0]["status"], "error");
    assert_eq!(settled[0]["error"], PROCESS_EXITED_WITHOUT_RECEIPT);
    assert_eq!(harness.recorder.count("agent_session_exited"), 1);
}

#[tokio::test]
async fn a_framer_error_settles_the_turn_and_tears_the_session_down() {
    let harness = Harness::new();
    let session = harness.spawn("oversized_line.mjs").await;
    let turn = send(session.as_ref(), "trigger the oversized line").await;
    // No shutdown: the session tears itself down.
    harness.recorder.wait_for("agent_session_exited", 1).await;

    let settled = settled_for(&harness.recorder, &turn);
    assert_eq!(settled.len(), 1);
    assert_eq!(settled[0]["error"], PROCESS_EXITED_WITHOUT_RECEIPT);
}

#[tokio::test]
async fn send_turn_while_busy_is_rejected() {
    let harness = Harness::new();
    let session = harness.spawn("hang_mid_turn.mjs").await;
    send(session.as_ref(), "first").await;
    let second = session
        .send_turn(TurnInput {
            prompt: "second".to_owned(),
        })
        .await;
    assert!(
        matches!(second, Err(AppError::AgentSessionBusy)),
        "{second:?}"
    );
    session.shutdown().await.expect("shutdown");
}

#[tokio::test]
async fn shutdown_is_idempotent() {
    let harness = Harness::new();
    let session = harness.spawn("happy_turn.mjs").await;
    let first = session.shutdown().await.expect("first shutdown");
    let second = session.shutdown().await.expect("second shutdown");
    assert_eq!(first, second);
    assert_eq!(first.exit_code, Some(0));
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(harness.recorder.count("agent_session_exited"), 1);
}

/// CONFIRMED regression: a turn racing teardown is either refused or
/// settled exactly once, never accepted and then forgotten.
#[tokio::test]
async fn send_turn_racing_shutdown_never_loses_a_settlement() {
    for _ in 0..8 {
        let harness = Harness::new();
        let session = harness.spawn("hang_mid_turn.mjs").await;
        let (sent, _) = tokio::join!(
            session.send_turn(TurnInput {
                prompt: "racing".to_owned(),
            }),
            session.shutdown()
        );
        match sent {
            Ok(turn) => assert_eq!(settled_for(&harness.recorder, &turn).len(), 1),
            Err(error) => {
                assert_session_closed(&Err(error));
                assert_eq!(harness.recorder.count("agent_turn_settled"), 0);
            }
        }
        assert_session_closed(
            &session
                .send_turn(TurnInput {
                    prompt: "late".to_owned(),
                })
                .await,
        );
    }
}

/// `send_turn` was refused because teardown had claimed the session —
/// the `closing` flag, not a write that failed on a closed stdin (which
/// fails with a different message).
fn assert_session_closed(sent: &Result<TurnId, AppError>) {
    assert!(
        matches!(sent, Err(AppError::Ipc(message)) if message == SESSION_CLOSED),
        "{sent:?}"
    );
}

/// CONFIRMED regression, the exact window: teardown has claimed the turn
/// slot and the child but not yet closed stdin. A `send_turn` there must
/// be refused; without the `closing` flag its write would still succeed
/// and the turn would be accepted with nothing left to settle it.
#[tokio::test]
async fn send_turn_is_refused_once_teardown_has_claimed_the_session() {
    let harness = Harness::new();
    let session = harness
        .adapter("hang_mid_turn.mjs")
        .spawn_session(harness.spec())
        .await
        .expect("spawn");
    // Teardown's claim, frozen before its `stdin.close()`.
    session.shared.state.lock().closing = true;
    assert_session_closed(
        &session
            .send_turn(TurnInput {
                prompt: "late".to_owned(),
            })
            .await,
    );
    assert!(
        session.shared.state.lock().turn.is_none(),
        "nothing was claimed"
    );
    session.shutdown().await.expect("shutdown");
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(harness.recorder.count("agent_turn_settled"), 0);
}

/// CONFIRMED regression, through the real teardown: a `send_turn` that
/// runs while `shutdown` is under way is refused as closed, and nothing
/// settles.
#[tokio::test]
async fn send_turn_during_shutdown_is_refused_as_closed() {
    let harness = Harness::new();
    let session = harness
        .adapter("hang_mid_turn.mjs")
        .spawn_session(harness.spec())
        .await
        .expect("spawn");
    let (exit, sent) = tokio::time::timeout(WAIT, async {
        tokio::join!(session.shutdown(), async {
            // `shutdown` is polled first and starts the teardown task;
            // wait until that task has claimed the session.
            while !session.shared.state.lock().closing {
                tokio::task::yield_now().await;
            }
            session
                .send_turn(TurnInput {
                    prompt: "mid-teardown".to_owned(),
                })
                .await
        })
    })
    .await
    .expect("shutdown and send_turn both return");
    exit.expect("shutdown");
    assert_session_closed(&sent);
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(harness.recorder.count("agent_turn_settled"), 0);
}

#[tokio::test]
async fn await_turn_completion_resolves_on_settlement_and_on_teardown() {
    let harness = Harness::new();
    let session = harness.spawn("happy_turn.mjs").await;
    let turn = send(session.as_ref(), "hi").await;
    tokio::time::timeout(WAIT, session.await_turn_completion(turn.clone()))
        .await
        .expect("resolves once the turn settles")
        .expect("ok");
    harness.recorder.wait_for("agent_turn_settled", 1).await;
    assert_eq!(settled_for(&harness.recorder, &turn).len(), 1);
    session.shutdown().await.expect("shutdown");

    let harness = Harness::new();
    let session = harness.spawn("hang_mid_turn.mjs").await;
    let turn = send(session.as_ref(), "start something long").await;
    assert!(
        tokio::time::timeout(
            Duration::from_millis(300),
            session.await_turn_completion(turn.clone())
        )
        .await
        .is_err(),
        "a turn still in flight keeps the future pending"
    );
    let (waited, _) = tokio::join!(
        tokio::time::timeout(WAIT, session.await_turn_completion(turn)),
        session.shutdown()
    );
    waited.expect("resolves on teardown").expect("ok");
    tokio::time::timeout(WAIT, session.await_turn_completion("never-sent".to_owned()))
        .await
        .expect("an unknown turn after teardown resolves at once")
        .expect("ok");
}

// ── Spawn failures ───────────────────────────────────────────────────

/// CONFIRMED regression: a failed spawn kills and reaps its child.
#[tokio::test]
async fn a_handshake_that_never_answers_fails_the_spawn_and_reaps_the_child() {
    let harness = Harness::new();
    let spec = harness.spec();
    let pid_file = std::env::temp_dir().join(format!("swarm-fake-claude-{}.pid", spec.worker_id));
    let started = Instant::now();
    let error = harness
        .try_spawn("handshake_silent.mjs", spec)
        .await
        .err()
        .expect("spawn fails");
    assert!(
        started.elapsed() < HANDSHAKE_TIMEOUT + Duration::from_secs(5),
        "bounded by the handshake timeout"
    );
    assert!(
        error
            .to_string()
            .contains("Did Not Answer The Session Handshake"),
        "{error}"
    );
    let pid = std::fs::read_to_string(&pid_file).expect("the fake wrote its pid");
    std::fs::remove_file(&pid_file).ok();
    #[cfg(target_os = "linux")]
    assert!(
        !std::path::Path::new(&format!("/proc/{}", pid.trim())).exists(),
        "pid {pid} was killed and reaped (not even a zombie)"
    );
    #[cfg(not(target_os = "linux"))]
    let _ = pid;
    assert_eq!(harness.recorder.count("agent_session_started"), 0);
}

#[tokio::test]
async fn a_rejected_handshake_fails_the_spawn() {
    let harness = Harness::new();
    let error = harness
        .try_spawn("handshake_rejected.mjs", harness.spec())
        .await
        .err()
        .expect("spawn fails");
    assert!(error.to_string().contains("initialize refused"), "{error}");
}

/// An `initialize` success the adapter cannot read fails the spawn (and
/// the probe) instead of defaulting past the permission-mode check.
#[tokio::test]
async fn an_unreadable_handshake_answer_fails_the_spawn_and_the_probe() {
    let harness = Harness::new();
    let error = harness
        .try_spawn("handshake_unreadable.mjs", harness.spec())
        .await
        .err()
        .expect("spawn fails");
    assert!(
        error
            .to_string()
            .contains("Claude Code Rejected The Session Handshake: Unreadable Initialize Response"),
        "{error}"
    );
    assert_eq!(harness.recorder.count("agent_session_started"), 0);

    let report = probe("handshake_unreadable.mjs").await;
    assert!(!report.available);
    assert!(
        report
            .detail
            .as_deref()
            .is_some_and(|detail| detail.starts_with("Claude Code CLI Rejected The Probe")),
        "{report:?}"
    );
}

#[tokio::test]
async fn resuming_an_unknown_session_fails_the_spawn_with_the_cli_error() {
    let harness = Harness::new();
    let spec = AgentSpawnSpec {
        resume: Some("0f5e2c9a-missing".to_owned()),
        ..harness.spec()
    };
    let error = harness
        .try_spawn("resume_missing.mjs", spec)
        .await
        .err()
        .expect("spawn fails");
    assert!(
        error
            .to_string()
            .contains("No conversation found with session ID: 0f5e2c9a-missing"),
        "{error}"
    );
}

#[tokio::test]
async fn a_permission_mode_the_tier_never_requests_fails_the_spawn_closed() {
    let harness = Harness::new();
    let error = harness
        .try_spawn("mode_mismatch.mjs", harness.spec())
        .await
        .err()
        .expect("spawn fails");
    assert!(matches!(error, AppError::PermissionDenied(_)), "{error:?}");
}

#[tokio::test]
async fn an_unknown_trust_tier_fails_the_spawn_before_any_process_starts() {
    let harness = Harness::new();
    let spec = AgentSpawnSpec {
        permission_mode: Some("bypassPermissions".to_owned()),
        ..harness.spec()
    };
    let error = ClaudeCodeAdapter::with_test_binary(
        harness.sink.clone(),
        "definitely-not-a-real-binary-xyz",
        Vec::new(),
    )
    .spawn(spec)
    .await
    .err()
    .expect("spawn fails");
    assert!(matches!(error, AppError::PermissionDenied(_)), "{error:?}");
}

// ── Probe ────────────────────────────────────────────────────────────

async fn probe(scenario: &str) -> ProbeReport {
    Harness::new()
        .adapter(scenario)
        .probe()
        .await
        .expect("probe never errors")
}

#[tokio::test]
async fn probe_reports_version_and_sign_in_through_the_control_protocol() {
    let report = probe("happy_turn.mjs").await;
    assert!(report.available);
    assert_eq!(report.version.as_deref(), Some("2.1.281"));
    let detail = report.detail.expect("detail");
    assert_eq!(detail, "Signed In (Claude Max)");
    assert!(!detail.contains('@'), "the account email never surfaces");
}

#[tokio::test]
async fn probe_reports_a_signed_out_cli_as_unavailable() {
    let report = probe("probe_signed_out.mjs").await;
    assert!(!report.available);
    assert_eq!(
        report.detail.as_deref(),
        Some("Claude Code CLI Not Signed In")
    );
}

#[tokio::test]
async fn probe_reports_an_outdated_cli_as_unavailable() {
    let report = probe("probe_outdated.mjs").await;
    assert!(!report.available);
    assert_eq!(report.version.as_deref(), Some("2.1.232"));
    assert_eq!(
        report.detail.as_deref(),
        Some("Claude Code 2.1.259 Or Newer Required")
    );
}

#[tokio::test]
async fn probe_reports_a_missing_binary_as_unavailable() {
    let report = ClaudeCodeAdapter::with_test_binary(
        Harness::new().sink.clone(),
        "definitely-not-a-real-claude-binary-xyz",
        Vec::new(),
    )
    .probe()
    .await
    .expect("probe never errors");
    assert!(!report.available);
    assert!(
        report
            .detail
            .is_some_and(|detail| detail.starts_with("Claude Code CLI Not Found On PATH"))
    );
}

// ── Argv (Conditions A and C) ────────────────────────────────────────

const TIERS: [ClaudeCodeTrustTier; 3] = [
    ClaudeCodeTrustTier::Restricted,
    ClaudeCodeTrustTier::Standard,
    ClaudeCodeTrustTier::WriteEnabled,
];

fn value_of<'a>(argv: &'a [String], flag: &str) -> Option<&'a str> {
    argv.iter()
        .position(|arg| arg == flag)
        .map(|at| argv[at + 1].as_str())
}

#[test]
fn settings_are_inline_json_with_the_tier_deny_list_never_a_path() {
    for tier in TIERS {
        for resume in [None, Some("some-session-key")] {
            let argv = build_claude_flags(Uuid::new_v4(), "sonnet", tier, resume);
            let settings = value_of(&argv, "--settings").expect("--settings is always passed");
            assert!(settings.starts_with('{'), "{settings}");
            assert!(
                !settings.contains(".claude") && !settings.contains('/'),
                "never a path: {settings}"
            );
            let parsed: Value = serde_json::from_str(settings).expect("valid JSON");
            assert_eq!(parsed["permissions"]["deny"], json!(deny_list(tier)));
        }
    }
}

#[test]
fn bypass_permissions_is_unconstructible() {
    for tier in TIERS {
        for resume in [None, Some("some-session-key")] {
            let argv = build_claude_flags(Uuid::new_v4(), "sonnet", tier, resume);
            assert!(
                !argv.iter().any(|arg| arg.contains("bypassPermissions")
                    || arg.contains("dangerously-skip-permissions")),
                "{tier:?}: {argv:?}"
            );
        }
    }
    for raw in [
        "bypassPermissions",
        "manual",
        "acceptEdits",
        "dontAsk",
        "plan",
        "auto",
        "",
        "Standard",
    ] {
        assert!(parse_trust_tier(Some(raw)).is_err(), "{raw:?} is rejected");
    }
    assert_eq!(
        parse_trust_tier(None).expect("default"),
        ClaudeCodeTrustTier::Standard
    );
}

#[test]
fn argv_routes_prompts_to_the_host_and_restricts_only_the_restricted_tier() {
    let worker = Uuid::new_v4();
    for tier in TIERS {
        let argv = build_claude_flags(worker, "haiku", tier, None);
        assert_eq!(value_of(&argv, "--permission-prompt-tool"), Some("stdio"));
        assert_eq!(value_of(&argv, "--permission-prompts"), Some("host"));
        assert_eq!(value_of(&argv, "--setting-sources"), Some("project"));
        assert_eq!(value_of(&argv, "--input-format"), Some("stream-json"));
        assert_eq!(value_of(&argv, "--model"), Some("haiku"));
        assert!(argv.iter().any(|arg| arg == "--strict-mcp-config"));
        assert_eq!(
            argv.iter().any(|arg| arg == "--restricted"),
            tier == ClaudeCodeTrustTier::Restricted
        );
        assert_eq!(
            value_of(&argv, "--permission-mode"),
            Some(permission_mode_flag(tier)),
            "every tier pins its mode, so project settings cannot pick one"
        );
        assert_eq!(
            value_of(&argv, "--session-id"),
            Some(worker.to_string().as_str())
        );
        assert_eq!(value_of(&argv, "--resume"), None);
    }
    let resumed = build_claude_flags(worker, "sonnet", ClaudeCodeTrustTier::Standard, Some("k"));
    assert_eq!(value_of(&resumed, "--resume"), Some("k"));
    assert_eq!(value_of(&resumed, "--session-id"), None);
}

#[test]
fn the_restricted_tier_never_accepts_a_mode_that_asks() {
    assert_eq!(
        accepted_permission_modes(ClaudeCodeTrustTier::Restricted),
        ["dontAsk"]
    );
    for tier in TIERS {
        assert!(!accepted_permission_modes(tier).contains(&"bypassPermissions"));
    }
}

/// The fences themselves, pinned by value: the other argv tests compare
/// `permission_mode_flag` and `deny_list` with their own output.
#[test]
fn every_trust_tier_pins_its_literal_mode_and_deny_list() {
    use ClaudeCodeTrustTier::{Restricted, Standard, WriteEnabled};
    assert_eq!(permission_mode_flag(Restricted), "dontAsk");
    assert_eq!(permission_mode_flag(Standard), "manual");
    assert_eq!(permission_mode_flag(WriteEnabled), "acceptEdits");
    assert_eq!(accepted_permission_modes(Standard), ["default", "manual"]);
    assert_eq!(accepted_permission_modes(WriteEnabled), ["acceptEdits"]);
    assert_eq!(
        deny_list(Restricted),
        ["Bash", "Write", "Edit", "NotebookEdit"]
    );
    let destructive = [
        "Bash(rm -rf*)",
        "Bash(git push --force*)",
        "Bash(git push -f*)",
        "Bash(git reset --hard*)",
        "Bash(sudo*)",
    ];
    assert_eq!(deny_list(Standard), destructive);
    assert_eq!(deny_list(WriteEnabled), destructive);
}

/// Every tier spawns: the fake CLI reports the permission mode it was
/// started with, and the handshake accepts that mode for each tier.
#[tokio::test]
async fn every_tier_spawns() {
    let harness = Harness::new();
    for tier in ["restricted", "standard", "write_enabled"] {
        let spec = AgentSpawnSpec {
            permission_mode: Some(tier.to_owned()),
            ..harness.spec()
        };
        let session = harness.try_spawn("happy_turn.mjs", spec).await.expect(tier);
        session.shutdown().await.expect("shutdown");
    }
}

#[test]
fn capabilities_are_honest() {
    let capabilities = claude_code_capabilities();
    assert!(capabilities.partial_deltas);
    assert!(capabilities.resume);
    assert!(capabilities.native_cost);
    assert_eq!(capabilities.cancel_granularity, CancelGranularity::Graceful);
    assert!(!capabilities.interrupt_midturn);
    assert!(capabilities.worktree_aware);
    assert!(capabilities.interactive_permissions);
    for mode in &capabilities.permission_modes {
        assert!(
            parse_trust_tier(Some(mode)).is_ok(),
            "{mode:?} is advertised, so a spawn must accept it"
        );
    }
    assert_eq!(
        capabilities.permission_modes,
        ["restricted", "standard", "write_enabled"]
    );
    let adapter = ClaudeCodeAdapter::new(Harness::new().sink.clone());
    assert_eq!(adapter.provider(), ProviderId::ClaudeCode);
    assert_eq!(adapter.capabilities(), capabilities);
}

// ── Wire and pure helpers ────────────────────────────────────────────

#[test]
fn user_turns_are_sdk_shaped_and_carry_the_turn_id() {
    let line = wire::user_turn("hello world", "turn-1");
    assert!(line.ends_with('\n') && !line.trim_end().contains('\n'));
    let frame: Value = serde_json::from_str(&line).expect("JSON");
    assert_eq!(frame["type"], "user");
    assert_eq!(frame["uuid"], "turn-1");
    assert_eq!(frame["parent_tool_use_id"], Value::Null);
    assert_eq!(frame["message"]["role"], "user");
    assert_eq!(
        frame["message"]["content"],
        json!([{ "type": "text", "text": "hello world" }])
    );
}

#[test]
fn control_frames_have_the_protocol_shape() {
    let frame: Value = serde_json::from_str(&wire::interrupt_request("r1")).expect("JSON");
    assert_eq!(
        frame,
        json!({
            "type": "control_request",
            "request_id": "r1",
            "request": { "subtype": "interrupt", "cancel_queued": true },
        })
    );
    let frame: Value =
        serde_json::from_str(&wire::permission_deny("r2", "toolu_1", "No", true)).expect("JSON");
    assert_eq!(
        frame["response"],
        json!({
            "subtype": "success",
            "request_id": "r2",
            "response": { "behavior": "deny", "message": "No", "interrupt": true, "toolUseID": "toolu_1" },
        })
    );
    let frame: Value =
        serde_json::from_str(&wire::control_error("r3", UNSUPPORTED_REQUEST)).expect("JSON");
    assert_eq!(frame["response"]["subtype"], "error");
}

#[test]
fn unknown_frames_and_fields_parse_as_other() {
    for line in [
        r#"{"type":"rate_limit_event","rate_limit_info":{}}"#,
        r#"{"type":"keep_alive"}"#,
        r#"{"type":"system","subtype":"hook_progress","extra":1}"#,
        r#"{"type":"stream_event","event":{"type":"ping"}}"#,
    ] {
        let frame: Inbound = serde_json::from_str(line).expect(line);
        assert!(
            matches!(
                frame,
                Inbound::Other
                    | Inbound::System(System::Other)
                    | Inbound::StreamEvent(StreamEventLine {
                        event: StreamEvent::Other,
                        ..
                    })
            ),
            "{line}: {frame:?}"
        );
    }
}

#[test]
fn an_out_of_range_block_index_fails_the_line_instead_of_wrapping() {
    let line =
        r#"{"type":"stream_event","event":{"type":"content_block_stop","index":4294967296}}"#;
    assert!(serde_json::from_str::<Inbound>(line).is_err());
}

#[test]
fn only_readable_deltas_carry_text() {
    let delta = |raw: Value| serde_json::from_value::<Delta>(raw).expect("delta");
    assert_eq!(
        delta(json!({ "type": "text_delta", "text": "hi" })).into_text(),
        Some("hi".to_owned())
    );
    assert_eq!(
        delta(json!({ "type": "thinking_delta", "thinking": "", "estimated_tokens": 50 }))
            .into_text(),
        None
    );
    assert_eq!(
        delta(json!({ "type": "signature_delta", "signature": "abc" })).into_text(),
        None
    );
    assert_eq!(
        delta(json!({ "type": "input_json_delta", "partial_json": "{\"a\":" })).into_text(),
        Some("{\"a\":".to_owned())
    );
}

fn result_line(raw: Value) -> ResultLine {
    serde_json::from_value(raw).expect("result line")
}

#[test]
fn settlement_errors_cover_every_failure_shape() {
    assert_eq!(
        settlement_error(
            &result_line(json!({ "subtype": "success", "is_error": false })),
            false
        ),
        None
    );
    assert_eq!(
        settlement_error(
            &result_line(json!({
                "subtype": "error_max_turns",
                "is_error": true,
                "errors": ["Reached maximum number of turns (2)"],
                "terminal_reason": "max_turns",
            })),
            false
        )
        .as_deref(),
        Some("Reached maximum number of turns (2) (Terminal Reason: max_turns)")
    );
    assert_eq!(
        settlement_error(
            &result_line(json!({ "subtype": "error_max_budget_usd", "is_error": true })),
            false
        )
        .as_deref(),
        Some("Budget Exhausted")
    );
    assert_eq!(
        settlement_error(
            &result_line(json!({
                "subtype": "error_during_execution",
                "is_error": true,
                "errors": ["[ede_diagnostic] result_type=user"],
                "terminal_reason": "aborted_streaming",
            })),
            false
        )
        .as_deref(),
        Some(TURN_CANCELLED)
    );
    assert_eq!(
        settlement_error(
            &result_line(json!({ "subtype": "error_during_execution", "is_error": true })),
            true
        )
        .as_deref(),
        Some(TURN_CANCELLED)
    );
}

#[test]
fn running_cost_totals_become_per_turn_costs() {
    let mut baseline = Some(0.0);
    assert_eq!(advance_cost(&mut baseline, Some(0.0)), None);
    assert_eq!(advance_cost(&mut baseline, Some(0.5)), Some(0.5));
    assert_eq!(advance_cost(&mut baseline, Some(0.75)), Some(0.25));
    // A zeroed total (an aborted turn) says nothing and moves nothing.
    assert_eq!(advance_cost(&mut baseline, Some(0.0)), None);
    assert_eq!(advance_cost(&mut baseline, Some(1.0)), Some(0.25));
    // A lower non-zero total is a reset: the new total is this turn's.
    assert_eq!(advance_cost(&mut baseline, Some(0.1)), Some(0.1));
    assert_eq!(advance_cost(&mut baseline, None), None);

    let mut unknown = None;
    assert_eq!(advance_cost(&mut unknown, Some(3.0)), None);
    assert_eq!(advance_cost(&mut unknown, Some(3.5)), Some(0.5));
}

#[test]
fn sign_in_reads_the_initialize_account() {
    let account = |raw: Value| serde_json::from_value::<AccountInfo>(raw).expect("account");
    assert_eq!(
        account(json!({ "tokenSource": "none", "apiProvider": "firstParty" })).sign_in(),
        SignIn::SignedOut
    );
    assert_eq!(
        account(json!({ "email": "a@b.c", "subscriptionType": "Claude Pro", "apiProvider": "firstParty" }))
            .sign_in(),
        SignIn::Account {
            plan: Some("Claude Pro".to_owned())
        }
    );
    assert_eq!(
        account(json!({ "apiKeySource": "ANTHROPIC_API_KEY", "tokenSource": "none" })).sign_in(),
        SignIn::ApiKey {
            source: "ANTHROPIC_API_KEY".to_owned()
        }
    );
    assert_eq!(
        account(json!({ "tokenSource": "CLAUDE_CODE_OAUTH_TOKEN" })).sign_in(),
        SignIn::Token {
            source: "CLAUDE_CODE_OAUTH_TOKEN".to_owned()
        }
    );
    assert_eq!(
        account(json!({ "apiProvider": "bedrock" })).sign_in(),
        SignIn::Provider {
            name: "bedrock".to_owned()
        }
    );
    assert_eq!(provider_label("bedrock"), "Amazon Bedrock");
}

#[test]
fn model_aliases_resolve_through_the_initialize_answer() {
    let init: InitializeResponse = serde_json::from_value(json!({
        "models": [{ "value": "sonnet", "resolvedModel": "claude-sonnet-5" }, { "value": "custom" }],
    }))
    .expect("initialize answer");
    assert_eq!(init.resolve_model("sonnet"), "claude-sonnet-5");
    assert_eq!(init.resolve_model("custom"), "custom");
    assert_eq!(init.resolve_model("claude-opus-5-5"), "claude-opus-5-5");
}

#[test]
fn an_odd_model_entry_drops_only_itself_but_a_mistyped_field_the_adapter_acts_on_fails() {
    let init: InitializeResponse = serde_json::from_value(json!({
        "models": [{ "displayName": "No Value" }, { "value": "sonnet", "resolvedModel": "claude-sonnet-5" }],
        "current_permission_mode": "default",
    }))
    .expect("initialize answer");
    assert_eq!(init.models.len(), 1);
    assert_eq!(init.resolve_model("sonnet"), "claude-sonnet-5");
    assert_eq!(init.current_permission_mode.as_deref(), Some("default"));

    for unreadable in [
        json!({ "current_permission_mode": 7 }),
        json!({ "account": "signed in" }),
        json!({ "pid": -1 }),
        Value::Null,
    ] {
        assert!(
            serde_json::from_value::<InitializeResponse>(unreadable.clone()).is_err(),
            "{unreadable}"
        );
    }
}

#[test]
fn an_ask_shows_its_reason_else_its_title_else_its_description() {
    let ask = |fields: Value| -> wire::CanUseTool {
        let mut request = json!({ "tool_name": "Write", "tool_use_id": "toolu_1", "input": {} });
        request
            .as_object_mut()
            .expect("an object")
            .extend(fields.as_object().expect("an object").clone());
        serde_json::from_value(request).expect("a can_use_tool request")
    };
    let all = json!({
        "decision_reason": "\u{1b}[1mSafety check\u{1b}[0m",
        "title": "Claude wants to write probe.txt",
        "description": "probe.txt",
    });
    assert_eq!(ask(all).message().as_deref(), Some("Safety check"));
    assert_eq!(
        ask(json!({ "decision_reason": " ", "title": "Claude wants to write probe.txt", "description": "probe.txt" }))
            .message()
            .as_deref(),
        Some("Claude wants to write probe.txt")
    );
    assert_eq!(
        ask(json!({ "description": "probe.txt" }))
            .message()
            .as_deref(),
        Some("probe.txt")
    );
    assert_eq!(ask(json!({})).message(), None);
    assert!(!ask(json!({})).requires_user_interaction);
    assert!(ask(json!({ "requires_user_interaction": true })).requires_user_interaction);
}

#[test]
fn helpers_parse_versions_classify_denials_and_strip_ansi() {
    assert_eq!(parse_version("2.1.281 (Claude Code)"), Some((2, 1, 281)));
    assert_eq!(parse_version("2.1"), None);
    assert_eq!(parse_version("x.y.z"), None);
    assert!(MIN_CLI_VERSION <= (2, 1, 280));

    assert_eq!(
        classify_denial(Some("mode"), "anything").as_deref(),
        Some("mode")
    );
    assert_eq!(
        classify_denial(None, "..., but you haven't granted it yet.").as_deref(),
        Some("ungranted_write")
    );
    assert_eq!(
        classify_denial(None, "Output redirection to 'x' was blocked.").as_deref(),
        Some("redirection_guard")
    );
    assert_eq!(classify_denial(Some("rule"), "Denied."), None);

    assert_eq!(
        strip_ansi("\u{1b}[1mBold\u{1b}[0m \u{1b}]8;;https://x\u{7}link\u{1b}]8;;\u{7}"),
        "Bold link"
    );
}

// ── Real CLI (opt-in) ────────────────────────────────────────────────

/// Protocol-drift canary against the installed `claude`: probe, then a
/// session handshake per trust tier and an idle shutdown. No prompt is
/// sent, so no API call is made. Run with `cargo test -- --ignored`.
#[tokio::test]
#[ignore = "drives the installed claude CLI"]
async fn real_cli_probe_and_idle_sessions_speak_the_current_protocol() {
    let harness = Harness::new();
    let adapter = ClaudeCodeAdapter::new(harness.sink.clone());
    let report = adapter.probe().await.expect("probe never errors");
    assert!(report.available, "{report:?}");
    for tier in ["restricted", "standard", "write_enabled"] {
        let spec = AgentSpawnSpec {
            permission_mode: Some(tier.to_owned()),
            model: Some("haiku".to_owned()),
            ..harness.spec()
        };
        let session = adapter.spawn(spec).await.expect("handshake");
        let summary = session.shutdown().await.expect("shutdown");
        assert_eq!(summary.exit_code, Some(0), "{tier}: idle exit on stdin EOF");
    }
    assert_eq!(harness.recorder.count("agent_session_started"), 3);
    assert_eq!(harness.recorder.count("agent_turn_settled"), 0);
}
