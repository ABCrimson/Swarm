//! Unit tests for [`super`].

use std::assert_matches;
use std::mem::DropGuard;
use std::sync::mpsc::{Receiver, RecvTimeoutError, channel};
use std::time::{Duration, Instant};

use tracing_subscriber::fmt::format::FmtSpan;

use super::*;
use crate::events::emitter::WriterMsg;

/// How long a test waits for a real shell to react.
const SHELL_TIMEOUT: Duration = Duration::from_secs(30);

fn test_sink() -> (EventSink, Receiver<WriterMsg>) {
    let (tx, rx) = channel();
    (EventSink::new(tx), rx)
}

/// A handle with no PTY, for state and input tests.
fn make_handle(state: WorkerState) -> WorkerHandle {
    WorkerHandle {
        id: Uuid::new_v4(),
        state,
        name: "test-worker".to_owned(),
        pid: Some(9999),
        started_at: 0,
        pty_writer: None,
        child: None,
        worktree_path: None,
        repo_root: None,
        branch: None,
        base_commit: None,
        last_shipped_seq: None,
        last_shipped_commit: None,
    }
}

/// A `Write` over a shared buffer: a stand-in PTY writer.
struct SharedBuf(Arc<Mutex<Vec<u8>>>);

impl Write for SharedBuf {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.0.lock().extend_from_slice(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn make_handle_with_writer(
    state: WorkerState,
    writer: impl Write + Send + 'static,
) -> WorkerHandle {
    WorkerHandle {
        pty_writer: Some(Arc::new(Mutex::new(Box::new(writer)))),
        ..make_handle(state)
    }
}

fn make_handle_with_pty(state: WorkerState) -> (WorkerHandle, Arc<Mutex<Vec<u8>>>) {
    let buf = Arc::new(Mutex::new(Vec::new()));
    (
        make_handle_with_writer(state, SharedBuf(Arc::clone(&buf))),
        buf,
    )
}

/// The next event on `rx` that is not `worker_output` (a real shell
/// prints its prompt concurrently with everything else).
fn next_event(rx: &Receiver<WriterMsg>) -> WriterMsg {
    let deadline = Instant::now() + SHELL_TIMEOUT;
    loop {
        let msg = rx
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .expect("timed out waiting for an event");
        if !matches!(msg.event, SwarmEvent::WorkerOutput(_)) {
            return msg;
        }
    }
}

/// Every non-output event already queued on `rx`.
fn queued_events(rx: &Receiver<WriterMsg>) -> Vec<SwarmEvent> {
    rx.try_iter()
        .map(|msg| msg.event)
        .filter(|event| !matches!(event, SwarmEvent::WorkerOutput(_)))
        .collect()
}

/// Reads `worker_output` from `rx` until it contains `needle`;
/// panics with everything read on timeout.
fn wait_for_output(rx: &Receiver<WriterMsg>, needle: &str) -> String {
    let deadline = Instant::now() + SHELL_TIMEOUT;
    let mut output = String::new();
    while !output.contains(needle) {
        match rx.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
            Ok(WriterMsg {
                event: SwarmEvent::WorkerOutput(p),
                ..
            }) => output.push_str(&p.data),
            Ok(_) => {}
            Err(RecvTimeoutError::Timeout | RecvTimeoutError::Disconnected) => {
                panic!("never saw {needle:?} in the worker's output: {output:?}")
            }
        }
    }
    output
}

/// Writes `data` to a worker as terminal input.
fn type_into(sink: &EventSink, registry: &WorkerRegistry, id: Uuid, data: &str) {
    do_worker_input(
        sink,
        registry,
        id,
        data.as_bytes(),
        InputSource::Terminal,
        Provenance::default(),
    )
    .expect("the worker accepts input");
}

/// Makes a freshly spawned default shell ready for input: on
/// Windows, answers the pseudoconsole's cursor-position query (see
/// the `pty` module doc), which xterm.js would otherwise answer.
fn attach_headless_terminal(sink: &EventSink, registry: &WorkerRegistry, id: Uuid) {
    if cfg!(windows) {
        type_into(sink, registry, id, "\x1b[1;1R");
    }
}

/// A command line for the default shell that prints `swarm-42-ok`
/// without that text appearing in the echoed input.
const fn marker_command() -> (&'static str, &'static str) {
    if cfg!(windows) {
        ("echo \"swarm-$(40+2)-ok\"\r", "swarm-42-ok")
    } else {
        ("echo swarm-$((40+2))-ok\r", "swarm-42-ok")
    }
}

// ── state transitions ────────────────────────────────────────────

#[test]
fn test_pause_then_resume_transition_and_emit_worker_state() {
    let registry = WorkerRegistry::new();
    let id = registry
        .spawn_worker(make_handle(WorkerState::Running))
        .unwrap();
    let (sink, rx) = test_sink();
    let provenance = Provenance {
        origin_worker: Some(Uuid::new_v4()),
        cause_seq: Some(7),
    };

    do_pause_worker(&sink, &registry, id, provenance.clone()).unwrap();
    assert_eq!(registry.get_worker(&id).unwrap().state, WorkerState::Paused);
    let msg = rx.try_recv().unwrap();
    assert_eq!(msg.provenance.cause_seq, Some(7));
    assert_matches!(
        msg.event,
        SwarmEvent::WorkerState(WorkerStatePayload { worker_id, state: WorkerState::Paused }) if worker_id == id
    );

    do_resume_worker(&sink, &registry, id, Provenance::default()).unwrap();
    assert_eq!(
        registry.get_worker(&id).unwrap().state,
        WorkerState::Running
    );
    assert_matches!(
        rx.try_recv().unwrap().event,
        SwarmEvent::WorkerState(WorkerStatePayload {
            state: WorkerState::Running,
            ..
        })
    );
}

/// Emitting under the registry entry lock keeps event order equal to
/// mutation order: whichever of a pause and a shell exit mutates
/// last also emits last, so the final `worker_state` event always
/// names the worker's final state.
#[test]
fn test_pause_racing_shell_exit_emits_in_mutation_order() {
    let status = ExitStatus::with_exit_code(0);
    for _ in 0..500 {
        let registry = WorkerRegistry::new();
        let id = registry
            .spawn_worker(make_handle(WorkerState::Running))
            .unwrap();
        let (sink, rx) = test_sink();
        let barrier = std::sync::Barrier::new(2);
        std::thread::scope(|s| {
            s.spawn(|| {
                barrier.wait();
                let _ = do_pause_worker(&sink, &registry, id, Provenance::default());
            });
            s.spawn(|| {
                barrier.wait();
                on_shell_exit(&sink, &registry, id, &status);
            });
        });

        let last = rx
            .try_iter()
            .filter_map(|m| match m.event {
                SwarmEvent::WorkerState(p) => Some(p.state),
                _ => None,
            })
            .last()
            .expect("the exit always announces");
        assert_eq!(last, registry.get_worker(&id).unwrap().state);
        assert_eq!(last, WorkerState::Error, "an exit is never overwritten");
    }
}

#[test]
fn test_pause_rejects_a_worker_that_is_not_running() {
    for state in [WorkerState::Paused, WorkerState::Idle, WorkerState::Error] {
        let registry = WorkerRegistry::new();
        let id = registry.spawn_worker(make_handle(state)).unwrap();
        let (sink, rx) = test_sink();

        let err = do_pause_worker(&sink, &registry, id, Provenance::default()).unwrap_err();
        assert_matches!(err, AppError::Ipc(_));
        assert!(err.to_string().contains(&format!("from {state}")), "{err}");
        assert_eq!(registry.get_worker(&id).unwrap().state, state, "unchanged");
        assert!(rx.try_recv().is_err(), "a refused pause emits nothing");
    }
}

#[test]
fn test_resume_rejects_a_worker_that_is_not_paused() {
    for state in [WorkerState::Running, WorkerState::Idle, WorkerState::Error] {
        let registry = WorkerRegistry::new();
        let id = registry.spawn_worker(make_handle(state)).unwrap();
        let (sink, rx) = test_sink();

        let err = do_resume_worker(&sink, &registry, id, Provenance::default()).unwrap_err();
        assert!(err.to_string().contains(&format!("from {state}")), "{err}");
        assert_eq!(registry.get_worker(&id).unwrap().state, state, "unchanged");
        assert!(rx.try_recv().is_err(), "a refused resume emits nothing");
    }
}

#[test]
fn test_every_operation_reports_an_unknown_worker() {
    let registry = WorkerRegistry::new();
    let repo_locks = RepoLocks::new();
    let (sink, _rx) = test_sink();
    let id = Uuid::new_v4();
    let none = Provenance::default;

    assert_matches!(
        do_pause_worker(&sink, &registry, id, none()),
        Err(AppError::WorkerNotFound { .. })
    );
    assert_matches!(
        do_resume_worker(&sink, &registry, id, none()),
        Err(AppError::WorkerNotFound { .. })
    );
    assert_matches!(
        do_resize_worker(&registry, id, 24, 80),
        Err(AppError::WorkerNotFound { .. })
    );
    assert_matches!(
        do_worker_input(&sink, &registry, id, b"x", InputSource::Terminal, none()),
        Err(AppError::WorkerNotFound { .. })
    );
    assert_matches!(
        do_kill_worker(&sink, &registry, &repo_locks, id, none()),
        Err(AppError::WorkerNotFound { .. })
    );
}

// ── input ────────────────────────────────────────────────────────

#[test]
fn test_worker_input_no_pty_writer() {
    let registry = WorkerRegistry::new();
    let id = registry
        .spawn_worker(make_handle(WorkerState::Running))
        .unwrap();
    let (sink, _rx) = test_sink();

    let err = do_worker_input(
        &sink,
        &registry,
        id,
        b"hello",
        InputSource::Terminal,
        Provenance::default(),
    )
    .unwrap_err();
    assert!(err.to_string().contains("no PTY writer"), "{err}");
}

#[test]
fn test_worker_input_rejects_a_worker_whose_shell_exited() {
    let registry = WorkerRegistry::new();
    let (handle, buf) = make_handle_with_pty(WorkerState::Error);
    let id = registry.spawn_worker(handle).unwrap();
    let (sink, rx) = test_sink();

    let err = do_worker_input(
        &sink,
        &registry,
        id,
        b"ls\n",
        InputSource::Tool,
        Provenance::default(),
    )
    .unwrap_err();
    assert!(err.to_string().contains("has exited"), "{err}");
    assert!(buf.lock().is_empty(), "nothing was written");
    assert!(rx.try_recv().is_err(), "nothing was recorded");
}

/// `do_worker_input` writes to the PTY, then emits a `worker_input`
/// event carrying the caller's provenance (tool-driven input).
#[test]
fn test_worker_input_writes_then_emits_stamped_event() {
    let registry = WorkerRegistry::new();
    let (handle, buf) = make_handle_with_pty(WorkerState::Running);
    let id = registry.spawn_worker(handle).unwrap();
    let (sink, rx) = test_sink();
    let origin = Uuid::new_v4();

    do_worker_input(
        &sink,
        &registry,
        id,
        b"pnpm build\n",
        InputSource::Tool,
        Provenance {
            origin_worker: Some(origin),
            cause_seq: Some(41),
        },
    )
    .expect("write should succeed");

    assert_eq!(buf.lock().as_slice(), b"pnpm build\n");

    let msg = rx.recv().expect("worker_input message on writer channel");
    assert_eq!(msg.provenance.origin_worker, Some(origin));
    assert_eq!(msg.provenance.cause_seq, Some(41));
    let SwarmEvent::WorkerInput(p) = msg.event else {
        panic!("expected WorkerInput, got {:?}", msg.event);
    };
    assert_eq!(p.worker_id, id);
    assert_eq!(p.bytes, 11);
    assert_eq!(p.source, InputSource::Tool);
    // The trailing `\n` is a control character, so it is stripped.
    assert_eq!(p.preview.as_deref(), Some("pnpm build"));
}

/// Terminal input never carries a preview: human keystrokes are
/// recorded as a byte count only.
#[test]
fn test_worker_input_terminal_source_has_no_preview() {
    let registry = WorkerRegistry::new();
    let (handle, _buf) = make_handle_with_pty(WorkerState::Running);
    let id = registry.spawn_worker(handle).unwrap();
    let (sink, rx) = test_sink();

    do_worker_input(
        &sink,
        &registry,
        id,
        b"super-secret-password\n",
        InputSource::Terminal,
        Provenance::default(),
    )
    .unwrap();

    let SwarmEvent::WorkerInput(p) = rx.recv().unwrap().event else {
        panic!("expected WorkerInput");
    };
    assert_eq!(p.preview, None, "terminal input must never carry a preview");
    assert_eq!(p.bytes, 22);
}

/// The preview is control-stripped and capped at 120 characters.
#[test]
fn test_worker_input_preview_strips_control_chars_and_truncates() {
    let registry = WorkerRegistry::new();
    let (handle, _buf) = make_handle_with_pty(WorkerState::Running);
    let id = registry.spawn_worker(handle).unwrap();
    let (sink, rx) = test_sink();

    let mut data = format!("\x1b[31m{}", "a".repeat(200)).into_bytes();
    data.push(0x07); // BEL, a control char

    do_worker_input(
        &sink,
        &registry,
        id,
        &data,
        InputSource::Automation,
        Provenance::default(),
    )
    .unwrap();

    let SwarmEvent::WorkerInput(p) = rx.recv().unwrap().event else {
        panic!("expected WorkerInput");
    };
    let preview = p.preview.expect("automation input carries a preview");
    assert_eq!(preview.chars().count(), 120);
    assert!(
        !preview.chars().any(char::is_control),
        "preview must strip control characters, got: {preview:?}"
    );
}

/// Machine-issued input can carry a typed credential; the preview is
/// the only durable copy, so it is redacted before it is stamped.
#[test]
fn test_worker_input_preview_redacts_credentials() {
    let registry = WorkerRegistry::new();
    let (handle, _buf) = make_handle_with_pty(WorkerState::Running);
    let id = registry.spawn_worker(handle).unwrap();
    let (sink, rx) = test_sink();

    do_worker_input(
        &sink,
        &registry,
        id,
        b"export K=sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789\n",
        InputSource::Tool,
        Provenance::default(),
    )
    .unwrap();

    let SwarmEvent::WorkerInput(p) = rx.recv().unwrap().event else {
        panic!("expected WorkerInput");
    };
    let preview = p.preview.expect("tool input carries a preview");
    assert!(preview.contains("[REDACTED]"), "got: {preview:?}");
    assert!(!preview.contains("sk-ant-api03"), "got: {preview:?}");

    // Control characters are word boundaries only before stripping: a key
    // between CR or LF must be redacted on the raw text.
    for (input, leak) in [
        (
            &b"echo ok\rAKIAIOSFODNN7EXAMPLE\rls\r"[..],
            "AKIAIOSFODNN7EXAMPLE",
        ),
        (
            &b"cat <<EOF\nsk-proj-abcdefghijklmnopqrstuvwxyz\nEOF\n"[..],
            "sk-proj-",
        ),
    ] {
        do_worker_input(
            &sink,
            &registry,
            id,
            input,
            InputSource::Tool,
            Provenance::default(),
        )
        .unwrap();
        let SwarmEvent::WorkerInput(p) = rx.recv().unwrap().event else {
            panic!("expected WorkerInput");
        };
        let preview = p.preview.expect("tool input carries a preview");
        assert!(!preview.contains(leak), "got: {preview:?}");
    }
}

/// A writer that blocks until released, like a PTY whose
/// foreground program stopped reading its input.
struct BlockedWriter {
    entered: std::sync::mpsc::Sender<()>,
    release: Receiver<()>,
}

impl Write for BlockedWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let _ = self.entered.send(());
        let _ = self.release.recv();
        Ok(buf.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// A write blocked on a full PTY input queue must not hold the
/// registry's shard lock, or the kill that would unblock it could
/// never run.
#[test]
fn test_kill_is_not_blocked_by_an_input_write_in_progress() {
    let registry = WorkerRegistry::new();
    let repo_locks = RepoLocks::new();
    let (sink, rx) = test_sink();
    let (entered_tx, entered) = channel();
    let (release, release_rx) = channel();
    let id = registry
        .spawn_worker(make_handle_with_writer(
            WorkerState::Running,
            BlockedWriter {
                entered: entered_tx,
                release: release_rx,
            },
        ))
        .unwrap();

    std::thread::scope(|scope| {
        let writing = scope.spawn(|| {
            do_worker_input(
                &sink,
                &registry,
                id,
                b"a large paste",
                InputSource::Terminal,
                Provenance::default(),
            )
        });
        entered
            .recv_timeout(SHELL_TIMEOUT)
            .expect("the write started");

        let (killed_tx, killed) = channel();
        let (sink, registry, repo_locks) = (&sink, &registry, &repo_locks);
        scope.spawn(move || {
            let result = do_kill_worker(sink, registry, repo_locks, id, Provenance::default());
            killed_tx.send(result).unwrap();
        });
        let kill_result = killed.recv_timeout(Duration::from_secs(10));
        // Unblock the writer whatever happened, so the scope can end.
        release.send(()).unwrap();

        kill_result
            .expect("the kill must not wait for the blocked write")
            .expect("the kill succeeds");
        writing.join().unwrap().expect("the write itself completes");
    });

    assert_eq!(registry.count(), 0);
    assert!(
        queued_events(&rx)
            .iter()
            .any(|e| matches!(e, SwarmEvent::WorkerKilled(_)))
    );
}

// ── resize ───────────────────────────────────────────────────────

#[test]
fn test_resize_rejects_zero_dimensions_and_workers_without_a_pty() {
    let registry = WorkerRegistry::new();
    let id = registry
        .spawn_worker(make_handle(WorkerState::Running))
        .unwrap();

    for (rows, cols) in [(0, 80), (24, 0)] {
        let err = do_resize_worker(&registry, id, rows, cols).unwrap_err();
        assert!(err.to_string().contains("at least 1"), "{err}");
    }
    let err = do_resize_worker(&registry, id, 24, 80).unwrap_err();
    assert!(err.to_string().contains("has no PTY"), "{err}");
}

// ── tracing never records env values ─────────────────────────────

/// `Write` + `MakeWriter` over a shared buffer, so a
/// `tracing_subscriber::fmt` subscriber writes into memory the test
/// can inspect.
#[derive(Clone, Default)]
struct TracingCaptureBuf(Arc<Mutex<Vec<u8>>>);

impl Write for TracingCaptureBuf {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.0.lock().extend_from_slice(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for TracingCaptureBuf {
    type Writer = Self;
    fn make_writer(&'a self) -> Self::Writer {
        self.clone()
    }
}

const SECRET: &str = "sk-ant-super-secret-value-should-never-be-logged";

/// Runs `do_spawn_worker` with a secret-bearing env under a
/// subscriber that prints every event and every span's fields as
/// the span opens, and returns the spawn result and all output.
fn spawn_under_capture(shell: &str) -> (Result<Uuid, AppError>, String, WorkerRegistry) {
    let capture = TracingCaptureBuf::default();
    let subscriber = tracing_subscriber::fmt()
        .with_writer(capture.clone())
        .with_max_level(tracing::Level::DEBUG)
        .with_span_events(FmtSpan::NEW)
        .with_ansi(false)
        .finish();

    let registry = WorkerRegistry::new();
    let repo_locks = RepoLocks::new();
    let (sink, _rx) = test_sink();
    let config = WorkerConfig {
        name: "Secret Bearer".to_owned(),
        shell: shell.to_owned(),
        env: [("ANTHROPIC_API_KEY".to_owned(), SECRET.to_owned())].into(),
        ..WorkerConfig::default()
    };

    let result = tracing::subscriber::with_default(subscriber, || {
        do_spawn_worker(&sink, &registry, &repo_locks, config, Provenance::default())
    });
    if let Ok(id) = result {
        do_kill_worker(&sink, &registry, &repo_locks, id, Provenance::default()).unwrap();
    }
    let captured = String::from_utf8_lossy(&capture.0.lock()).into_owned();
    (result, captured, registry)
}

/// `spawn_pty`'s span records `env_key_count`, never `env` values, so
/// nothing logged inside it, and no span-printing layer, can leak
/// per-profile API keys. Asserted with span fields printed, so the
/// test cannot pass vacuously.
#[test]
fn test_spawn_never_records_env_values_in_events_or_spans() {
    let (result, captured, _) = spawn_under_capture("");
    result.expect("the default shell spawns");
    assert!(
        !captured.contains(SECRET),
        "tracing output leaked an env value: {captured}"
    );
    assert!(
        captured.contains("spawn_pty") && captured.contains("env_key_count=1"),
        "spawn_pty's span (with its redacted fields) must have been printed: {captured}"
    );
    assert!(
        captured.contains("Secret Bearer"),
        "the spawn's redacted summary must have been printed: {captured}"
    );
}

/// The failure path logs inside `spawn_pty`'s span: still no secret.
#[test]
fn test_a_failed_spawn_never_records_env_values() {
    let (result, captured, registry) = spawn_under_capture("swarm-no-such-shell-xyz");
    assert_matches!(result, Err(AppError::PtySpawn(_)));
    assert!(
        captured.contains("PTY spawn failed"),
        "the failure must have been logged: {captured}"
    );
    assert!(
        !captured.contains(SECRET),
        "tracing output leaked an env value: {captured}"
    );
    assert_eq!(registry.count(), 0);
}

// ── real shells ──────────────────────────────────────────────────

/// On Windows the pseudoconsole outlives `spawn_pty`'s return: the
/// shell must be alive after the spawn and answer input.
#[test]
fn test_spawned_shell_stays_alive_and_answers_input() {
    let registry = WorkerRegistry::new();
    let repo_locks = RepoLocks::new();
    let (sink, rx) = test_sink();

    let id = do_spawn_worker(
        &sink,
        &registry,
        &repo_locks,
        WorkerConfig::default(),
        Provenance::default(),
    )
    .expect("the default shell spawns");
    assert_matches!(
        next_event(&rx).event,
        SwarmEvent::WorkerSpawned(WorkerSpawnedPayload { worker_id, .. }) if worker_id == id
    );

    attach_headless_terminal(&sink, &registry, id);
    let (command, marker) = marker_command();
    type_into(&sink, &registry, id, command);
    wait_for_output(&rx, marker);

    let still_running = registry
        .workers
        .get(&id)
        .unwrap()
        .child
        .as_ref()
        .unwrap()
        .process
        .lock()
        .try_wait()
        .unwrap()
        .is_none();
    assert!(still_running, "the shell is still running after answering");
    assert_eq!(
        registry.get_worker(&id).unwrap().state,
        WorkerState::Running
    );

    do_kill_worker(&sink, &registry, &repo_locks, id, Provenance::default()).unwrap();
}

/// The PTY master is kept, so the terminal can be resized after the
/// spawn and the shell sees the new size.
#[test]
fn test_resize_reaches_the_shell() {
    let registry = WorkerRegistry::new();
    let repo_locks = RepoLocks::new();
    let (sink, rx) = test_sink();
    let id = do_spawn_worker(
        &sink,
        &registry,
        &repo_locks,
        WorkerConfig::default(),
        Provenance::default(),
    )
    .unwrap();
    attach_headless_terminal(&sink, &registry, id);

    do_resize_worker(&registry, id, 33, 101).expect("resize succeeds");

    let size = registry
        .workers
        .get(&id)
        .unwrap()
        .child
        .as_ref()
        .unwrap()
        .master
        .lock()
        .get_size()
        .unwrap();
    assert_eq!((size.rows, size.cols), (33, 101));
    let (command, marker) = if cfg!(windows) {
        (
            "echo \"size-$([Console]::WindowHeight)x$([Console]::WindowWidth)\"\r",
            "size-33x101",
        )
    } else {
        ("echo size-$(stty size | tr ' ' x)\r", "size-33x101")
    };
    type_into(&sink, &registry, id, command);
    wait_for_output(&rx, marker);

    do_kill_worker(&sink, &registry, &repo_locks, id, Provenance::default()).unwrap();
}

/// A shell that exits on its own moves its worker to `error`,
/// announced by a `worker_state` event; the worker then refuses input
/// and is still killable.
#[test]
fn test_a_shell_that_exits_on_its_own_marks_its_worker_errored() {
    let registry = WorkerRegistry::new();
    let repo_locks = RepoLocks::new();
    let (sink, rx) = test_sink();
    let id = do_spawn_worker(
        &sink,
        &registry,
        &repo_locks,
        WorkerConfig::default(),
        Provenance::default(),
    )
    .unwrap();
    assert_matches!(next_event(&rx).event, SwarmEvent::WorkerSpawned(_));

    attach_headless_terminal(&sink, &registry, id);
    type_into(&sink, &registry, id, "exit\r");
    loop {
        match next_event(&rx).event {
            SwarmEvent::WorkerInput(_) => {}
            SwarmEvent::WorkerState(p) => {
                assert_eq!((p.worker_id, p.state), (id, WorkerState::Error));
                break;
            }
            other => panic!("unexpected event {other:?}"),
        }
    }
    assert_eq!(registry.get_worker(&id).unwrap().state, WorkerState::Error);
    assert_eq!(registry.aggregate_metrics().errored, 1);
    let err = do_worker_input(
        &sink,
        &registry,
        id,
        b"echo hi\r",
        InputSource::Terminal,
        Provenance::default(),
    )
    .unwrap_err();
    assert!(err.to_string().contains("has exited"), "{err}");

    do_kill_worker(&sink, &registry, &repo_locks, id, Provenance::default()).unwrap();
    assert_matches!(next_event(&rx).event, SwarmEvent::WorkerKilled(_));
    assert_eq!(registry.count(), 0);
}

#[test]
fn test_spawn_without_repo_root_is_unisolated() {
    let registry = WorkerRegistry::new();
    let repo_locks = RepoLocks::new();
    let (sink, rx) = test_sink();

    let config = WorkerConfig {
        name: "Plain Worker".to_owned(),
        ..WorkerConfig::default()
    };
    assert!(config.repo_root.is_none());
    let id = do_spawn_worker(&sink, &registry, &repo_locks, config, Provenance::default())
        .expect("an unisolated spawn succeeds");

    let info = registry.get_worker(&id).unwrap();
    assert!(info.worktree_path.is_none());
    assert!(info.branch.is_none());

    // `worker_spawned` says `none`, and no `worktree_created` follows
    // (it would have been emitted before the spawn returned).
    let events = queued_events(&rx);
    let [SwarmEvent::WorkerSpawned(p)] = events.as_slice() else {
        panic!("expected exactly worker_spawned, got {events:?}");
    };
    assert_eq!(p.isolation.as_deref(), Some("none"));

    do_kill_worker(&sink, &registry, &repo_locks, id, Provenance::default()).unwrap();
}

// ── worktree isolation ───────────────────────────────────────────

/// A disposable git repository with one commit, plus a worktrees
/// root next to it, both removed when the returned guard drops.
struct TempRepo {
    root: PathBuf,
    worktrees: PathBuf,
}

fn temp_repo() -> DropGuard<TempRepo, impl FnOnce(TempRepo)> {
    let base = std::env::temp_dir().join(format!("swarm-lifecycle-git-{}", Uuid::new_v4()));
    let root = base.join("repo");
    std::fs::create_dir_all(&root).unwrap();

    let run = |args: &[&str]| {
        let mut full = git::repo::base_args(&root);
        full.extend(args.iter().map(ToString::to_string));
        let out = git::cli::run(&full, git::cli::CREATE_TIMEOUT).unwrap();
        assert!(out.success(), "git setup failed: {} ({full:?})", out.stderr);
    };
    run(&["init"]);
    run(&["config", "user.email", "swarm-test@example.com"]);
    run(&["config", "user.name", "Swarm Test"]);
    std::fs::write(root.join("README.md"), "hello").unwrap();
    run(&["add", "-A"]);
    run(&["commit", "-m", "initial"]);

    DropGuard::new(
        TempRepo {
            root,
            worktrees: base.join("worktrees"),
        },
        move |_| {
            let _ = std::fs::remove_dir_all(base);
        },
    )
}

/// A registry whose isolated workers live under `repo.worktrees`
/// instead of the real `~/.swarm/worktrees`.
fn registry_for(repo: &TempRepo) -> WorkerRegistry {
    let registry = WorkerRegistry::new();
    registry.config.write().worktrees_root = Some(repo.worktrees.clone());
    registry
}

fn isolated_config(repo: &TempRepo, name: &str) -> WorkerConfig {
    WorkerConfig {
        name: name.to_owned(),
        repo_root: Some(repo.root.display().to_string()),
        ..WorkerConfig::default()
    }
}

/// Output lines of `git <args>` run in `repo`.
fn git_lines(repo: &Path, args: &[&str]) -> Vec<String> {
    let mut full = git::repo::base_args(repo);
    full.extend(args.iter().map(ToString::to_string));
    let out = git::cli::run(&full, git::cli::CREATE_TIMEOUT).unwrap();
    assert!(out.success(), "git {args:?} failed: {}", out.stderr);
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(str::to_owned)
        .collect()
}

fn swarm_branches(repo: &Path) -> Vec<String> {
    git_lines(repo, &["branch", "--list", "swarm/*"])
}

/// Every `w-*` worktree directory under `worktrees`.
fn worktree_dirs(worktrees: &Path) -> Vec<PathBuf> {
    let Ok(repos) = std::fs::read_dir(worktrees) else {
        return Vec::new();
    };
    repos
        .flatten()
        .flat_map(|repo| {
            std::fs::read_dir(repo.path())
                .into_iter()
                .flatten()
                .flatten()
        })
        .map(|entry| entry.path())
        .collect()
}

/// `repo_root` that is not a git repository fails the whole spawn;
/// there is no fallback to an unisolated worker at `config.cwd`.
#[test]
fn test_spawn_hard_fails_when_repo_root_is_not_a_git_repo() {
    let not_a_repo = std::env::temp_dir().join(format!("swarm-not-a-repo-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&not_a_repo).unwrap();
    let _cleanup = DropGuard::new(not_a_repo.clone(), |dir| {
        let _ = std::fs::remove_dir_all(dir);
    });

    let registry = WorkerRegistry::new();
    registry.set_max_workers(1).unwrap();
    let repo_locks = RepoLocks::new();
    let (sink, rx) = test_sink();
    let config = WorkerConfig {
        name: "Doomed Worker".to_owned(),
        repo_root: Some(not_a_repo.display().to_string()),
        isolation: WorkerIsolation::Worktree,
        ..WorkerConfig::default()
    };

    let result = do_spawn_worker(&sink, &registry, &repo_locks, config, Provenance::default());
    assert_matches!(result, Err(AppError::Git(_)));
    assert_eq!(registry.count(), 0, "nothing may be registered");
    assert!(rx.try_recv().is_err(), "nothing may be announced");
    assert!(
        registry.reserve().is_ok(),
        "the reserved slot was given back"
    );
}

/// `RegistryFull` is detected before any side effect, so a spawn at
/// capacity creates nothing: no worktree, branch or shell.
#[test]
fn test_spawn_at_capacity_creates_no_worktree_branch_or_shell() {
    let repo = temp_repo();
    let registry = registry_for(&repo);
    registry.set_max_workers(1).unwrap();
    let repo_locks = RepoLocks::new();
    let (sink, rx) = test_sink();

    let first = do_spawn_worker(
        &sink,
        &registry,
        &repo_locks,
        isolated_config(&repo, "First"),
        Provenance::default(),
    )
    .unwrap();
    let before = queued_events(&rx).len();

    let second = do_spawn_worker(
        &sink,
        &registry,
        &repo_locks,
        isolated_config(&repo, "Second"),
        Provenance::default(),
    );
    assert_matches!(second, Err(AppError::RegistryFull { max: 1 }));

    assert_eq!(registry.count(), 1);
    assert_eq!(
        worktree_dirs(&repo.worktrees).len(),
        1,
        "no second worktree"
    );
    assert_eq!(swarm_branches(&repo.root).len(), 1, "no second branch");
    assert_eq!(
        git_lines(&repo.root, &["worktree", "list", "--porcelain"])
            .iter()
            .filter(|line| line.starts_with("worktree "))
            .count(),
        2,
        "the main worktree and the first worker's only"
    );
    assert_eq!(before, 2, "worker_spawned + worktree_created for the first");
    assert!(
        queued_events(&rx).is_empty(),
        "the refused spawn announced nothing"
    );

    do_kill_worker(&sink, &registry, &repo_locks, first, Provenance::default()).unwrap();
    assert!(worktree_dirs(&repo.worktrees).is_empty());
    assert!(swarm_branches(&repo.root).is_empty());
}

/// A shell that cannot start rolls back the worktree it was going to
/// run in, including its branch, and gives the reserved slot back.
#[test]
fn test_failed_shell_spawn_rolls_back_worktree_branch_and_slot() {
    let repo = temp_repo();
    let registry = registry_for(&repo);
    registry.set_max_workers(1).unwrap();
    let repo_locks = RepoLocks::new();
    let (sink, rx) = test_sink();

    let result = do_spawn_worker(
        &sink,
        &registry,
        &repo_locks,
        WorkerConfig {
            shell: "swarm-no-such-shell-xyz".to_owned(),
            ..isolated_config(&repo, "Broken Shell")
        },
        Provenance::default(),
    );
    assert_matches!(result, Err(AppError::PtySpawn(_)));
    assert_eq!(registry.count(), 0);
    assert!(
        worktree_dirs(&repo.worktrees).is_empty(),
        "worktree rolled back"
    );
    assert!(swarm_branches(&repo.root).is_empty(), "branch rolled back");
    assert!(rx.try_recv().is_err(), "nothing was announced");

    let id = do_spawn_worker(
        &sink,
        &registry,
        &repo_locks,
        WorkerConfig::default(),
        Provenance::default(),
    )
    .expect("the only slot is free again");
    do_kill_worker(&sink, &registry, &repo_locks, id, Provenance::default()).unwrap();
}

/// End to end: an isolated worker gets its worktree and branch,
/// `worktree_created` describes them, and a clean kill removes the
/// worktree (`worktree_removed` `removed`) before `worker_killed`.
#[test]
fn test_spawn_and_kill_isolated_worker_full_cycle() {
    let repo = temp_repo();
    let registry = registry_for(&repo);
    let repo_locks = RepoLocks::new();
    let (sink, rx) = test_sink();

    let id = do_spawn_worker(
        &sink,
        &registry,
        &repo_locks,
        isolated_config(&repo, "Research Agent"),
        Provenance::default(),
    )
    .expect("an isolated spawn succeeds against a real git repo");

    let info = registry.get_worker(&id).unwrap();
    let worktree_path = info.worktree_path.clone().expect("worktree_path is set");
    assert!(Path::new(&worktree_path).starts_with(&repo.worktrees));
    assert!(worktree_path.contains("w-"));
    let branch = info.branch.clone().expect("branch is set");
    assert!(branch.starts_with("swarm/research-agent-"));
    assert!(Path::new(&worktree_path).join("README.md").exists());

    let SwarmEvent::WorkerSpawned(spawned) = next_event(&rx).event else {
        panic!("expected worker_spawned");
    };
    assert_eq!(spawned.isolation.as_deref(), Some("worktree"));
    let SwarmEvent::WorktreeCreated(created) = next_event(&rx).event else {
        panic!("expected worktree_created");
    };
    assert_eq!(created.worker_id, id);
    assert_eq!(created.worktree_path, worktree_path);
    assert_eq!(created.branch, branch);
    assert!(!created.base_commit.is_empty());

    do_kill_worker(&sink, &registry, &repo_locks, id, Provenance::default()).unwrap();

    let SwarmEvent::WorktreeRemoved(removed) = next_event(&rx).event else {
        panic!("expected worktree_removed before worker_killed");
    };
    assert_eq!(removed.disposition, "removed");
    assert_eq!(removed.worktree_path, worktree_path);
    assert!(removed.reason.is_none());
    assert_matches!(
        next_event(&rx).event,
        SwarmEvent::WorkerKilled(WorkerKilledPayload { worker_id }) if worker_id == id
    );
    assert!(
        !Path::new(&worktree_path).exists(),
        "a clean worktree is removed from disk on kill"
    );
}

/// A clean kill whose branch tip is still the base commit (no
/// commits made) also deletes the branch, so `swarm/*` branches do
/// not pile up in the user's repository.
#[test]
fn test_kill_deletes_unchanged_isolation_branch() {
    let repo = temp_repo();
    let registry = registry_for(&repo);
    let repo_locks = RepoLocks::new();
    let (sink, rx) = test_sink();

    let id = do_spawn_worker(
        &sink,
        &registry,
        &repo_locks,
        isolated_config(&repo, "Clean Agent"),
        Provenance::default(),
    )
    .unwrap();
    let branch = registry.get_worker(&id).unwrap().branch.unwrap();
    assert!(git::repo::rev_parse(&repo.root, &branch).is_ok());

    do_kill_worker(&sink, &registry, &repo_locks, id, Provenance::default()).unwrap();

    let removed = queued_events(&rx).into_iter().find_map(|e| match e {
        SwarmEvent::WorktreeRemoved(p) => Some(p),
        _ => None,
    });
    assert_eq!(removed.unwrap().disposition, "removed");
    assert!(
        git::repo::rev_parse(&repo.root, &branch).is_err(),
        "an unchanged isolation branch is deleted after a clean kill"
    );
}

/// A worker that committed in its worktree keeps its branch: the
/// commit leaves the tree clean (disposition `removed`), but the tip
/// has moved past the base commit. The commit is also merged into the
/// repo root's HEAD, so `git branch -d` alone would not keep it.
#[test]
fn test_kill_retains_diverged_isolation_branch() {
    let repo = temp_repo();
    let registry = registry_for(&repo);
    let repo_locks = RepoLocks::new();
    let (sink, rx) = test_sink();

    let id = do_spawn_worker(
        &sink,
        &registry,
        &repo_locks,
        isolated_config(&repo, "Committing Agent"),
        Provenance::default(),
    )
    .unwrap();
    let info = registry.get_worker(&id).unwrap();
    let branch = info.branch.unwrap();
    let worktree = PathBuf::from(info.worktree_path.unwrap());

    std::fs::write(worktree.join("agent-output.txt"), "real work").unwrap();
    git_lines(&worktree, &["add", "-A"]);
    git_lines(&worktree, &["commit", "-m", "agent work"]);
    // Fast-forward the repo root's HEAD onto the worker's commit:
    // `git branch -d` would now delete the branch, so only the
    // tip-vs-base check can keep it.
    git_lines(&repo.root, &["merge", "--ff-only", branch.as_str()]);

    do_kill_worker(&sink, &registry, &repo_locks, id, Provenance::default()).unwrap();

    let removed = queued_events(&rx).into_iter().find_map(|e| match e {
        SwarmEvent::WorktreeRemoved(p) => Some(p),
        _ => None,
    });
    assert_eq!(removed.unwrap().disposition, "removed");
    assert!(
        git::repo::rev_parse(&repo.root, &branch).is_ok(),
        "a diverged isolation branch must not be deleted"
    );
}

/// A failed unlock is reported as `failed` and the removal is not
/// attempted.
#[test]
fn test_kill_reports_failed_when_unlock_fails() {
    let repo = temp_repo();
    let registry = registry_for(&repo);
    let repo_locks = RepoLocks::new();
    let (sink, rx) = test_sink();

    let id = do_spawn_worker(
        &sink,
        &registry,
        &repo_locks,
        isolated_config(&repo, "Unlock Fail Agent"),
        Provenance::default(),
    )
    .unwrap();
    let worktree_path = registry.get_worker(&id).unwrap().worktree_path.unwrap();

    // Unlock out of band first, so git reports "not locked".
    git::worktree::unlock(&repo.root, Path::new(&worktree_path)).unwrap();

    do_kill_worker(&sink, &registry, &repo_locks, id, Provenance::default()).unwrap();

    let removed = queued_events(&rx).into_iter().find_map(|e| match e {
        SwarmEvent::WorktreeRemoved(p) => Some(p),
        _ => None,
    });
    let removed = removed.expect("worktree_removed is emitted");
    assert_eq!(removed.disposition, "failed");
    assert!(removed.reason.is_some());
    assert!(
        Path::new(&worktree_path).exists(),
        "remove() was never attempted"
    );
}

/// Preserve-on-dirty through the real kill path: a worktree with
/// uncommitted work survives the kill (`preserved_dirty`, with git's
/// refusal as the reason), and so does the work.
#[test]
fn test_kill_preserves_dirty_worktree_instead_of_deleting_it() {
    let repo = temp_repo();
    let registry = registry_for(&repo);
    let repo_locks = RepoLocks::new();
    let (sink, rx) = test_sink();

    let id = do_spawn_worker(
        &sink,
        &registry,
        &repo_locks,
        isolated_config(&repo, "Dirty Agent"),
        Provenance::default(),
    )
    .unwrap();
    let worktree = PathBuf::from(registry.get_worker(&id).unwrap().worktree_path.unwrap());
    std::fs::write(worktree.join("scratch.txt"), "uncommitted agent output").unwrap();

    do_kill_worker(&sink, &registry, &repo_locks, id, Provenance::default()).unwrap();

    let removed = queued_events(&rx).into_iter().find_map(|e| match e {
        SwarmEvent::WorktreeRemoved(p) => Some(p),
        _ => None,
    });
    let removed = removed.expect("worktree_removed is emitted");
    assert_eq!(removed.disposition, "preserved_dirty");
    assert!(
        removed.reason.is_some(),
        "preserved_dirty carries git's refusal"
    );
    assert!(
        worktree.join("scratch.txt").exists(),
        "SWARM never force-removes"
    );
}

// -- stamped_preview: the redactor must read what the shell reads ---------

/// Backspace edits the line the shell receives, so the preview is
/// withheld rather than guessed.
#[test]
fn test_preview_withheld_when_credential_edited_with_backspace() {
    for input in [
        // Stripping BS leaves a redactable token; the shell sees a shorter one.
        &b"echo sk-ant-XX\x08\x08api03-abcdefghijklmnopqrstuvwx\n"[..],
        // A space-BS pair erases itself: the shell sees one whole key, the
        // stripped text a space-split fragment no pattern matches.
        b"echo sk-ant-api03 \x08-abcdefghijklmnopqrstuvwx\n",
    ] {
        assert_eq!(stamped_preview(input), "[preview withheld: line editing]");
    }
}

/// DEL anywhere withholds the whole preview, even with no credential.
#[test]
fn test_preview_withheld_on_del() {
    assert_eq!(
        stamped_preview(b"ls -la\x7f\x7f"),
        "[preview withheld: line editing]"
    );
}

/// A CSI sequence inside a token must not break the match: stripping
/// ESC alone would leave `[31m` in the middle of the key.
#[test]
fn test_preview_redacts_credential_split_by_ansi_sequence() {
    for input in [
        &b"export K=sk-ant-api03\x1b[31m-abcdefghijklmnopqrstuvwx\n"[..],
        b"export K=sk-ant-api03\x1b[1;38;5;196m-abcdefghijklmnopqrstuvwx\n",
        b"export K=sk-ant-api03\x1b]0;title\x07-abcdefghijklmnopqrstuvwx\n",
        b"export K=sk-ant-api03\x1b]0;title\x1b\x5c-abcdefghijklmnopqrstuvwx\n",
        b"export K=sk-ant-api03\x1bM-abcdefghijklmnopqrstuvwx\n",
    ] {
        let preview = stamped_preview(input);
        assert!(preview.contains("[REDACTED]"), "got: {preview:?}");
        assert!(!preview.contains("api03"), "got: {preview:?}");
        assert!(!preview.contains("abcdefghij"), "got: {preview:?}");
    }
}

/// A zero-width or bidi format character is not `is_control`, yet it
/// splits a token the terminal shows whole.
#[test]
fn test_preview_redacts_credential_split_by_format_character() {
    for splitter in ['\u{200B}', '\u{202E}', '\u{2060}', '\u{2066}', '\u{FEFF}'] {
        let input = format!("echo ghp_abcdefghij{splitter}klmnopqrstuvwxyz0123\n");
        let preview = stamped_preview(input.as_bytes());
        assert!(preview.contains("[REDACTED]"), "got: {preview:?}");
        assert!(!preview.contains("ghp_"), "got: {preview:?}");
        assert!(!preview.contains("klmnop"), "got: {preview:?}");
    }
}

/// Positive control: a plain credential is redacted, plain text is
/// untouched, and the cut is 120 characters after redaction.
#[test]
fn test_preview_plain_credential_redacted_and_plain_text_unchanged() {
    let preview = stamped_preview(b"export K=sk-ant-api03-abcdefghijklmnopqrstuvwx");
    assert_eq!(preview, "export K=[REDACTED]");
    assert_eq!(
        stamped_preview(b"pnpm build --filter web"),
        "pnpm build --filter web"
    );
    assert_eq!(
        stamped_preview("a".repeat(300).as_bytes()).chars().count(),
        120
    );
}
