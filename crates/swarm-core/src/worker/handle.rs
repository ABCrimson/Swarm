//! Worker handle types, state machine, and configuration.
//!
//! Defines how a worker is described on the wire ([`WorkerState`],
//! [`WorkerIsolation`], [`WorkerConfig`], [`WorkerInfo`]) and the
//! runtime [`WorkerHandle`] the registry keeps for each live worker,
//! including the OS resources of its PTY ([`PtyChild`]).

use std::collections::HashMap;
use std::io::Write;
use std::sync::Arc;

use parking_lot::Mutex;
use portable_pty::{Child, MasterPty};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Lifecycle state of a worker.
///
/// ```text
/// spawn ──▶ Running ◀── pause / resume ──▶ Paused
///              │                              │
///              └─────── the shell exits ──────┴──▶ Error
/// ```
///
/// Every transition is announced with a `worker_state` event. A kill
/// removes the worker from the registry from any state (and emits
/// `worker_killed`); there is no "killed" state.
///
/// # Serialization
///
/// camelCase strings on the wire (`"running"`, `"paused"`, ...).
///
/// # Examples
///
/// ```
/// use swarm_core::worker::handle::WorkerState;
///
/// assert_eq!(WorkerState::Running.to_string(), "running");
/// ```
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WorkerState {
    /// Registered but not executing. The backend never produces this
    /// state today (a worker is `Running` from the moment it is
    /// registered); it stays in the wire enum because the frontend's
    /// `WorkerStateSchema` and older persisted `worker_state` rows
    /// carry it.
    Idle,
    /// The worker's process is running.
    Running,
    /// Suspended by the user. State-only on every platform: no
    /// `SIGSTOP`/`SIGCONT` (or Windows equivalent) reaches the process.
    Paused,
    /// Terminal: the worker's shell exited on its own (a clean `exit`,
    /// a crash, or a shell that died while starting). The worker stays
    /// registered, with its output and worktree intact, but accepts no
    /// more input or pause/resume; killing it removes it and cleans up
    /// its worktree.
    Error,
}

impl std::fmt::Display for WorkerState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Idle => "idle",
            Self::Running => "running",
            Self::Paused => "paused",
            Self::Error => "error",
        })
    }
}

/// Worktree isolation mode for a spawned worker.
///
/// # Serialization
///
/// `snake_case` strings on the wire (`"worktree"`, `"none"`); `Display`
/// renders the same strings.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkerIsolation {
    /// Spawn inside a fresh `git worktree` of [`WorkerConfig::repo_root`].
    /// The default; it only takes effect when `repo_root` is present.
    #[default]
    Worktree,
    /// No isolation: spawn directly at [`WorkerConfig::cwd`].
    None,
}

impl std::fmt::Display for WorkerIsolation {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Worktree => "worktree",
            Self::None => "none",
        })
    }
}

/// Default PTY height (24 rows, the classic terminal size).
const fn default_rows() -> u16 {
    24
}

/// Default PTY width (80 columns, the classic terminal size).
const fn default_cols() -> u16 {
    80
}

/// Configuration for spawning a new worker process.
///
/// Sent by the frontend with `spawn_worker`/`agent_spawn`. Every field
/// but `name` has a default.
///
/// # Serialization
///
/// camelCase field names on the wire.
///
/// # Examples
///
/// ```
/// use swarm_core::worker::handle::WorkerConfig;
///
/// let config = WorkerConfig::default();
/// assert_eq!((config.rows, config.cols), (24, 80));
/// assert!(config.repo_root.is_none());
/// ```
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerConfig {
    /// Display name for the worker.
    pub name: String,
    /// Shell program to run: a path or a name resolved on `PATH`, with
    /// no arguments (`"pwsh -NoLogo"` is not a program name). Empty
    /// selects the platform default shell (see
    /// [`crate::worker::pty::spawn_pty`]).
    #[serde(default)]
    pub shell: String,
    /// Initial working directory. Ignored when a worktree is created
    /// (`repo_root` present and `isolation` is `worktree`): the shell
    /// then starts in the new worktree.
    #[serde(default)]
    pub cwd: String,
    /// Environment variables added to the shell's inherited
    /// environment. Values may be credentials (per-profile API keys), so
    /// they are never logged — only the key count is.
    #[serde(default)]
    pub env: HashMap<String, String>,
    /// Initial PTY height in rows; resize later with `resize_worker`.
    #[serde(default = "default_rows")]
    pub rows: u16,
    /// Initial PTY width in columns; resize later with `resize_worker`.
    #[serde(default = "default_cols")]
    pub cols: u16,
    /// Root of the git repository to isolate this worker into. `None`
    /// (the default) spawns without touching git, at `cwd`.
    #[serde(default)]
    pub repo_root: Option<String>,
    /// Isolation mode, effective only when `repo_root` is present.
    #[serde(default)]
    pub isolation: WorkerIsolation,
}

impl Default for WorkerConfig {
    fn default() -> Self {
        Self {
            name: "Worker".to_owned(),
            shell: String::new(),
            cwd: String::new(),
            env: HashMap::new(),
            rows: default_rows(),
            cols: default_cols(),
            repo_root: None,
            isolation: WorkerIsolation::default(),
        }
    }
}

/// Serializable snapshot of a worker for IPC transport: the metadata
/// of a [`WorkerHandle`], without its PTY handles.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerInfo {
    /// Unique worker identifier (UUID v4).
    pub id: Uuid,
    /// Current lifecycle state.
    pub state: WorkerState,
    /// Human-readable display name.
    pub name: String,
    /// OS process ID of the worker's shell, if the OS reported one.
    pub pid: Option<u32>,
    /// Unix timestamp in **seconds** when the worker was spawned.
    pub started_at: i64,
    /// Absolute path of this worker's git worktree; `None` for an
    /// unisolated worker.
    #[serde(default)]
    pub worktree_path: Option<String>,
    /// Branch checked out in `worktree_path` (`swarm/<slug>-<id8>`);
    /// `None` for an unisolated worker.
    #[serde(default)]
    pub branch: Option<String>,
    /// Log `seq` the most recent successful ship pushed through; `None`
    /// until the first successful `git_push` for this worker.
    #[serde(default)]
    pub last_shipped_seq: Option<u64>,
    /// Commit sha of the most recent successful ship, mirroring
    /// `last_shipped_seq`.
    #[serde(default)]
    pub last_shipped_commit: Option<String>,
}

/// The shell a worker runs on its PTY, together with the PTY master it
/// is attached to.
///
/// Both live exactly as long as the worker. The master is the only
/// handle that can resize the terminal, and on Windows it owns the
/// pseudoconsole: dropping it calls `ClosePseudoConsole`, which tears
/// the console down under the shell. It must therefore outlive the
/// shell, and is released only after the kill path has reaped it (see
/// [`crate::worker::lifecycle::do_kill_worker`]).
pub struct PtyChild {
    /// The shell process. The worker's exit watcher holds a `Weak`
    /// reference and polls it with the non-blocking `try_wait`; the kill
    /// path locks it to `kill` and `wait`.
    pub process: Arc<Mutex<Box<dyn Child + Send + Sync>>>,
    /// Master side of the PTY. Shared (`Arc`) so a resize can clone it
    /// out of the registry and release the map's shard lock first.
    pub master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
}

/// Runtime handle to a live worker, stored in the
/// [`super::registry::WorkerRegistry`]'s map.
///
/// # Thread safety
///
/// The handle is `Send + Sync` because every non-`Sync` resource (the
/// PTY writer, master and child) sits behind a `parking_lot::Mutex`.
/// The compiler derives both traits (asserted at compile time below),
/// so adding a non-thread-safe field is a compile error rather than a
/// silently unsound handle.
pub struct WorkerHandle {
    /// Unique worker identifier (UUID v4).
    pub id: Uuid,
    /// Current lifecycle state.
    pub state: WorkerState,
    /// Human-readable display name.
    pub name: String,
    /// OS process ID of the worker's shell, if the OS reported one.
    pub pid: Option<u32>,
    /// Unix timestamp in **seconds** when the worker was spawned.
    pub started_at: i64,
    /// Input side of the worker's PTY. Shared (`Arc`) so a caller can
    /// clone it out of the registry and release the map's shard lock
    /// before writing: a write blocks while the child is not reading its
    /// stdin, and holding the shard lock across it would stall every
    /// other operation on that shard, including the kill that would
    /// unblock the write. `None` only for handles built without a PTY
    /// (tests).
    pub pty_writer: Option<Arc<Mutex<Box<dyn Write + Send>>>>,
    /// The worker's PTY process and master. `None` only for handles
    /// built without a PTY (tests).
    pub child: Option<PtyChild>,
    /// Absolute path of this worker's git worktree, if it was spawned
    /// with isolation.
    pub worktree_path: Option<String>,
    /// Root of the repository the worktree was created from, if
    /// isolated. The kill path runs `git -C <repo_root> worktree remove`
    /// from here, since the worktree itself is no valid `-C` target
    /// once removed.
    pub repo_root: Option<String>,
    /// Branch checked out in `worktree_path`, if isolated.
    pub branch: Option<String>,
    /// `HEAD` of `repo_root` the branch was created from, if isolated.
    /// Internal bookkeeping, never sent to the frontend: at kill time a
    /// branch whose tip still equals it (the worker made no commits) is
    /// deleted with `git branch -d`.
    pub base_commit: Option<String>,
    /// Log `seq` the most recent successful ship pushed through, if
    /// any. Written only by the ship chain, through
    /// [`super::registry::WorkerRegistry::set_last_shipped`].
    pub last_shipped_seq: Option<u64>,
    /// Commit sha of the most recent successful ship, mirroring
    /// `last_shipped_seq`.
    pub last_shipped_commit: Option<String>,
}

// Compile-time proof that the registry's map can be shared across
// threads; see the struct's "Thread safety" section.
const _: () = {
    const fn assert_send_sync<T: Send + Sync>() {}
    assert_send_sync::<WorkerHandle>();
};

impl std::fmt::Debug for WorkerHandle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WorkerHandle")
            .field("id", &self.id)
            .field("state", &self.state)
            .field("name", &self.name)
            .field("pid", &self.pid)
            .field("started_at", &self.started_at)
            .field("has_pty_writer", &self.pty_writer.is_some())
            .field("has_child", &self.child.is_some())
            .field("worktree_path", &self.worktree_path)
            .field("repo_root", &self.repo_root)
            .field("branch", &self.branch)
            .field("base_commit", &self.base_commit)
            .field("last_shipped_seq", &self.last_shipped_seq)
            .field("last_shipped_commit", &self.last_shipped_commit)
            .finish()
    }
}

impl WorkerHandle {
    /// Creates a serializable [`WorkerInfo`] snapshot of this worker.
    ///
    /// Copies every metadata field the frontend sees (everything but
    /// the PTY handles and the internal `repo_root`/`base_commit`).
    ///
    /// # Examples
    ///
    /// ```
    /// use swarm_core::worker::handle::{WorkerHandle, WorkerState};
    /// use uuid::Uuid;
    ///
    /// let handle = WorkerHandle {
    ///     id: Uuid::new_v4(),
    ///     state: WorkerState::Running,
    ///     name: "agent-1".to_owned(),
    ///     pid: Some(1234),
    ///     started_at: 1_700_000_000,
    ///     pty_writer: None,
    ///     child: None,
    ///     worktree_path: None,
    ///     repo_root: None,
    ///     branch: None,
    ///     base_commit: None,
    ///     last_shipped_seq: None,
    ///     last_shipped_commit: None,
    /// };
    /// assert_eq!(handle.to_info().name, "agent-1");
    /// ```
    pub fn to_info(&self) -> WorkerInfo {
        WorkerInfo {
            id: self.id,
            state: self.state,
            name: self.name.clone(),
            pid: self.pid,
            started_at: self.started_at,
            worktree_path: self.worktree_path.clone(),
            branch: self.branch.clone(),
            last_shipped_seq: self.last_shipped_seq,
            last_shipped_commit: self.last_shipped_commit.clone(),
        }
    }
}
