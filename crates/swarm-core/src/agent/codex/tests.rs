//! Tests for the Codex adapter.
//!
//! Wire-level tests run the adapter against
//! `tests/fixtures/codex/fake_codex_app_server.mjs`, a scripted stand-in
//! for `codex app-server` that follows the codex-cli 0.156.1 schema
//! (including its `Not initialized` rule) and records every message the
//! adapter writes. Events go through a real in-memory
//! [`OrchestrationEngine`] and are captured in emission order.

use std::assert_matches;
use std::path::{Path, PathBuf};

use super::*;
use crate::orchestration::{EventLog, OrchestrationEngine};

/// The thread id every fixture's `thread/start` answers with.
const THREAD: &str = "019a7c00-0000-7000-8000-000000000001";
/// Upper bound for anything a test waits on (node startup included).
const WAIT: Duration = Duration::from_secs(30);

fn fixture(name: &str) -> String {
    format!("{}/tests/fixtures/codex/{name}", env!("CARGO_MANIFEST_DIR"))
}

/// Generous bounds for the wire tests; individual tests shorten the one
/// they exercise.
fn test_timeouts() -> Timeouts {
    Timeouts {
        handshake: WAIT,
        turn_ack: WAIT,
        request: WAIT,
        interrupt_settle: WAIT,
        graceful_exit: Duration::from_secs(5),
        probe: WAIT,
    }
}

/// A per-test temporary directory (the session's `cwd` and the fake's
/// record file), removed on drop.
struct Scratch(PathBuf);

impl Scratch {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!("swarm-codex-test-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("create the scratch dir");
        Self(dir)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// The agent worker an event is about, if it is an `agent_*` event.
fn worker_of(event: &SwarmEvent) -> Option<Uuid> {
    Some(match event {
        SwarmEvent::AgentSessionStarted(p) => p.worker_id,
        SwarmEvent::AgentTurnDelta(p) => p.worker_id,
        SwarmEvent::AgentBlock(p) => p.worker_id,
        SwarmEvent::AgentToolCall(p) => p.worker_id,
        SwarmEvent::AgentToolResult(p) => p.worker_id,
        SwarmEvent::AgentPermissionRequest(p) => p.worker_id,
        SwarmEvent::AgentTurnSettled(p) => p.worker_id,
        SwarmEvent::AgentSessionExited(p) => p.worker_id,
        _ => return None,
    })
}

struct Harness {
    _engine: OrchestrationEngine,
    sink: EventSink,
    events: watch::Receiver<Vec<SwarmEvent>>,
    adapter: CodexAdapter,
    worker_id: Uuid,
    scratch: Scratch,
}

impl Harness {
    /// A harness whose adapter runs the fake with `script`.
    fn new(script: &str) -> Self {
        Self::with_timeouts(script, test_timeouts())
    }

    fn with_timeouts(script: &str, timeouts: Timeouts) -> Self {
        let scratch = Scratch::new();
        let record = scratch.path().join("wire.jsonl");
        Self::build(
            vec![
                fixture("fake_codex_app_server.mjs"),
                "--script".to_string(),
                fixture(script),
                "--record".to_string(),
                record.display().to_string(),
            ],
            timeouts,
            scratch,
        )
    }

    fn build(prefix_args: Vec<String>, timeouts: Timeouts, scratch: Scratch) -> Self {
        let (events_tx, events) = watch::channel(Vec::new());
        let log = EventLog::open_in_memory().expect("open an in-memory event log");
        let engine = OrchestrationEngine::start(log, None, move |envelope| {
            events_tx.send_modify(|events| events.push(envelope.event.clone()));
        });
        let sink = engine.sink();
        let adapter = CodexAdapter::with_test_binary(sink.clone(), "node", prefix_args, timeouts);
        Self {
            _engine: engine,
            sink,
            events,
            adapter,
            worker_id: Uuid::new_v4(),
            scratch,
        }
    }

    fn spec(
        &self,
        tier: Option<&str>,
        model: Option<&str>,
        resume: Option<&str>,
    ) -> AgentSpawnSpec {
        AgentSpawnSpec {
            worker_id: self.worker_id,
            cwd: self.scratch.path().display().to_string(),
            model: model.map(str::to_owned),
            resume: resume.map(str::to_owned),
            permission_mode: tier.map(str::to_owned),
        }
    }

    async fn spawn(&self) -> Box<dyn AgentSession> {
        self.adapter
            .spawn(self.spec(None, None, None))
            .await
            .expect("spawn against the fake app-server")
    }

    /// Every entry the fake recorded: the adapter's messages plus the
    /// fake's own `{"fake": ...}` markers.
    fn record(&self) -> Vec<Value> {
        std::fs::read_to_string(self.scratch.path().join("wire.jsonl"))
            .unwrap_or_default()
            .lines()
            .map(|line| serde_json::from_str(line).expect("recorded lines are JSON"))
            .collect()
    }

    /// Only what the adapter wrote, in order.
    fn wire(&self) -> Vec<Value> {
        self.record()
            .into_iter()
            .filter(|entry| entry.get("fake").is_none())
            .collect()
    }

    /// The adapter's answer to the server request `id`, if any.
    fn answer_to(&self, id: &Value) -> Option<Value> {
        self.wire()
            .into_iter()
            .find(|message| message.get("method").is_none() && message.get("id") == Some(id))
    }

    /// Waits until every event emitted so far has reached the capture.
    async fn flush(&self) {
        let barrier = self.sink.emit_awaiting_seq(
            SwarmEvent::AgentSessionExited(AgentSessionExitedPayload {
                worker_id: Uuid::nil(),
                exit_code: None,
                signal: None,
            }),
            Provenance::default(),
        );
        tokio::time::timeout(WAIT, barrier)
            .await
            .expect("the event writer acknowledges the barrier")
            .expect("the event writer is alive");
    }

    /// This worker's events so far, in emission order.
    fn events(&self) -> Vec<SwarmEvent> {
        self.events
            .borrow()
            .iter()
            .filter(|event| worker_of(event) == Some(self.worker_id))
            .cloned()
            .collect()
    }

    /// Waits until this worker's events satisfy `done`, then returns them.
    async fn wait_until(
        &self,
        what: &str,
        done: impl Fn(&[SwarmEvent]) -> bool,
    ) -> Vec<SwarmEvent> {
        let worker_id = self.worker_id;
        let mut events = self.events.clone();
        let reached = tokio::time::timeout(
            WAIT,
            events.wait_for(|all| {
                let own: Vec<SwarmEvent> = all
                    .iter()
                    .filter(|event| worker_of(event) == Some(worker_id))
                    .cloned()
                    .collect();
                done(&own)
            }),
        )
        .await;
        assert!(
            reached.is_ok(),
            "timed out waiting for {what}; got {:#?}",
            self.events()
        );
        self.events()
    }
}

fn settlements(events: &[SwarmEvent]) -> Vec<&AgentTurnSettledPayload> {
    events
        .iter()
        .filter_map(|event| match event {
            SwarmEvent::AgentTurnSettled(p) => Some(p),
            _ => None,
        })
        .collect()
}

fn permission_requests(events: &[SwarmEvent]) -> Vec<&AgentPermissionRequestPayload> {
    events
        .iter()
        .filter_map(|event| match event {
            SwarmEvent::AgentPermissionRequest(p) => Some(p),
            _ => None,
        })
        .collect()
}

fn position(events: &[SwarmEvent], matches: impl Fn(&SwarmEvent) -> bool) -> usize {
    events
        .iter()
        .position(matches)
        .unwrap_or_else(|| panic!("event not found in {events:#?}"))
}

fn is_exit(event: &SwarmEvent) -> bool {
    matches!(event, SwarmEvent::AgentSessionExited(_))
}

/// The `agent_turn_delta` contract the chat relies on: every streamed
/// `(turn_id, block_index)` is closed by an `agent_block` at the same
/// index after its last delta — otherwise the UI keeps a live bubble
/// forever.
fn assert_every_stream_is_closed(events: &[SwarmEvent]) {
    let mut open: HashMap<(String, u32), usize> = HashMap::new();
    for (at, event) in events.iter().enumerate() {
        match event {
            SwarmEvent::AgentTurnDelta(p) => {
                open.insert((p.turn_id.clone(), p.block_index), at);
            }
            SwarmEvent::AgentBlock(p) => {
                open.remove(&(p.turn_id.clone(), p.block_index));
            }
            _ => {}
        }
    }
    assert!(
        open.is_empty(),
        "streams never closed by an agent_block: {open:?}"
    );
}

// ── Pure helpers ─────────────────────────────────────────────────────

#[test]
fn trust_tiers_map_to_approval_policy_and_sandbox() {
    let cases = [
        (None, AskForApproval::Untrusted, SandboxMode::WorkspaceWrite),
        (
            Some("standard"),
            AskForApproval::Untrusted,
            SandboxMode::WorkspaceWrite,
        ),
        (
            Some("restricted"),
            AskForApproval::Untrusted,
            SandboxMode::ReadOnly,
        ),
        (
            Some("write_enabled"),
            AskForApproval::OnRequest,
            SandboxMode::WorkspaceWrite,
        ),
    ];
    for (token, approval, sandbox) in cases {
        let tier = parse_trust_tier(token).expect("a SWARM tier token");
        assert_eq!(tier.policy(), (approval, sandbox), "{token:?}");
    }
}

#[test]
fn unknown_trust_tiers_are_refused() {
    for token in [
        "never",
        "danger-full-access",
        "bypassPermissions",
        "on-failure",
        "",
    ] {
        let error = parse_trust_tier(Some(token)).expect_err(token);
        assert_matches!(error, AppError::PermissionDenied(_), "{token:?}");
    }
}

#[test]
fn thread_start_serializes_the_sandbox_key_and_omits_a_missing_model() {
    let params = serde_json::to_value(ThreadStartParams {
        cwd: "/work",
        model: None,
        approval_policy: AskForApproval::Untrusted,
        sandbox: SandboxMode::ReadOnly,
    })
    .expect("serialize");
    assert_eq!(
        params,
        json!({ "cwd": "/work", "approvalPolicy": "untrusted", "sandbox": "read-only" })
    );
}

#[test]
fn turn_start_input_is_one_text_item_with_empty_text_elements() {
    let params = serde_json::to_value(TurnStartParams {
        thread_id: THREAD,
        input: [UserInput::Text {
            text: "hi",
            text_elements: [],
        }],
    })
    .expect("serialize");
    assert_eq!(
        params,
        json!({
            "threadId": THREAD,
            "input": [{ "type": "text", "text": "hi", "text_elements": [] }],
        })
    );
}

#[test]
fn claude_model_names_and_blanks_fall_back_to_the_codex_default() {
    for model in [
        None,
        Some(""),
        Some("  "),
        Some("sonnet"),
        Some("Opus"),
        Some("haiku"),
        Some("fable"),
        Some("Mythos"),
        Some("claude-fable-5"),
    ] {
        assert_eq!(requested_model(model), None, "{model:?}");
    }
    assert_eq!(requested_model(Some(" gpt-5.5 ")), Some("gpt-5.5"));
}

fn opened(sandbox: &str, approval: Value) -> ThreadOpened {
    serde_json::from_value(json!({
        "thread": { "id": THREAD },
        "model": "gpt-6-astra",
        "approvalPolicy": approval,
        "sandbox": { "type": sandbox },
    }))
    .expect("a thread/start response")
}

#[test]
fn applied_policy_may_be_stricter_but_never_looser() {
    use AskForApproval::{OnRequest, Untrusted};
    use SandboxMode::{ReadOnly, WorkspaceWrite};
    let ok = [
        ("readOnly", json!("untrusted"), Untrusted, ReadOnly),
        (
            "workspaceWrite",
            json!("untrusted"),
            Untrusted,
            WorkspaceWrite,
        ),
        ("readOnly", json!("untrusted"), Untrusted, WorkspaceWrite),
        (
            "workspaceWrite",
            json!("on-request"),
            OnRequest,
            WorkspaceWrite,
        ),
        (
            "workspaceWrite",
            json!("untrusted"),
            OnRequest,
            WorkspaceWrite,
        ),
    ];
    for (sandbox, approval, asked_approval, asked_sandbox) in ok {
        verify_effective_policy(
            &opened(sandbox, approval.clone()),
            asked_approval,
            asked_sandbox,
        )
        .unwrap_or_else(|e| panic!("{sandbox} / {approval}: {e}"));
    }
    let refused = [
        ("dangerFullAccess", json!("untrusted"), Untrusted, ReadOnly),
        ("workspaceWrite", json!("untrusted"), Untrusted, ReadOnly),
        (
            "externalSandbox",
            json!("untrusted"),
            Untrusted,
            WorkspaceWrite,
        ),
        ("readOnly", json!("never"), Untrusted, ReadOnly),
        ("readOnly", json!("on-request"), Untrusted, ReadOnly),
        (
            "workspaceWrite",
            json!({ "granular": {} }),
            OnRequest,
            WorkspaceWrite,
        ),
        (
            "dangerFullAccess",
            json!("untrusted"),
            Untrusted,
            WorkspaceWrite,
        ),
        ("workspaceWrite", json!("never"), OnRequest, WorkspaceWrite),
    ];
    for (sandbox, approval, asked_approval, asked_sandbox) in refused {
        let error = verify_effective_policy(
            &opened(sandbox, approval.clone()),
            asked_approval,
            asked_sandbox,
        )
        .expect_err(sandbox);
        assert_matches!(
            error,
            AppError::PermissionDenied(_),
            "{sandbox} / {approval}"
        );
    }
}

#[test]
fn numeric_and_string_request_ids_stay_distinct() {
    let numeric: Incoming = serde_json::from_str(r#"{"id":5,"method":"m","params":{}}"#).unwrap();
    let string: Incoming = serde_json::from_str(r#"{"id":"5","method":"m","params":{}}"#).unwrap();
    assert_eq!(numeric.id, Some(RequestId::Integer(5)));
    assert_eq!(string.id, Some(RequestId::String("5".to_string())));
    assert_ne!(
        permission_id(&RequestId::Integer(5)),
        permission_id(&RequestId::String("5".to_string()))
    );
    assert_eq!(
        serde_json::to_value(RequestId::String("5".to_string())).unwrap(),
        json!("5")
    );
}

#[test]
fn approval_answers_follow_the_decision_and_request_kind() {
    let answer = |kind, decision| {
        let line = approval_answer(
            PendingApproval {
                id: RequestId::Integer(1),
                kind,
            },
            decision,
        )
        .expect("encode");
        serde_json::from_str::<Value>(&line).expect("one JSON line")["result"].clone()
    };
    assert_eq!(
        answer(ApprovalKind::Command, PermissionDecision::Allow),
        json!({ "decision": "accept" })
    );
    assert_eq!(
        answer(ApprovalKind::Command, PermissionDecision::Deny),
        json!({ "decision": "decline" })
    );
    assert_eq!(
        answer(ApprovalKind::FileChange, PermissionDecision::Allow),
        json!({ "decision": "accept" }),
        "one Allow is never a session-long grant"
    );
    assert_eq!(
        answer(ApprovalKind::FileChange, PermissionDecision::Deny),
        json!({ "decision": "decline" })
    );
    let requested = json!({ "network": { "enabled": true }, "fileSystem": null });
    assert_eq!(
        answer(
            ApprovalKind::Permissions {
                requested: requested.clone()
            },
            PermissionDecision::Allow
        ),
        json!({ "permissions": { "network": { "enabled": true } }, "scope": "turn" })
    );
    assert_eq!(
        answer(
            ApprovalKind::Permissions { requested },
            PermissionDecision::Deny
        ),
        json!({ "permissions": {}, "scope": "turn" })
    );
}

#[test]
fn pathext_resolution_finds_the_npm_cmd_shim() {
    let scratch = Scratch::new();
    std::fs::write(scratch.path().join("codex.CMD"), "@echo off\n").expect("write the shim");
    let path = std::env::join_paths([scratch.path()]).expect("a PATH value");
    let pathext = Some(".COM;.EXE;.BAT;.CMD");
    assert_eq!(
        resolve_with_pathext("codex", Some(&path), pathext),
        Some(scratch.path().join("codex.CMD"))
    );
    // A name that already has an extension or a directory is left alone.
    assert_eq!(
        resolve_with_pathext("codex.exe", Some(&path), pathext),
        None
    );
    assert_eq!(
        resolve_with_pathext("bin/codex", Some(&path), pathext),
        None
    );
    assert_eq!(resolve_with_pathext("claude", Some(&path), pathext), None);
    assert_eq!(resolve_with_pathext("codex", None, pathext), None);
}

#[test]
fn capabilities_promise_resume_graceful_cancel_and_interactive_approvals() {
    let capabilities = codex_capabilities();
    assert!(capabilities.resume);
    assert_eq!(capabilities.cancel_granularity, CancelGranularity::Graceful);
    assert!(capabilities.interactive_permissions);
    assert!(!capabilities.interrupt_midturn);
    assert!(!capabilities.native_cost);
    assert_eq!(
        capabilities.permission_modes,
        ["restricted", "standard", "write_enabled"]
    );
}

#[test]
fn every_codex_child_turns_off_the_current_directory_exe_lookup() {
    assert_eq!(
        child_env().get(NO_CWD_EXE_LOOKUP_ENV).map(String::as_str),
        Some("1")
    );
}

#[cfg(unix)]
#[test]
fn signal_names_are_reported_on_unix() {
    use std::os::unix::process::ExitStatusExt;
    assert_eq!(
        signal_name(&std::process::ExitStatus::from_raw(9)),
        Some("SIGKILL".to_string())
    );
    assert_eq!(signal_name(&std::process::ExitStatus::from_raw(0)), None);
}

// ── Handshake ────────────────────────────────────────────────────────

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn handshake_is_initialize_then_initialized_then_thread_start_with_the_tier_sandbox() {
    let tiers = [
        (Some("restricted"), "untrusted", "read-only"),
        (Some("standard"), "untrusted", "workspace-write"),
        (None, "untrusted", "workspace-write"),
        (Some("write_enabled"), "on-request", "workspace-write"),
    ];
    for (tier, approval, sandbox) in tiers {
        let h = Harness::new("handshake.script");
        let session = h
            .adapter
            .spawn(h.spec(tier, None, None))
            .await
            .expect("spawn");
        assert_eq!(session.session_key(), THREAD);
        let exit = session.shutdown().await.expect("shutdown");
        assert_eq!(
            exit,
            ExitSummary {
                exit_code: Some(0),
                signal: None
            },
            "stdin EOF ends the server"
        );

        let wire = h.wire();
        assert_eq!(wire.len(), 3, "{wire:#?}");
        assert_eq!(wire[0]["method"], "initialize");
        assert_eq!(wire[0]["id"], 1);
        assert_eq!(
            wire[0]["params"]["clientInfo"],
            json!({ "name": "swarm", "title": "Swarm Orchestrator", "version": env!("CARGO_PKG_VERSION") })
        );
        assert_eq!(wire[0]["params"]["capabilities"]["experimentalApi"], false);
        assert_eq!(wire[1], json!({ "method": "initialized" }));
        assert_eq!(wire[2]["method"], "thread/start");
        let params = &wire[2]["params"];
        assert_eq!(params["sandbox"], sandbox, "{tier:?}");
        assert_eq!(params["approvalPolicy"], approval, "{tier:?}");
        assert_eq!(params["cwd"], h.scratch.path().display().to_string());
        assert!(
            params.get("sandboxPolicy").is_none(),
            "the ignored legacy key must not be sent"
        );
        assert!(params.get("model").is_none(), "no model => Codex's default");
        assert_eq!(h.record().last(), Some(&json!({ "fake": "stdin-eof" })));

        h.flush().await;
        let events = h.events();
        assert_eq!(events.len(), 2, "{events:#?}");
        let SwarmEvent::AgentSessionStarted(started) = &events[0] else {
            panic!("expected agent_session_started first: {events:#?}");
        };
        assert_eq!(started.session_key, THREAD);
        assert_eq!(started.provider, ProviderId::Codex);
        assert_eq!(started.model, "gpt-6-astra", "the model the server reports");
        assert_eq!(started.capabilities, codex_capabilities());
        assert!(is_exit(&events[1]));
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_codex_model_is_forwarded_and_a_claude_alias_is_not() {
    for (model, expected) in [(Some("gpt-5.5"), Some("gpt-5.5")), (Some("sonnet"), None)] {
        let h = Harness::new("handshake.script");
        let session = h
            .adapter
            .spawn(h.spec(None, model, None))
            .await
            .expect("spawn");
        session.shutdown().await.expect("shutdown");
        let params = h.wire()[2]["params"].clone();
        assert_eq!(
            params.get("model").and_then(Value::as_str),
            expected,
            "{model:?}"
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn resume_opens_the_thread_with_thread_resume() {
    let h = Harness::new("resume.script");
    let old_thread = "019a7c00-0000-7000-8000-000000000777";
    let session = h
        .adapter
        .spawn(h.spec(Some("restricted"), None, Some(old_thread)))
        .await
        .expect("resume");
    assert_eq!(session.session_key(), old_thread);
    session.shutdown().await.expect("shutdown");
    let wire = h.wire();
    assert_eq!(wire[2]["method"], "thread/resume");
    let params = &wire[2]["params"];
    assert_eq!(params["threadId"], old_thread);
    assert_eq!(params["sandbox"], "read-only");
    assert_eq!(params["approvalPolicy"], "untrusted");
    assert_eq!(params["excludeTurns"], true);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_rejected_thread_start_fails_the_spawn_with_the_server_message() {
    let h = Harness::new("thread_start_not_initialized.script");
    let error = h
        .adapter
        .spawn(h.spec(None, None, None))
        .await
        .err()
        .expect("spawn must fail");
    let AppError::Ai(message) = error else {
        panic!("expected AppError::Ai, got {error:?}");
    };
    assert!(
        message.contains("Not initialized") && message.contains("-32600"),
        "{message}"
    );
    h.flush().await;
    assert!(
        h.events().is_empty(),
        "an unannounced session emits nothing"
    );
    assert_eq!(
        h.record().last(),
        Some(&json!({ "fake": "stdin-eof" })),
        "the child was shut down"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_looser_applied_sandbox_refuses_the_session() {
    let h = Harness::new("sandbox_escalated.script");
    let error = h
        .adapter
        .spawn(h.spec(Some("restricted"), None, None))
        .await
        .err()
        .expect("spawn must fail");
    let AppError::PermissionDenied(message) = error else {
        panic!("expected AppError::PermissionDenied, got {error:?}");
    };
    assert!(message.contains("dangerFullAccess"), "{message}");
    h.flush().await;
    assert!(h.events().is_empty());
    assert_eq!(h.record().last(), Some(&json!({ "fake": "stdin-eof" })));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_handshake_timeout_kills_and_reaps_the_child() {
    let h = Harness::with_timeouts(
        "handshake_hang.script",
        Timeouts {
            handshake: Duration::from_millis(1500),
            graceful_exit: Duration::from_millis(200),
            ..test_timeouts()
        },
    );
    let error = h
        .adapter
        .spawn(h.spec(None, None, None))
        .await
        .err()
        .expect("spawn must time out");
    assert_matches!(&error, AppError::Ai(m) if m.contains("handshake"));
    let pid = h.record()[0]["pid"]
        .as_u64()
        .expect("the fake records its pid");
    #[cfg(target_os = "linux")]
    assert!(
        !Path::new(&format!("/proc/{pid}")).exists(),
        "the hung child {pid} must be killed and reaped before spawn returns"
    );
    let _ = pid;
    h.flush().await;
    assert!(h.events().is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_unknown_trust_tier_never_starts_a_process() {
    let h = Harness::new("handshake.script");
    let error = h
        .adapter
        .spawn(h.spec(Some("never"), None, None))
        .await
        .err()
        .expect("refused");
    assert_matches!(error, AppError::PermissionDenied(_));
    assert!(h.record().is_empty(), "the fake never ran");
}

// ── Turns ────────────────────────────────────────────────────────────

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_turn_streams_deltas_emits_blocks_and_settles_ok_with_usage() {
    let h = Harness::new("happy_turn.script");
    let session = h.spawn().await;
    let turn = session
        .send_turn(TurnInput {
            prompt: "hello".to_string(),
        })
        .await
        .expect("turn/start acknowledged");
    assert_eq!(turn, "019a7c00-0000-7000-8000-0000000000a1");
    tokio::time::timeout(WAIT, session.await_turn_completion(turn.clone()))
        .await
        .expect("the turn settles")
        .expect("await");

    let turn_start = h.wire()[3].clone();
    assert_eq!(turn_start["method"], "turn/start");
    assert_eq!(
        turn_start["params"],
        json!({ "threadId": THREAD, "input": [{ "type": "text", "text": "hello", "text_elements": [] }] })
    );

    h.flush().await;
    let events = h.events();
    let deltas: Vec<&AgentTurnDeltaPayload> = events
        .iter()
        .filter_map(|e| match e {
            SwarmEvent::AgentTurnDelta(p) => Some(p),
            _ => None,
        })
        .collect();
    let thinking: Vec<_> = deltas.iter().filter(|d| d.kind == "thinking").collect();
    assert_eq!(thinking.len(), 2);
    assert_eq!(thinking[0].text, "Read the task.");
    assert_eq!(
        thinking[1].text, "\n\nAnswer briefly.",
        "a new summary part starts a paragraph"
    );
    let text: Vec<_> = deltas.iter().filter(|d| d.kind == "text").collect();
    assert_eq!(
        text.iter().map(|d| d.text.as_str()).collect::<String>(),
        "Hello from Codex."
    );
    assert_ne!(thinking[0].block_index, text[0].block_index);
    assert!(deltas.iter().all(|d| d.turn_id == turn));

    let blocks: Vec<&AgentBlockPayload> = events
        .iter()
        .filter_map(|e| match e {
            SwarmEvent::AgentBlock(p) => Some(p),
            _ => None,
        })
        .collect();
    assert_eq!(
        blocks.len(),
        2,
        "user echo, other-thread items and unmapped notifications are dropped: {blocks:#?}"
    );
    assert_eq!(blocks[0].kind, "thinking");
    assert_eq!(
        blocks[0].content,
        json!({ "thinking": "Read the task.\n\nAnswer briefly." })
    );
    assert_eq!(blocks[0].block_index, thinking[0].block_index);
    assert_eq!(blocks[1].kind, "text");
    assert_eq!(blocks[1].content, json!({ "text": "Hello from Codex." }));
    assert_eq!(blocks[1].block_index, text[0].block_index);
    assert_every_stream_is_closed(&events);

    let settled = settlements(&events);
    assert_eq!(settled.len(), 1);
    assert_eq!(settled[0].turn_id, turn);
    assert_eq!(settled[0].status, AgentTurnStatus::Ok);
    assert_eq!(settled[0].error, None);
    assert_eq!(settled[0].duration_ms, 1834);
    assert_eq!(settled[0].cost_usd, None);
    assert_eq!(
        settled[0]
            .usage
            .as_ref()
            .and_then(|u| u.get("modelContextWindow")),
        Some(&json!(400000))
    );
    session.shutdown().await.expect("shutdown");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn tool_items_become_tool_calls_and_results_with_honest_error_flags() {
    let h = Harness::new("tool_turn.script");
    let session = h.spawn().await;
    let turn = session
        .send_turn(TurnInput {
            prompt: "work".to_string(),
        })
        .await
        .expect("turn");
    session.await_turn_completion(turn).await.expect("await");
    h.flush().await;
    let events = h.events();

    let calls: Vec<(String, String, Value)> = events
        .iter()
        .filter_map(|e| match e {
            SwarmEvent::AgentToolCall(p) => {
                Some((p.tool_use_id.clone(), p.name.clone(), p.input.clone()))
            }
            _ => None,
        })
        .collect();
    assert_eq!(
        calls,
        [
            (
                "cmd-1".to_string(),
                "commandExecution".to_string(),
                json!({ "command": "ls -la", "cwd": "/work" })
            ),
            (
                "mcp-1".to_string(),
                "docs.search".to_string(),
                json!({ "q": "tauri" })
            ),
            (
                "patch-1".to_string(),
                "fileChange".to_string(),
                json!({ "changes": [{ "path": "/work/a.txt", "kind": { "type": "add" }, "diff": "+a\n" }] })
            ),
            (
                "cmd-2".to_string(),
                "commandExecution".to_string(),
                json!({ "command": "false", "cwd": "/work" })
            ),
            (
                "mcp-2".to_string(),
                "docs.search".to_string(),
                json!({ "q": "xterm" })
            ),
            (
                "dyn-1".to_string(),
                "lookup".to_string(),
                json!({ "key": "a" })
            ),
        ]
    );
    let results: Vec<(String, bool)> = events
        .iter()
        .filter_map(|e| match e {
            SwarmEvent::AgentToolResult(p) => Some((p.tool_use_id.clone(), p.is_error)),
            _ => None,
        })
        .collect();
    assert_eq!(
        results,
        [
            ("cmd-1".to_string(), false),
            ("mcp-1".to_string(), true),
            ("patch-1".to_string(), true),
            ("cmd-2".to_string(), true),
            ("mcp-2".to_string(), true),
            ("dyn-1".to_string(), true),
        ]
    );
    // Command output streams are not forwarded (nothing would close
    // them); the output arrives whole in the tool result instead.
    assert!(
        !events
            .iter()
            .any(|e| matches!(e, SwarmEvent::AgentTurnDelta(_))),
        "no delta stream for command output: {events:#?}"
    );
    assert_every_stream_is_closed(&events);
    let command_result = events
        .iter()
        .find_map(|e| match e {
            SwarmEvent::AgentToolResult(p) if p.tool_use_id == "cmd-1" => Some(p),
            _ => None,
        })
        .expect("command result");
    assert_eq!(command_result.content["aggregatedOutput"], "total 0\n");
    assert_eq!(settlements(&events)[0].status, AgentTurnStatus::Ok);
    session.shutdown().await.expect("shutdown");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn failed_turns_settle_error_with_the_server_message() {
    let h = Harness::new("failed_turns.script");
    let session = h.spawn().await;
    for prompt in ["one", "two", "three"] {
        let turn = session
            .send_turn(TurnInput {
                prompt: prompt.to_string(),
            })
            .await
            .expect("turn");
        session.await_turn_completion(turn).await.expect("await");
    }
    h.flush().await;
    let events = h.events();
    let settled = settlements(&events);
    assert_eq!(
        settled.len(),
        3,
        "a retrying error notification settles nothing"
    );
    assert_eq!(settled[0].status, AgentTurnStatus::Error);
    assert_eq!(
        settled[0].error.as_deref(),
        Some("Usage limit reached (resets at 18:00)")
    );
    assert_eq!(settled[1].status, AgentTurnStatus::Error);
    assert_eq!(settled[1].error.as_deref(), Some("stream disconnected"));
    assert_eq!(settled[2].status, AgentTurnStatus::Error);
    assert_eq!(
        settled[2].error.as_deref(),
        Some(TURN_FAILED),
        "a retrying error notification is not the turn's error"
    );
    session.shutdown().await.expect("shutdown");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn raw_reasoning_and_unmapped_items_become_blocks() {
    let h = Harness::new("reasoning_raw.script");
    let session = h.spawn().await;
    let turn = session
        .send_turn(TurnInput {
            prompt: "think".to_string(),
        })
        .await
        .expect("turn");
    session.await_turn_completion(turn).await.expect("await");
    h.flush().await;
    let events = h.events();

    let deltas: Vec<&AgentTurnDeltaPayload> = events
        .iter()
        .filter_map(|e| match e {
            SwarmEvent::AgentTurnDelta(p) => Some(p),
            _ => None,
        })
        .collect();
    assert_eq!(
        deltas
            .iter()
            .map(|d| (d.kind.as_str(), d.text.as_str()))
            .collect::<Vec<_>>(),
        [
            ("thinking", "a"),
            (
                "thinking", "

b"
            ),
            ("thinking", "partial")
        ],
        "a new contentIndex starts a paragraph"
    );
    assert_eq!(deltas[0].block_index, deltas[1].block_index);
    assert_ne!(deltas[0].block_index, deltas[2].block_index);

    let blocks: Vec<&AgentBlockPayload> = events
        .iter()
        .filter_map(|e| match e {
            SwarmEvent::AgentBlock(p) => Some(p),
            _ => None,
        })
        .collect();
    assert_eq!(blocks.len(), 3, "{blocks:#?}");
    assert_eq!(blocks[0].kind, "thinking");
    assert_eq!(
        blocks[0].content,
        json!({ "thinking": "a

b" })
    );
    assert_eq!(blocks[0].block_index, deltas[0].block_index);
    assert_eq!(blocks[1].kind, "thinking");
    assert_eq!(
        blocks[1].content,
        json!({ "thinking": "" }),
        "a streamed item that completes empty still closes its stream"
    );
    assert_eq!(blocks[1].block_index, deltas[2].block_index);
    assert_eq!(blocks[2].kind, "webSearch");
    assert_eq!(
        blocks[2].content,
        json!({ "type": "webSearch", "id": "ws-1", "query": "tauri", "action": null })
    );
    assert_every_stream_is_closed(&events);
    session.shutdown().await.expect("shutdown");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancel_interrupts_the_turn_and_keeps_the_thread() {
    let h = Harness::new("interrupt.script");
    let session = h.spawn().await;
    let first = session
        .send_turn(TurnInput {
            prompt: "long".to_string(),
        })
        .await
        .expect("turn");
    session.cancel(first.clone()).await.expect("cancel");
    // Settled already: a second cancel is a no-op, not a second interrupt.
    session.cancel(first.clone()).await.expect("repeat cancel");
    let second = session
        .send_turn(TurnInput {
            prompt: "next".to_string(),
        })
        .await
        .expect("the thread lives on");
    session
        .await_turn_completion(second.clone())
        .await
        .expect("await");

    let wire = h.wire();
    let interrupts: Vec<&Value> = wire
        .iter()
        .filter(|m| m["method"] == "turn/interrupt")
        .collect();
    assert_eq!(interrupts.len(), 1);
    assert_eq!(
        interrupts[0]["params"],
        json!({ "threadId": THREAD, "turnId": first })
    );

    h.flush().await;
    let events = h.events();
    let settled = settlements(&events);
    assert_eq!(settled.len(), 2);
    assert_eq!(
        (settled[0].turn_id.as_str(), settled[0].status),
        (first.as_str(), AgentTurnStatus::Error)
    );
    assert_eq!(settled[0].error.as_deref(), Some(TURN_INTERRUPTED));
    assert_eq!(
        (settled[1].turn_id.as_str(), settled[1].status),
        (second.as_str(), AgentTurnStatus::Ok)
    );
    assert!(
        !events.iter().any(is_exit),
        "cancel must not end the session"
    );
    session.shutdown().await.expect("shutdown");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_refused_interrupt_racing_a_finishing_turn_keeps_the_session() {
    let h = Harness::new("interrupt_refused.script");
    let session = h.spawn().await;
    let turn = session
        .send_turn(TurnInput {
            prompt: "short".to_string(),
        })
        .await
        .expect("turn");
    session.cancel(turn.clone()).await.expect("cancel");
    h.flush().await;
    let events = h.events();
    let settled = settlements(&events);
    assert_eq!(settled.len(), 1);
    assert_eq!(
        (settled[0].turn_id.as_str(), settled[0].status),
        (turn.as_str(), AgentTurnStatus::Ok),
        "the turn finished on its own"
    );
    assert!(
        !events.iter().any(is_exit),
        "a refused interrupt must not end the session"
    );
    session.shutdown().await.expect("shutdown");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_completion_that_overtakes_its_ack_settles_exactly_once() {
    let h = Harness::new("completion_before_ack.script");
    let session = h.spawn().await;
    let first = session
        .send_turn(TurnInput {
            prompt: "a".to_string(),
        })
        .await
        .expect("turn");
    assert_eq!(first, "019a7c00-0000-7000-8000-0000000000a9");
    tokio::time::timeout(WAIT, session.await_turn_completion(first.clone()))
        .await
        .expect("already settled")
        .expect("await");
    let second = session
        .send_turn(TurnInput {
            prompt: "b".to_string(),
        })
        .await
        .expect("the slot is free");
    session
        .await_turn_completion(second.clone())
        .await
        .expect("await");
    h.flush().await;
    let events = h.events();
    let settled: Vec<&str> = settlements(&events)
        .iter()
        .map(|s| s.turn_id.as_str())
        .collect();
    assert_eq!(settled, [first.as_str(), second.as_str()]);
    session.shutdown().await.expect("shutdown");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_completion_before_turn_started_and_the_ack_settles_from_starting() {
    let h = Harness::new("completion_before_started.script");
    let session = h.spawn().await;
    let first = session
        .send_turn(TurnInput {
            prompt: "a".to_string(),
        })
        .await
        .expect("turn");
    assert_eq!(first, "019a7c00-0000-7000-8000-0000000000d1");
    tokio::time::timeout(WAIT, session.await_turn_completion(first.clone()))
        .await
        .expect("already settled")
        .expect("await");
    let second = session
        .send_turn(TurnInput {
            prompt: "b".to_string(),
        })
        .await
        .expect("the acknowledgement freed the slot");
    session
        .await_turn_completion(second.clone())
        .await
        .expect("await");
    h.flush().await;
    let events = h.events();
    let settled: Vec<(&str, AgentTurnStatus, Option<&str>)> = settlements(&events)
        .iter()
        .map(|s| (s.turn_id.as_str(), s.status, s.error.as_deref()))
        .collect();
    assert_eq!(
        settled,
        [
            (
                first.as_str(),
                AgentTurnStatus::Error,
                Some("Model overloaded")
            ),
            (second.as_str(), AgentTurnStatus::Ok, None),
        ],
        "one settlement per turn; the duplicate completion is ignored"
    );
    session.shutdown().await.expect("shutdown");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_second_turn_while_one_is_running_is_busy() {
    let h = Harness::with_timeouts(
        "turn_ack_hang.script",
        Timeouts {
            graceful_exit: Duration::from_millis(200),
            ..test_timeouts()
        },
    );
    let session = Arc::new(h.spawn().await);
    let first = tokio::spawn({
        let session = Arc::clone(&session);
        async move {
            session
                .send_turn(TurnInput {
                    prompt: "a".to_string(),
                })
                .await
        }
    });
    // Wait until the fake has read the first turn/start.
    let deadline = Instant::now() + WAIT;
    while !h.wire().iter().any(|m| m["method"] == "turn/start") {
        assert!(
            Instant::now() < deadline,
            "turn/start never reached the fake"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let busy = session
        .send_turn(TurnInput {
            prompt: "b".to_string(),
        })
        .await;
    assert_matches!(busy, Err(AppError::AgentSessionBusy));
    session.shutdown().await.expect("shutdown");
    let first = first.await.expect("join");
    assert!(
        first.is_err(),
        "the unacknowledged turn fails once the session closes: {first:?}"
    );
}

// ── Approvals and server requests ────────────────────────────────────

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn approvals_round_trip_on_the_wire_with_type_exact_ids() {
    let h = Harness::new("approvals.script");
    let session = h.spawn().await;
    let turn = session
        .send_turn(TurnInput {
            prompt: "go".to_string(),
        })
        .await
        .expect("turn");

    for (count, request_id, tool) in [
        (1, "7", "commandExecution"),
        (2, "\"7\"", "fileChange"),
        (3, "9", "permissions"),
    ] {
        let events = h
            .wait_until(tool, |events| permission_requests(events).len() >= count)
            .await;
        let requests = permission_requests(&events);
        let request = requests[count - 1];
        assert_eq!(
            (request.request_id.as_str(), request.tool.as_str()),
            (request_id, tool)
        );
        assert_eq!(request.turn_id, turn);
        session
            .respond_permission(request.request_id.clone(), PermissionDecision::Allow)
            .await
            .expect("answer written");
    }
    session.await_turn_completion(turn).await.expect("await");

    // Withdrawn by serverRequest/resolved, and never issued: both no-ops.
    session
        .respond_permission("10".to_string(), PermissionDecision::Allow)
        .await
        .expect("withdrawn");
    session
        .respond_permission("999".to_string(), PermissionDecision::Deny)
        .await
        .expect("unknown");
    session.shutdown().await.expect("shutdown");
    session
        .respond_permission("7".to_string(), PermissionDecision::Allow)
        .await
        .expect("after shutdown");

    assert_eq!(
        h.answer_to(&json!(7)).unwrap()["result"],
        json!({ "decision": "accept" })
    );
    assert_eq!(
        h.answer_to(&json!("7")).unwrap()["result"],
        json!({ "decision": "accept" }),
        "a patch asking for a grantRoot still gets a one-shot accept"
    );
    assert_eq!(
        h.answer_to(&json!(9)).unwrap()["result"],
        json!({ "permissions": { "network": { "enabled": true } }, "scope": "turn" })
    );
    assert_eq!(
        h.answer_to(&json!(10)),
        None,
        "a withdrawn request is not answered"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn every_unsupported_server_request_gets_method_not_found() {
    let h = Harness::new("unknown_server_requests.script");
    let session = h.spawn().await;
    let turn = session
        .send_turn(TurnInput {
            prompt: "go".to_string(),
        })
        .await
        .expect("turn");
    // The fake blocks on each answer: the turn completes only if all
    // three were answered.
    tokio::time::timeout(WAIT, session.await_turn_completion(turn))
        .await
        .expect("every server request was answered")
        .expect("await");
    for id in [json!(42), json!("elicit-1"), json!(43)] {
        let answer = h
            .answer_to(&id)
            .unwrap_or_else(|| panic!("no answer to {id}"));
        assert_eq!(answer["error"]["code"], METHOD_NOT_FOUND, "{answer}");
        assert!(answer.get("result").is_none());
    }
    h.flush().await;
    assert!(permission_requests(&h.events()).is_empty());
    session.shutdown().await.expect("shutdown");
}

// ── Teardown ─────────────────────────────────────────────────────────

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_server_death_mid_turn_synthesizes_the_settlement_then_exits() {
    let h = Harness::new("death_mid_turn.script");
    let session = h.spawn().await;
    let turn = session
        .send_turn(TurnInput {
            prompt: "go".to_string(),
        })
        .await
        .expect("turn");
    tokio::time::timeout(WAIT, session.await_turn_completion(turn.clone()))
        .await
        .expect("the death settles the turn")
        .expect("await");
    let events = h
        .wait_until("agent_session_exited", |events| events.iter().any(is_exit))
        .await;
    let settled = settlements(&events);
    assert_eq!(settled.len(), 1);
    assert_eq!(settled[0].turn_id, turn);
    assert_eq!(settled[0].status, AgentTurnStatus::Error);
    assert!(
        settled[0]
            .error
            .as_deref()
            .is_some_and(|e| e.starts_with(PROCESS_EXITED_WITHOUT_RECEIPT))
    );
    let settled_at = position(&events, |e| matches!(e, SwarmEvent::AgentTurnSettled(_)));
    let exited_at = position(&events, is_exit);
    assert!(settled_at < exited_at);
    let SwarmEvent::AgentSessionExited(exited) = &events[exited_at] else {
        unreachable!()
    };
    assert_eq!(exited.exit_code, Some(1));

    let after = session
        .send_turn(TurnInput {
            prompt: "again".to_string(),
        })
        .await;
    assert_matches!(after, Err(AppError::Ipc(_)));
    let exit = session.shutdown().await.expect("shutdown is idempotent");
    assert_eq!(exit.exit_code, Some(1));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_unacknowledged_turn_shuts_the_session_down_and_kills_the_child() {
    let h = Harness::with_timeouts(
        "turn_ack_hang.script",
        Timeouts {
            turn_ack: Duration::from_millis(1500),
            graceful_exit: Duration::from_millis(200),
            ..test_timeouts()
        },
    );
    let session = h.spawn().await;
    let error = session
        .send_turn(TurnInput {
            prompt: "go".to_string(),
        })
        .await
        .expect_err("no acknowledgement");
    assert_matches!(&error, AppError::Ai(m) if m.contains("did not acknowledge"));
    h.flush().await;
    let events = h.events();
    assert!(
        settlements(&events).is_empty(),
        "a turn without an id has nothing to settle"
    );
    let SwarmEvent::AgentSessionExited(exited) = events.last().expect("exit") else {
        panic!("expected agent_session_exited last: {events:#?}");
    };
    #[cfg(unix)]
    assert_eq!(
        (exited.exit_code, exited.signal.as_deref()),
        (None, Some("SIGKILL")),
        "the hung child ignores stdin EOF and is killed"
    );
    let _ = exited;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_oversized_line_tears_the_session_down() {
    let h = Harness::with_timeouts(
        "oversized_line.script",
        Timeouts {
            graceful_exit: Duration::from_millis(200),
            ..test_timeouts()
        },
    );
    let session = h.spawn().await;
    h.wait_until("agent_session_exited", |events| events.iter().any(is_exit))
        .await;
    let after = session
        .send_turn(TurnInput {
            prompt: "go".to_string(),
        })
        .await;
    assert!(after.is_err());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn nothing_is_emitted_once_teardown_began() {
    let h = Harness::with_timeouts(
        "talks_after_eof.script",
        Timeouts {
            graceful_exit: Duration::from_millis(500),
            ..test_timeouts()
        },
    );
    let session = h.spawn().await;
    let turn = session
        .send_turn(TurnInput {
            prompt: "go".to_string(),
        })
        .await
        .expect("turn");
    h.wait_until("the streamed deltas", |events| {
        events
            .iter()
            .filter(|e| matches!(e, SwarmEvent::AgentTurnDelta(_)))
            .count()
            == 50
    })
    .await;
    // Teardown marks the session closing, then closes stdin; the fake
    // answers the EOF with more traffic while it waits to be killed.
    session.shutdown().await.expect("shutdown");
    h.flush().await;
    let record = h.record();
    assert!(
        record.contains(&json!({ "fake": "stdin-eof" })),
        "the fake saw EOF"
    );

    let events = h.events();
    let leaked: Vec<&SwarmEvent> = events
        .iter()
        .filter(|e| {
            let text = serde_json::to_string(e).expect("serialize");
            text.contains("after-eof")
        })
        .collect();
    assert!(
        leaked.is_empty(),
        "emitted after teardown began: {leaked:#?}"
    );
    assert!(permission_requests(&events).is_empty());
    assert_eq!(h.answer_to(&json!(99)), None);
    let settled = settlements(&events);
    assert_eq!(settled.len(), 1, "only the synthesized settlement");
    assert_eq!(settled[0].turn_id, turn);
    assert!(
        settled[0]
            .error
            .as_deref()
            .is_some_and(|e| e.starts_with(PROCESS_EXITED_WITHOUT_RECEIPT))
    );
    assert_eq!(position(&events, is_exit), events.len() - 1);
}

// ── Probe ────────────────────────────────────────────────────────────

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn probe_reports_version_and_sign_in_state() {
    let signed_in = Harness::build(
        vec![fixture("fake_codex_app_server.mjs")],
        test_timeouts(),
        Scratch::new(),
    );
    let report = signed_in.adapter.probe().await.expect("probe");
    assert!(report.available);
    assert_eq!(report.version.as_deref(), Some("codex-cli 0.156.1"));
    assert_eq!(report.detail.as_deref(), Some("Logged in using ChatGPT"));

    let signed_out = Harness::build(
        vec![
            fixture("fake_codex_app_server.mjs"),
            "--logged-out".to_string(),
        ],
        test_timeouts(),
        Scratch::new(),
    );
    let report = signed_out.adapter.probe().await.expect("probe");
    assert!(!report.available);
    assert_eq!(report.version.as_deref(), Some("codex-cli 0.156.1"));
    assert!(
        report
            .detail
            .as_deref()
            .is_some_and(|d| d.contains("Not Signed In")),
        "{report:?}"
    );

    let (events_tx, _events) = watch::channel(Vec::<SwarmEvent>::new());
    let engine = OrchestrationEngine::start(EventLog::open_in_memory().unwrap(), None, move |e| {
        events_tx.send_modify(|events| events.push(e.event.clone()));
    });
    let missing = CodexAdapter::with_test_binary(
        engine.sink(),
        "swarm-no-such-codex-binary",
        Vec::new(),
        test_timeouts(),
    );
    let report = missing.probe().await.expect("probe");
    assert!(!report.available);
    assert!(
        report
            .detail
            .as_deref()
            .is_some_and(|d| d.starts_with("Codex CLI Not Found On PATH")),
        "{report:?}"
    );
}
