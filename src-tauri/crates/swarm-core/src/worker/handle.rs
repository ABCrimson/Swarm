//! Worker handle types, state machine, and configuration.
//!
//! Defines the core data structures for representing a worker
//! instance in the SWARM Orchestrator: its state, configuration
//! for spawning, serializable info snapshot, and the runtime handle
//! containing PTY communication channels.

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::io::Write;
use uuid::Uuid;

/// Represents the current state of a worker in its lifecycle.
///
/// Workers transition through these states:
/// ```text
/// Idle ──> Running ──> Paused ──> Running ──> ...
///                  └──> Error
/// ```
///
/// # Serialization
///
/// Serialized as camelCase strings for Tauri IPC transport
/// (e.g., `"running"`, `"paused"`).
///
/// # Examples
///
/// ```
/// use swarm_core::worker::handle::WorkerState;
///
/// let state = WorkerState::Running;
/// assert_eq!(state.to_string(), "running");
/// ```
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WorkerState {
    /// Worker is registered but not yet executing.
    Idle,
    /// Worker process is actively running.
    Running,
    /// Worker process is suspended. This is state-only on all
    /// platforms today — no `SIGSTOP`/`SIGCONT` (or Windows
    /// equivalent) is sent to the underlying process yet.
    Paused,
    /// Worker encountered a fatal error.
    Error,
}

impl std::fmt::Display for WorkerState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            WorkerState::Idle => write!(f, "idle"),
            WorkerState::Running => write!(f, "running"),
            WorkerState::Paused => write!(f, "paused"),
            WorkerState::Error => write!(f, "error"),
        }
    }
}

/// Worktree isolation mode for a spawned worker.
///
/// # Serialization
///
/// Serialized as lowercase `snake_case` strings for Tauri IPC
/// transport (`"worktree"`, `"none"`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkerIsolation {
    /// Spawn inside a fresh `git worktree` rooted at `WorkerConfig::repo_root`.
    /// The default when `repo_root` is present.
    Worktree,
    /// No isolation — spawn directly at `WorkerConfig::cwd`, exactly
    /// today's (pre-worktree-isolation) behavior.
    None,
}

impl std::fmt::Display for WorkerIsolation {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            WorkerIsolation::Worktree => write!(f, "worktree"),
            WorkerIsolation::None => write!(f, "none"),
        }
    }
}

/// Default isolation mode: `worktree`. Only takes effect when
/// [`WorkerConfig::repo_root`] is also present — a worker with no
/// `repo_root` spawns exactly as it did before worktree isolation
/// existed, regardless of this field.
fn default_isolation() -> WorkerIsolation {
    WorkerIsolation::Worktree
}

/// Configuration for spawning a new worker process.
///
/// Passed from the frontend via Tauri IPC when the user
/// requests a new worker. All fields have sensible defaults.
///
/// # Serialization
///
/// Uses camelCase field names for Tauri IPC transport.
///
/// # Examples
///
/// ```
/// use swarm_core::worker::handle::WorkerConfig;
///
/// let config = WorkerConfig::default();
/// assert_eq!(config.rows, 24);
/// assert_eq!(config.cols, 80);
/// assert!(config.repo_root.is_none());
/// ```
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerConfig {
    /// Display name for the worker.
    pub name: String,
    /// Shell command to execute (defaults to system shell if empty).
    #[serde(default)]
    pub shell: String,
    /// Initial working directory. Ignored when a worktree is actually
    /// created (`repo_root` present and `isolation` resolves to
    /// `worktree`) — the PTY's cwd becomes the new worktree path
    /// instead.
    #[serde(default)]
    pub cwd: String,
    /// Environment variables to set.
    #[serde(default)]
    pub env: std::collections::HashMap<String, String>,
    /// Number of rows for PTY.
    #[serde(default = "default_rows")]
    pub rows: u16,
    /// Number of columns for PTY.
    #[serde(default = "default_cols")]
    pub cols: u16,
    /// Root of the git repository to isolate this worker into. `None`
    /// (the default) reproduces exactly today's (pre-worktree-isolation)
    /// spawn behavior — no git anywhere, PTY cwd is `cwd` as given.
    #[serde(default)]
    pub repo_root: Option<String>,
    /// Isolation mode, effective only when `repo_root` is present.
    #[serde(default = "default_isolation")]
    pub isolation: WorkerIsolation,
}

/// Default PTY row count (24 rows, standard terminal height).
fn default_rows() -> u16 {
    24
}

/// Default PTY column count (80 columns, standard terminal width).
fn default_cols() -> u16 {
    80
}

impl Default for WorkerConfig {
    fn default() -> Self {
        Self {
            name: "Worker".to_string(),
            shell: String::new(),
            cwd: String::new(),
            env: std::collections::HashMap::new(),
            rows: default_rows(),
            cols: default_cols(),
            repo_root: None,
            isolation: default_isolation(),
        }
    }
}

/// Serializable summary of a worker for IPC transport.
///
/// A lightweight, `Clone`-able snapshot of a worker's metadata
/// that can be sent to the frontend. Does not contain PTY handles
/// or process references.
///
/// # Fields
///
/// * `id` - Unique worker identifier (UUID v4)
/// * `state` - Current lifecycle state
/// * `name` - Human-readable display name
/// * `pid` - OS process ID (if available)
/// * `started_at` - Unix timestamp (seconds) when the worker was spawned
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerInfo {
    /// Unique worker identifier.
    pub id: Uuid,
    /// Current lifecycle state.
    pub state: WorkerState,
    /// Human-readable display name.
    pub name: String,
    /// OS process ID of the PTY child, if available.
    pub pid: Option<u32>,
    /// Unix timestamp (seconds) when the worker was spawned.
    pub started_at: i64,
    /// Absolute path of this worker's git worktree, if it was spawned
    /// with isolation. `None` for an unisolated worker.
    #[serde(default)]
    pub worktree_path: Option<String>,
    /// Branch name checked out in `worktree_path` (`swarm/<slug>-<id8>`),
    /// if this worker was spawned with isolation. `None` for an
    /// unisolated worker.
    #[serde(default)]
    pub branch: Option<String>,
    /// Log `seq` the most recent successful ship pushed through, if
    /// any. `None` until the first successful `git_push` for this
    /// worker.
    #[serde(default)]
    pub last_shipped_seq: Option<u64>,
    /// Commit sha of the most recent successful ship, mirroring
    /// `last_shipped_seq`.
    #[serde(default)]
    pub last_shipped_commit: Option<String>,
}

/// Runtime handle to a running worker instance.
///
/// Contains all metadata and communication channels for interacting
/// with the worker's PTY process. Stored in the [`super::registry::WorkerRegistry`]
/// `DashMap`.
///
/// The PTY writer and child process handle are wrapped in
/// `parking_lot::Mutex` to satisfy `Sync` requirements for
/// DashMap storage, since `dyn Write + Send` and
/// `dyn portable_pty::Child + Send` are not inherently `Sync`.
///
/// # Thread Safety
///
/// All non-`Sync` fields are wrapped in `parking_lot::Mutex`,
/// making the entire struct safe for concurrent access. An
/// `unsafe impl Sync` is provided with this invariant documented.
pub struct WorkerHandle {
    /// Unique worker identifier (UUID v4).
    pub id: Uuid,
    /// Current lifecycle state of this worker.
    pub state: WorkerState,
    /// Human-readable display name.
    pub name: String,
    /// OS process ID of the PTY child, if available.
    pub pid: Option<u32>,
    /// Unix timestamp (seconds) when the worker was spawned.
    pub started_at: i64,
    /// PTY writer for sending input to the worker process.
    /// Wrapped in Mutex because `dyn Write + Send` is not Sync.
    pub pty_writer: Option<Mutex<Box<dyn Write + Send>>>,
    /// Handle to the child process (for kill/signal).
    /// Wrapped in Mutex because `dyn Child + Send` is not Sync.
    pub child: Option<Mutex<Box<dyn portable_pty::Child + Send>>>,
    /// Absolute path of this worker's git worktree, if it was spawned
    /// with isolation (`repo_root` present, resolved `isolation ==
    /// worktree`, and worktree creation succeeded).
    pub worktree_path: Option<String>,
    /// Root of the git repository this worker's worktree was created
    /// from, if isolated. Needed at kill time to run `git -C
    /// <repo_root> worktree remove` — the worktree's own directory is
    /// not itself a valid `-C` target once removed.
    pub repo_root: Option<String>,
    /// Branch checked out in `worktree_path`, if isolated.
    pub branch: Option<String>,
    /// Commit sha `branch` was created from (`HEAD` of `repo_root` at
    /// spawn time), if isolated. Compared against the branch's tip at
    /// kill time to decide whether the isolation branch can be safely
    /// `git branch -d`'d (tip == base_commit means the agent made no
    /// commits) — never exposed to the frontend, purely an internal
    /// bookkeeping field for that one decision.
    pub base_commit: Option<String>,
    /// Log `seq` the most recent successful ship pushed through, if
    /// any. Written **only** by the ship chain
    /// (`swarm_core::git::ship`) via
    /// [`super::registry::WorkerRegistry::set_last_shipped`] — every
    /// other field on this struct is owned by the worktree feature.
    /// `None` until the first successful `git_push` for this worker.
    pub last_shipped_seq: Option<u64>,
    /// Commit sha of the most recent successful ship, mirroring
    /// `last_shipped_seq`.
    pub last_shipped_commit: Option<String>,
}

// SAFETY: All non-Sync fields are wrapped in parking_lot::Mutex,
// which provides Sync. The remaining fields are all Sync.
unsafe impl Sync for WorkerHandle {}

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
            .field("branch", &self.branch)
            .field("base_commit", &self.base_commit)
            .field("last_shipped_seq", &self.last_shipped_seq)
            .finish()
    }
}

impl WorkerHandle {
    /// Creates a serializable [`WorkerInfo`] snapshot of this worker.
    ///
    /// Clones only the lightweight metadata fields, omitting the
    /// PTY writer and child process handle.
    ///
    /// # Returns
    ///
    /// A [`WorkerInfo`] containing the worker's ID, state, name, PID,
    /// and start timestamp.
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
    ///     name: "agent-1".to_string(),
    ///     pid: Some(1234),
    ///     started_at: 1700000000,
    ///     pty_writer: None,
    ///     child: None,
    ///     worktree_path: None,
    ///     repo_root: None,
    ///     branch: None,
    ///     base_commit: None,
    ///     last_shipped_seq: None,
    ///     last_shipped_commit: None,
    /// };
    /// let info = handle.to_info();
    /// assert_eq!(info.name, "agent-1");
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
