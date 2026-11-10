//! Test fixtures shared by the crate's unit tests: each defined once so
//! no module grows its own copy of the temp-path, cleanup and capture
//! plumbing.

use std::io;
use std::mem::DropGuard;
use std::path::PathBuf;
use std::sync::{Arc, LazyLock};

use parking_lot::Mutex;
use tracing::subscriber::{DefaultGuard, NoSubscriber};
use tracing::{Dispatch, Level};
use tracing_subscriber::fmt::format::FmtSpan;

/// A `Write` over a shared buffer: a stand-in PTY writer, and the sink
/// for a captured tracing subscriber.
#[derive(Clone, Default)]
pub(crate) struct SharedBuf(pub(crate) Arc<Mutex<Vec<u8>>>);

impl io::Write for SharedBuf {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.0.lock().extend_from_slice(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for SharedBuf {
    type Writer = Self;
    fn make_writer(&'a self) -> Self::Writer {
        self.clone()
    }
}

/// A registered dispatcher that lives for the whole process, so once a
/// capture registers, tracing-core's dispatcher list never again holds
/// just one live entry.
///
/// With one live dispatcher, tracing-core 0.1.36 takes its "just one"
/// path (`callsite.rs:544-566`): the thread that first reaches a
/// callsite computes and caches its interest from that thread's own
/// default subscriber, without a lock. A test thread with no subscriber
/// caches `never`, and a capture on another thread then loses every
/// line from that callsite. With two or more, interest comes from every
/// live dispatcher under the registry lock (`callsite.rs:548`,
/// `490-507`): this one answers `never`, a capture `always`, combined
/// `sometimes`, so each event asks its own thread's default. Its missing
/// level hint also keeps the global max level at `TRACE`
/// (`callsite.rs:407-421`).
static MULTI_DISPATCH_KEEPALIVE: LazyLock<Dispatch> =
    LazyLock::new(|| Dispatch::new(NoSubscriber::new()));

/// Tracing output captured on the calling thread until this drops.
pub(crate) struct LogCapture {
    buf: SharedBuf,
    _default: DefaultGuard,
}

impl LogCapture {
    /// Everything captured so far.
    pub(crate) fn text(&self) -> String {
        String::from_utf8_lossy(&self.buf.0.lock()).into_owned()
    }
}

/// Makes a plain-text formatting subscriber (`max_level`, `span_events`)
/// the calling thread's default and captures what it writes. A line the
/// thread logs is captured even when another thread, with no subscriber
/// of its own, reached that callsite first.
pub(crate) fn capture_logs(max_level: Level, span_events: FmtSpan) -> LogCapture {
    LazyLock::force(&MULTI_DISPATCH_KEEPALIVE);
    let buf = SharedBuf::default();
    let default = tracing::subscriber::set_default(
        tracing_subscriber::fmt()
            .with_writer(buf.clone())
            .with_max_level(max_level)
            .with_span_events(span_events)
            .with_ansi(false)
            .finish(),
    );
    LogCapture {
        buf,
        _default: default,
    }
}

/// A fresh, empty directory removed (with everything in it) on drop,
/// so a failing assertion still cleans up.
pub(crate) fn temp_dir(label: &str) -> (PathBuf, DropGuard<PathBuf, impl FnOnce(PathBuf)>) {
    let dir = std::env::temp_dir().join(format!("swarm-{label}-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let guard = DropGuard::new(dir.clone(), |dir| {
        let _ = std::fs::remove_dir_all(dir);
    });
    (dir, guard)
}

/// A not-yet-created SQLite database path in the temp directory,
/// removed on drop together with its `-wal` and `-shm` siblings.
pub(crate) fn temp_db() -> (PathBuf, DropGuard<PathBuf, impl FnOnce(PathBuf)>) {
    let path = std::env::temp_dir().join(format!("swarm-test-{}.db", uuid::Uuid::new_v4()));
    let guard = DropGuard::new(path.clone(), |path| {
        for suffix in ["-wal", "-shm"] {
            let mut sibling = path.clone().into_os_string();
            sibling.push(suffix);
            let _ = std::fs::remove_file(sibling);
        }
        let _ = std::fs::remove_file(&path);
    });
    (path, guard)
}

/// Whether `pid` names a live process. A zombie (Unix) counts as gone:
/// it has exited and only waits for its reaper.
pub(crate) fn is_running(pid: u32) -> bool {
    if cfg!(windows) {
        let output = std::process::Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/NH", "/FO", "CSV"])
            .output()
            .expect("tasklist runs");
        String::from_utf8_lossy(&output.stdout).contains(&format!("\"{pid}\""))
    } else {
        let output = std::process::Command::new("ps")
            .args(["-o", "stat=", "-p", &pid.to_string()])
            .output()
            .expect("ps runs");
        let stat = String::from_utf8_lossy(&output.stdout);
        output.status.success() && !stat.trim().is_empty() && !stat.trim_start().starts_with('Z')
    }
}

/// Polls until `pid` is gone, or panics after 30 s.
pub(crate) async fn assert_gone(pid: u32, what: &str) {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
    while is_running(pid) {
        assert!(
            std::time::Instant::now() < deadline,
            "{what} (pid {pid}) still runs after the stop"
        );
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
}

#[cfg(test)]
mod tests {
    use tracing::Level;
    use tracing_subscriber::fmt::format::FmtSpan;

    use super::capture_logs;

    /// A callsite only `test_a_capture_keeps_a_line_another_thread_reached_first`
    /// reaches, so it is still unregistered when that test starts.
    fn probe_line() {
        tracing::info!("capture probe line");
    }

    /// The flake this helper exists for: a thread with no subscriber
    /// registers the callsite first, then the capturing thread logs
    /// through it.
    #[test]
    fn test_a_capture_keeps_a_line_another_thread_reached_first() {
        let capture = capture_logs(Level::INFO, FmtSpan::NONE);
        std::thread::scope(|scope| {
            scope.spawn(probe_line);
        });
        probe_line();
        let captured = capture.text();
        assert!(
            captured.contains("capture probe line"),
            "the capturing thread's line was lost: {captured:?}"
        );
    }
}
