//! Ship chain: preflight, staged commit, and push for a worker's
//! worktree — the Rust half of "commit → push → prefilled compare
//! page".
//!
//! # Ownership split (Phase 0 contract)
//!
//! The worktree feature (`git::worktree`, `worker::lifecycle`) owns
//! worktree **creation**, **branch naming**, and **removal** — every
//! field on [`ShipWorktreeInfo`] except `last_shipped_seq`/
//! `last_shipped_commit` is set exactly once, at spawn time, by
//! `worker::lifecycle::do_spawn_worker`. Ship owns **commit** and
//! **push**, and is the *only* writer of `last_shipped_seq`/
//! `last_shipped_commit` (via [`crate::worker::registry::WorkerRegistry::set_last_shipped`]).
//! Ship never runs `git worktree add`/`remove`; the worktree feature
//! never runs `git add`/`commit`/`push`.
//!
//! There is no separate `WorktreeRegistry` type — the registry IS
//! [`crate::worker::registry::WorkerRegistry`] plus
//! [`crate::worker::handle::WorkerHandle`]. [`worktree_info_for_worker`]
//! is the thin, frozen accessor ship consumes instead of reaching into
//! `WorkerHandle`'s fields directly.
//!
//! `created_seq` is deliberately **not** part of this accessor: the
//! single-writer [`crate::orchestration::OrchestrationEngine`] assigns
//! a `seq` to `worktree_created` asynchronously, after `emit()`
//! returns, so `worker::lifecycle::do_spawn_worker` structurally
//! cannot know it at emit time. When [`stage_and_commit`] needs a
//! starting seq for a worker that has never shipped, its caller (the
//! `git_stage_commit` Tauri command, which *can* read the event log)
//! resolves it by scanning for that worker's `worktree_created` row —
//! see `commands/git.rs`.
//!
//! # Defense in depth: the primary-checkout guard
//!
//! [`preflight`] reports "primary checkout" (and five other
//! conditions) as non-fatal `blockers` so the UI can explain *why*
//! shipping is disabled. [`stage_and_commit`] and [`push`] do **not**
//! trust that a caller actually checked `canShip` first — each calls
//! [`guard_not_primary_checkout`] as its literal first statement,
//! before touching the working tree at all, so a stale preflight (or a
//! future caller that skips preflight entirely) can never turn into a
//! commit or push against the repo's primary checkout.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::RepoLocks;
use super::cli::{self, CREATE_TIMEOUT, READ_TIMEOUT};
use super::redact;
use super::remote;
use super::repo::base_args;
use crate::error::AppError;
use crate::worker::registry::{WorkerId, WorkerRegistry};

/// Secret/size deny list applied to every candidate file before
/// staging — see [`deny_reason`].
const MAX_STAGED_FILE_BYTES: u64 = 5 * 1024 * 1024;

// ── Errors ───────────────────────────────────────────────────────────

/// Typed ship error — a **documented divergence** from the rest of the
/// codebase's `Result<T, String>` IPC convention (see `AppError`'s
/// `Serialize` impl, which flattens to a display string). The Ship tab
/// UI needs to branch on `kind` (different second-click remedies for
/// "push was rejected" vs "not authenticated" vs "nothing changed"),
/// which a bare string can't carry, so this serializes as a structured
/// object instead: `{ "kind": "pushRejected", "message": "...",
/// "remedy": "fetchAndRebase" }`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShipError {
    pub kind: ShipErrorKind,
    pub message: String,
    pub remedy: Option<ShipRemedy>,
}

/// The full enumeration of ways a ship operation can fail. `NoUpstream`
/// is deliberately absent — an isolation branch has no upstream until
/// the first push, which is a normal *preflight state* (surfaced via
/// `ShipPreflight.upstream: null`), never an error.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ShipErrorKind {
    /// `workerId` does not resolve in the registry.
    WorkerNotFound,
    /// The worker resolved, but has no worktree (spawned unisolated) —
    /// ship requires worktree isolation.
    NoWorktree,
    /// The resolved worktree path is actually the repo's primary
    /// checkout (or can no longer be verified as a valid, distinct
    /// worktree at all) — see the module doc's defense-in-depth note.
    PrimaryCheckout,
    /// Detached `HEAD`, `branch == baseBranch`, or a protected branch
    /// (`main`/`master`/`develop`/`release/*`).
    InvalidBranch,
    /// No `origin` remote configured.
    NoRemote,
    /// The `origin` remote's host isn't one a GitHub-style compare URL
    /// can be built for.
    NonGitHubHost,
    /// Every candidate file was already committed, already skipped by
    /// the deny list, or there were no changes at all.
    NothingToCommit,
    /// `git commit` failed because `user.name`/`user.email` aren't set.
    IdentityMissing,
    /// `git commit` was rejected — most plausibly a pre-commit/commit-msg
    /// hook, since `--no-verify` is never constructible (see
    /// [`commit_args`]).
    HookFailed,
    /// `git push` was rejected as non-fast-forward — the remote branch
    /// has commits the local branch doesn't.
    PushRejected,
    /// `git push` failed on credentials — expired/missing auth.
    AuthExpired,
    /// The underlying git invocation exceeded its timeout budget.
    Timeout,
    /// Any git failure not otherwise classified. `message` carries the
    /// (already redacted) raw git stderr.
    Unknown,
}

/// A suggested next action for a [`ShipError`], surfaced by the UI as
/// the label on a second-click remedy button. `None` means "no
/// specific remedy — just report the message".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ShipRemedy {
    /// `git pull --rebase`, then ship again. **Never** an automatic
    /// `--force`/`--force-with-lease` push — seeDecisions in the ship
    /// plan: a worker's branch can be a human's branch.
    FetchAndRebase,
    /// Re-authenticate with the configured git credential helper.
    ReAuthenticate,
    /// Set `user.name`/`user.email` (locally or globally) before
    /// shipping.
    ConfigureIdentity,
}

impl ShipError {
    fn worker_not_found(id: Uuid) -> Self {
        ShipError {
            kind: ShipErrorKind::WorkerNotFound,
            message: format!("Worker `{id}` Not Found."),
            remedy: None,
        }
    }

    fn no_worktree(id: Uuid) -> Self {
        ShipError {
            kind: ShipErrorKind::NoWorktree,
            message: format!("Worker `{id}` Has No Worktree — Ship Requires Worktree Isolation."),
            remedy: None,
        }
    }
}

impl From<AppError> for ShipError {
    fn from(err: AppError) -> Self {
        let message = err.to_string();
        let kind = if message.contains("timed out") {
            ShipErrorKind::Timeout
        } else {
            ShipErrorKind::Unknown
        };
        ShipError {
            kind,
            message,
            remedy: None,
        }
    }
}

// ── Ship-facing accessor (Phase 0 contract) ─────────────────────────

/// Ship's frozen, read-only view over a worker's worktree — see the
/// module doc's ownership-split note.
#[derive(Debug, Clone)]
pub struct ShipWorktreeInfo {
    pub worker_id: Uuid,
    pub repo_root: PathBuf,
    pub worktree_path: PathBuf,
    pub branch: String,
    pub base_branch: String,
    pub base_commit: String,
    pub last_shipped_seq: Option<u64>,
    pub last_shipped_commit: Option<String>,
}

/// Resolves [`ShipWorktreeInfo`] for `id` from `registry`.
///
/// # Errors
///
/// * [`ShipErrorKind::WorkerNotFound`] — no worker with `id` exists.
/// * [`ShipErrorKind::NoWorktree`] — the worker exists but was spawned
///   without worktree isolation (no `repoRoot` given at spawn, or
///   `isolation: "none"`).
pub fn worktree_info_for_worker(
    registry: &WorkerRegistry,
    id: WorkerId,
) -> Result<ShipWorktreeInfo, ShipError> {
    let entry = registry
        .workers
        .get(&id)
        .ok_or_else(|| ShipError::worker_not_found(id))?;

    let worktree_path = entry
        .worktree_path
        .clone()
        .ok_or_else(|| ShipError::no_worktree(id))?;
    let repo_root = entry
        .repo_root
        .clone()
        .ok_or_else(|| ShipError::no_worktree(id))?;
    let branch = entry
        .branch
        .clone()
        .ok_or_else(|| ShipError::no_worktree(id))?;
    let base_commit = entry
        .base_commit
        .clone()
        .ok_or_else(|| ShipError::no_worktree(id))?;
    let last_shipped_seq = entry.last_shipped_seq;
    let last_shipped_commit = entry.last_shipped_commit.clone();

    let base_branch = resolve_base_branch(Path::new(&repo_root));

    Ok(ShipWorktreeInfo {
        worker_id: id,
        repo_root: PathBuf::from(repo_root),
        worktree_path: PathBuf::from(worktree_path),
        branch,
        base_branch,
        base_commit,
        last_shipped_seq,
        last_shipped_commit,
    })
}

/// Best-effort resolution of the "base branch" a worktree's isolation
/// branch forked from: the branch currently checked out in the
/// primary checkout (`repo_root`), which is where `HEAD` was read from
/// at worktree-creation time. `worker::lifecycle` records only the
/// base *commit* sha (not a branch name), so this is a live lookup,
/// not a stored field — falls back to `"main"` if `repo_root` is
/// itself detached or unreadable.
fn resolve_base_branch(repo_root: &Path) -> String {
    match current_branch(repo_root) {
        Ok(Some(branch)) => branch,
        _ => "main".to_string(),
    }
}

// ── git plumbing (all argv-vector, `-C`-scoped) ──────────────────────

fn run(worktree_path: &Path, args: &[&str], timeout: Duration) -> Result<cli::GitOutput, AppError> {
    let mut full = base_args(worktree_path);
    full.extend(args.iter().map(|s| s.to_string()));
    cli::run(&full, timeout)
}

fn resolve_relative(base: &Path, raw: &str) -> PathBuf {
    let path = Path::new(raw);
    let joined = if path.is_absolute() {
        path.to_path_buf()
    } else {
        base.join(path)
    };
    joined.canonicalize().unwrap_or(joined)
}

fn git_common_dir(worktree_path: &Path) -> Result<PathBuf, AppError> {
    let out = run(
        worktree_path,
        &["rev-parse", "--git-common-dir"],
        READ_TIMEOUT,
    )?;
    if !out.success() {
        return Err(AppError::Git(format!(
            "git rev-parse --git-common-dir failed: {}",
            out.stderr
        )));
    }
    Ok(resolve_relative(worktree_path, out.stdout.trim()))
}

fn git_dir(worktree_path: &Path) -> Result<PathBuf, AppError> {
    let out = run(worktree_path, &["rev-parse", "--git-dir"], READ_TIMEOUT)?;
    if !out.success() {
        return Err(AppError::Git(format!(
            "git rev-parse --git-dir failed: {}",
            out.stderr
        )));
    }
    Ok(resolve_relative(worktree_path, out.stdout.trim()))
}

/// `true` when `worktree_path` IS the repo's primary checkout — a
/// linked worktree's `--git-dir` (its own `.git/worktrees/<name>`
/// admin directory) always differs from `--git-common-dir` (the
/// shared, real `.git`); the primary checkout's are identical.
fn is_primary_checkout(worktree_path: &Path) -> Result<bool, AppError> {
    Ok(git_common_dir(worktree_path)? == git_dir(worktree_path)?)
}

/// `true` when `worktree_path` resolves (via `git rev-parse
/// --show-toplevel`, run from inside it) to itself — defense against
/// a `WorkerHandle.worktree_path` that has drifted to point at a
/// subdirectory, a deleted path, or anything other than a real,
/// standalone worktree root.
fn toplevel_matches(worktree_path: &Path) -> bool {
    match super::repo::discover_toplevel(worktree_path) {
        Ok(discovered) => {
            let discovered = discovered.canonicalize().unwrap_or(discovered);
            let expected = worktree_path
                .canonicalize()
                .unwrap_or_else(|_| worktree_path.to_path_buf());
            discovered == expected
        }
        Err(_) => false,
    }
}

/// The hard, pre-mutation guard both [`stage_and_commit`] and [`push`]
/// call as their literal first statement — see the module doc.
/// Any uncertainty (a git call itself failing) is treated as "assume
/// primary checkout" rather than "assume safe": an unverifiable
/// worktree blocks shipping, it never silently proceeds.
fn guard_not_primary_checkout(worktree_path: &Path) -> Result<(), ShipError> {
    if !toplevel_matches(worktree_path) {
        return Err(ShipError {
            kind: ShipErrorKind::PrimaryCheckout,
            message: "Refusing To Ship — This Path Is Not A Valid, Isolated Worktree.".to_string(),
            remedy: None,
        });
    }
    match is_primary_checkout(worktree_path) {
        Ok(false) => Ok(()),
        Ok(true) => Err(ShipError {
            kind: ShipErrorKind::PrimaryCheckout,
            message:
                "Refusing To Ship From The Primary Checkout — This Is Not A Worker's Isolated Worktree."
                    .to_string(),
            remedy: None,
        }),
        Err(_) => Err(ShipError {
            kind: ShipErrorKind::PrimaryCheckout,
            message: "Could Not Verify This Is An Isolated Worktree — Refusing To Ship.".to_string(),
            remedy: None,
        }),
    }
}

/// `-q` makes `symbolic-ref` exit silently (no stderr noise) rather
/// than print an error when `HEAD` is detached — the non-zero exit
/// alone is the detached-HEAD signal.
fn current_branch(worktree_path: &Path) -> Result<Option<String>, AppError> {
    let out = run(
        worktree_path,
        &["symbolic-ref", "-q", "--short", "HEAD"],
        READ_TIMEOUT,
    )?;
    if out.success() {
        let branch = out.stdout.trim();
        Ok(if branch.is_empty() {
            None
        } else {
            Some(branch.to_string())
        })
    } else {
        Ok(None)
    }
}

/// Protected branch names ship refuses to commit/push directly onto —
/// exact match for `main`/`master`/`develop`, glob for `release/*`.
fn is_protected_branch(branch: &str) -> bool {
    matches!(branch, "main" | "master" | "develop") || branch.starts_with("release/")
}

fn remote_url(worktree_path: &Path, remote_name: &str) -> Option<String> {
    let out = run(
        worktree_path,
        &["remote", "get-url", remote_name],
        READ_TIMEOUT,
    )
    .ok()?;
    if !out.success() {
        return None;
    }
    let url = out.stdout.trim();
    if url.is_empty() {
        None
    } else {
        Some(url.to_string())
    }
}

fn upstream_ref(worktree_path: &Path) -> Option<String> {
    let out = run(
        worktree_path,
        &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
        READ_TIMEOUT,
    )
    .ok()?;
    if !out.success() {
        return None;
    }
    let upstream = out.stdout.trim();
    if upstream.is_empty() {
        None
    } else {
        Some(upstream.to_string())
    }
}

/// `(ahead, behind)` of `HEAD` relative to `upstream`.
fn ahead_behind(worktree_path: &Path, upstream: &str) -> (u32, u32) {
    let spec = format!("{upstream}...HEAD");
    match run(
        worktree_path,
        &["rev-list", "--left-right", "--count", &spec],
        READ_TIMEOUT,
    ) {
        Ok(out) if out.success() => {
            let mut parts = out.stdout.split_whitespace();
            let behind = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
            let ahead = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
            (ahead, behind)
        }
        _ => (0, 0),
    }
}

// ── Working-tree status ──────────────────────────────────────────────

struct StatusEntry {
    index_status: char,
    worktree_status: char,
    path: String,
}

fn status_porcelain(worktree_path: &Path) -> Result<Vec<StatusEntry>, AppError> {
    let out = run(
        worktree_path,
        &["status", "--porcelain=v1", "--untracked-files=all"],
        READ_TIMEOUT,
    )?;
    if !out.success() {
        return Err(AppError::Git(format!("git status failed: {}", out.stderr)));
    }
    Ok(out.stdout.lines().filter_map(parse_status_line).collect())
}

/// Parses one `git status --porcelain=v1` line (`XY path` or, for a
/// rename, `XY old -> new`).
fn parse_status_line(line: &str) -> Option<StatusEntry> {
    if line.len() < 4 {
        return None;
    }
    let mut chars = line.chars();
    let index_status = chars.next()?;
    let worktree_status = chars.next()?;
    let rest = &line[3..];
    let path = match rest.find(" -> ") {
        Some(idx) => rest[idx + 4..].to_string(),
        None => rest.to_string(),
    };
    Some(StatusEntry {
        index_status,
        worktree_status,
        path,
    })
}

/// Splits parsed status entries into staged/unstaged/untracked path
/// lists. A partially-staged file (some hunks staged, some not)
/// appears in both `staged` and `unstaged`, matching `git status`'s
/// own two-column semantics.
fn classify_status(entries: &[StatusEntry]) -> (Vec<String>, Vec<String>, Vec<String>) {
    let mut staged = Vec::new();
    let mut unstaged = Vec::new();
    let mut untracked = Vec::new();
    for entry in entries {
        if entry.index_status == '?' && entry.worktree_status == '?' {
            untracked.push(entry.path.clone());
            continue;
        }
        if entry.index_status != ' ' {
            staged.push(entry.path.clone());
        }
        if entry.worktree_status != ' ' {
            unstaged.push(entry.path.clone());
        }
    }
    (staged, unstaged, untracked)
}

/// Deduplicated union of `staged`, `unstaged`, and `untracked`,
/// preserving first-seen order — the candidate set `mode: "all"`
/// (`git add -A`) would touch.
fn union_paths(staged: &[String], unstaged: &[String], untracked: &[String]) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for path in staged.iter().chain(unstaged.iter()).chain(untracked.iter()) {
        if seen.insert(path.clone()) {
            out.push(path.clone());
        }
    }
    out
}

// ── Secret/size deny list ────────────────────────────────────────────

/// A file the deny list catches, with its Title Case skip reason.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkippedFile {
    pub path: String,
    pub reason: String,
}

/// Whether `rel_path` should be skipped from staging — secret-shaped
/// filenames (`.env*`, `*.pem`, `*.key`, `id_rsa*`, `*secret*`,
/// case-insensitive) or larger than 5MB. Size is checked against the
/// file as it exists in `worktree_path` right now; a path with no
/// existing file (already deleted) can't be size-skipped, only
/// name-skipped.
fn deny_reason(worktree_path: &Path, rel_path: &str) -> Option<String> {
    let basename = Path::new(rel_path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(rel_path)
        .to_ascii_lowercase();

    let looks_like_credential = basename.starts_with(".env")
        || basename.ends_with(".pem")
        || basename.ends_with(".key")
        || basename.starts_with("id_rsa")
        || basename.contains("secret");
    if looks_like_credential {
        return Some("Skipped — Looks Like A Credential".to_string());
    }

    if let Ok(meta) = fs::metadata(worktree_path.join(rel_path))
        && meta.is_file()
        && meta.len() > MAX_STAGED_FILE_BYTES
    {
        return Some("Skipped — Larger Than 5 MB".to_string());
    }

    None
}

// ── Diff stat ─────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DiffStat {
    pub files_changed: u32,
    pub insertions: u32,
    pub deletions: u32,
}

/// Estimated diff stat for the preview, over already-deny-filtered
/// survivor paths: tracked survivors (staged/unstaged) via a single
/// `git diff --numstat HEAD` call; untracked survivors approximated by
/// counting lines in the file directly (skipped for binary/unreadable
/// content) rather than spawning a `diff --no-index` subprocess per
/// file.
fn preview_diff_stat(
    worktree_path: &Path,
    tracked_survivors: &[String],
    untracked_survivors: &[String],
) -> DiffStat {
    let mut stat = DiffStat::default();

    if !tracked_survivors.is_empty() {
        let mut args: Vec<&str> = vec!["diff", "--numstat", "HEAD", "--"];
        args.extend(tracked_survivors.iter().map(|s| s.as_str()));
        if let Ok(out) = run(worktree_path, &args, READ_TIMEOUT)
            && out.success()
        {
            accumulate_numstat(&out.stdout, &mut stat);
        }
    }

    for path in untracked_survivors {
        let full = worktree_path.join(path);
        if let Ok(contents) = fs::read(&full)
            && std::str::from_utf8(&contents).is_ok()
        {
            stat.files_changed += 1;
            stat.insertions += if contents.is_empty() {
                0
            } else {
                contents.iter().filter(|&&b| b == b'\n').count() as u32 + 1
            };
        }
    }

    stat
}

/// Parses `--numstat` output (`insertions\tdeletions\tpath` per line;
/// binary files report `-\t-\tpath`, silently skipped since they don't
/// contribute a meaningful line count) into `stat`.
fn accumulate_numstat(numstat: &str, stat: &mut DiffStat) {
    for line in numstat.lines() {
        let mut parts = line.splitn(3, '\t');
        let (Some(ins_raw), Some(del_raw)) = (parts.next(), parts.next()) else {
            continue;
        };
        stat.files_changed += 1;
        if let Ok(v) = ins_raw.parse::<u32>() {
            stat.insertions += v;
        }
        if let Ok(v) = del_raw.parse::<u32>() {
            stat.deletions += v;
        }
    }
}

/// Accurate diff stat for an already-made commit, via `git show
/// --numstat`.
fn commit_diff_stat(worktree_path: &Path, sha: &str) -> Result<DiffStat, AppError> {
    let out = run(
        worktree_path,
        &["show", "--numstat", "--format=", sha],
        READ_TIMEOUT,
    )?;
    if !out.success() {
        return Err(AppError::Git(format!(
            "git show --numstat failed for {sha}: {}",
            out.stderr
        )));
    }
    let mut stat = DiffStat::default();
    accumulate_numstat(&out.stdout, &mut stat);
    Ok(stat)
}

// ── gh capability probe (informational only in Phase 1) ─────────────

/// Runs `bin args...` with stdio suppressed and a short kill-on-timeout
/// budget, returning whether it exited successfully. Used only for the
/// `ghAvailable`/`ghAuthed` preflight fields — Phase 1 does not call
/// `gh` for anything else (PR creation is Phase 3).
fn command_succeeds_quickly(bin: &str, args: &[&str], timeout: Duration) -> bool {
    let mut command = Command::new(bin);
    command
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let Ok(mut child) = command.spawn() else {
        return false;
    };
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return status.success(),
            Ok(None) => {
                if start.elapsed() >= timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    return false;
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(_) => return false,
        }
    }
}

fn probe_gh_available() -> bool {
    command_succeeds_quickly("gh", &["--version"], Duration::from_secs(3))
}

fn probe_gh_authed() -> bool {
    command_succeeds_quickly("gh", &["auth", "status"], Duration::from_secs(3))
}

// ── Preflight ─────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShipPreflight {
    pub worker_id: Uuid,
    pub branch: String,
    pub base_branch: String,
    pub remote: Option<String>,
    pub host: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub staged: Vec<String>,
    pub unstaged: Vec<String>,
    pub untracked: Vec<String>,
    pub skipped: Vec<SkippedFile>,
    pub diff_stat: DiffStat,
    pub gh_available: bool,
    pub gh_authed: bool,
    pub can_ship: bool,
    pub blockers: Vec<String>,
}

/// Computes the full ship preflight for `id`: branch/remote/tracking
/// state, working-tree status, the deny-list preview, and the six
/// refusal conditions (toplevel mismatch, primary checkout, detached
/// `HEAD`, `branch == baseBranch`, protected branch, missing remote)
/// as Title Case `blockers` — `canShip` is `true` only when `blockers`
/// is empty. None of the six conditions make this function itself
/// fail; it always returns `Ok` once the worker/worktree resolve at
/// all (see the `Errors` section).
///
/// # Errors
///
/// * [`ShipErrorKind::WorkerNotFound`] / [`ShipErrorKind::NoWorktree`]
///   — same as [`worktree_info_for_worker`].
pub fn preflight(registry: &WorkerRegistry, id: WorkerId) -> Result<ShipPreflight, ShipError> {
    let info = worktree_info_for_worker(registry, id)?;
    let wt = info.worktree_path.as_path();

    let mut blockers = Vec::new();

    if !toplevel_matches(wt) {
        blockers.push(
            "Worktree Path Is No Longer A Valid Git Toplevel — It May Have Been Moved Or Deleted."
                .to_string(),
        );
    }
    if is_primary_checkout(wt).unwrap_or(true) {
        blockers.push(
            "Refusing To Ship From The Primary Checkout — This Is Not A Worker's Isolated Worktree."
                .to_string(),
        );
    }

    let branch_now = current_branch(wt).ok().flatten();
    if branch_now.is_none() {
        blockers.push("Worktree Is In A Detached HEAD State — Nothing To Ship From.".to_string());
    }
    let branch = branch_now.unwrap_or_else(|| info.branch.clone());

    if branch == info.base_branch {
        blockers.push(format!(
            "Branch `{branch}` Is The Same As The Base Branch — Nothing To Compare."
        ));
    }
    if is_protected_branch(&branch) {
        blockers.push(format!(
            "Branch `{branch}` Is Protected — Ship Refuses To Push Directly To It."
        ));
    }

    let remote_raw = remote_url(wt, "origin");
    if remote_raw.is_none() {
        blockers.push("No `origin` Remote Configured — Add One Before Shipping.".to_string());
    }
    let remote = remote_raw.as_deref().map(redact::redact);
    let parsed_remote = remote_raw.as_deref().and_then(remote::parse);
    let host = parsed_remote.as_ref().map(|r| r.host.clone());

    let upstream = upstream_ref(wt);
    let (ahead, behind) = match &upstream {
        Some(u) => ahead_behind(wt, u),
        None => (0, 0),
    };

    let entries = status_porcelain(wt).map_err(ShipError::from)?;
    let (staged, unstaged, untracked) = classify_status(&entries);
    let candidates = union_paths(&staged, &unstaged, &untracked);

    let mut skipped = Vec::new();
    for path in &candidates {
        if let Some(reason) = deny_reason(wt, path) {
            skipped.push(SkippedFile {
                path: path.clone(),
                reason,
            });
        }
    }
    let skipped_set: HashSet<&str> = skipped.iter().map(|s| s.path.as_str()).collect();

    let tracked_survivors: Vec<String> = union_paths(&staged, &unstaged, &[])
        .into_iter()
        .filter(|p| !skipped_set.contains(p.as_str()))
        .collect();
    let untracked_survivors: Vec<String> = untracked
        .iter()
        .filter(|p| !skipped_set.contains(p.as_str()))
        .cloned()
        .collect();
    let diff_stat = preview_diff_stat(wt, &tracked_survivors, &untracked_survivors);

    let gh_available = probe_gh_available();
    let gh_authed = gh_available && probe_gh_authed();

    let can_ship = blockers.is_empty();

    Ok(ShipPreflight {
        worker_id: id,
        branch,
        base_branch: info.base_branch,
        remote,
        host,
        upstream,
        ahead,
        behind,
        staged,
        unstaged,
        untracked,
        skipped,
        diff_stat,
        gh_available,
        gh_authed,
        can_ship,
        blockers,
    })
}

// ── Staging + commit ─────────────────────────────────────────────────

/// Staging strategy for [`stage_and_commit`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StagingMode {
    /// Stage every changed file (`git add -- <survivors>`, equivalent
    /// to `add -A` minus the deny list) — the default.
    All,
    /// Commit exactly what's already in the index; nothing new is
    /// staged. Offered when preflight detects a pre-staged index.
    Staged,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitOutcome {
    pub sha: String,
    pub files_changed: u32,
    pub insertions: u32,
    pub deletions: u32,
    pub seq_from: u64,
    pub seq_to: u64,
    pub skipped: Vec<SkippedFile>,
}

/// Argv for `git add -- <paths>` — always an explicit path list, never
/// `-A`/`--all` (the deny-list filtering happens in Rust, before this
/// is called, precisely so a denied path is never in `paths` to begin
/// with).
fn add_args_explicit(worktree_path: &Path, paths: &[String]) -> Vec<String> {
    let mut args = base_args(worktree_path);
    args.push("add".to_string());
    args.push("--".to_string());
    args.extend(paths.iter().cloned());
    args
}

/// Argv for `git commit -m <message>` — structurally incapable of
/// carrying `--no-verify`/`-n`: no code path in this module ever
/// pushes either token, pinned by
/// `tests::test_commit_args_never_contains_no_verify`.
fn commit_args(worktree_path: &Path, message: &str) -> Vec<String> {
    let mut args = base_args(worktree_path);
    args.push("commit".to_string());
    args.push("-m".to_string());
    args.push(message.to_string());
    args
}

/// Argv for `git push --set-upstream origin <branch>` — fixed shape,
/// structurally incapable of carrying `--force`/`-f`/`--force-with-lease`:
/// pinned by `tests::test_push_args_never_contains_force`.
fn push_args(worktree_path: &Path, branch: &str) -> Vec<String> {
    let mut args = base_args(worktree_path);
    args.push("push".to_string());
    args.push("--set-upstream".to_string());
    args.push("origin".to_string());
    args.push(branch.to_string());
    args
}

fn classify_commit_error(stderr: &str) -> ShipError {
    let lower = stderr.to_lowercase();
    if lower.contains("nothing to commit") {
        return ShipError {
            kind: ShipErrorKind::NothingToCommit,
            message: "Nothing To Commit — The Working Tree Matches HEAD.".to_string(),
            remedy: None,
        };
    }
    if lower.contains("please tell me who you are")
        || lower.contains("user.name")
        || lower.contains("user.email")
    {
        return ShipError {
            kind: ShipErrorKind::IdentityMissing,
            message:
                "Git Identity Not Configured — Set `user.name` And `user.email` Before Shipping."
                    .to_string(),
            remedy: Some(ShipRemedy::ConfigureIdentity),
        };
    }
    ShipError {
        kind: ShipErrorKind::HookFailed,
        message: format!("Commit Was Rejected: {stderr}"),
        remedy: None,
    }
}

/// Stages (per `mode`) and commits, appending `Swarm-Seq-Range:
/// <seqFrom>..<seqTo>` and (when `co_authored_by` is non-empty) a
/// `Co-Authored-By:` trailer to `message`.
///
/// Guarded by [`guard_not_primary_checkout`] as the literal first
/// statement — see the module doc. The two mutating git calls (`add`,
/// `commit`) each run under `repo_locks.run_serialized` — the same
/// per-repo serialization + one-retry-on-contention guarantee every
/// other mutating git operation in this codebase gets (see
/// `RepoLocks`'s doc); read-only calls (status, diff stat) don't need
/// it, matching `git::worktree`'s existing pattern of only wrapping
/// mutations.
///
/// # Errors
///
/// * [`ShipErrorKind::PrimaryCheckout`] — the pre-mutation guard fired.
/// * [`ShipErrorKind::NothingToCommit`] — every candidate file was
///   skipped by the deny list, or (mode `"staged"`) the index is
///   empty.
/// * [`ShipErrorKind::IdentityMissing`] / [`ShipErrorKind::HookFailed`]
///   — `git commit` itself failed; see [`classify_commit_error`].
#[allow(clippy::too_many_arguments)]
pub fn stage_and_commit(
    registry: &WorkerRegistry,
    repo_locks: &RepoLocks,
    id: WorkerId,
    message: &str,
    mode: StagingMode,
    seq_from: u64,
    seq_to: u64,
    co_authored_by: Option<&str>,
) -> Result<CommitOutcome, ShipError> {
    let info = worktree_info_for_worker(registry, id)?;
    let wt = info.worktree_path.as_path();
    let repo_root = info.repo_root.as_path();

    guard_not_primary_checkout(wt)?;

    let entries = status_porcelain(wt).map_err(ShipError::from)?;
    let (staged, unstaged, untracked) = classify_status(&entries);

    let skipped = match mode {
        StagingMode::All => {
            let candidates = union_paths(&staged, &unstaged, &untracked);
            let mut skipped = Vec::new();
            let mut survivors = Vec::new();
            for path in candidates {
                match deny_reason(wt, &path) {
                    Some(reason) => skipped.push(SkippedFile { path, reason }),
                    None => survivors.push(path),
                }
            }
            if !survivors.is_empty() {
                let args = add_args_explicit(wt, &survivors);
                let out = repo_locks
                    .run_serialized(repo_root, || cli::run(&args, CREATE_TIMEOUT))
                    .map_err(ShipError::from)?;
                if !out.success() {
                    return Err(ShipError {
                        kind: ShipErrorKind::Unknown,
                        message: format!("`git add` Failed: {}", out.stderr),
                        remedy: None,
                    });
                }
            }
            skipped
        }
        StagingMode::Staged => {
            // Trusts the caller's own `git add` for *what* gets
            // committed (un-staging something a human explicitly
            // staged would be surprising) — but still scans it, so a
            // secret staged by something other than SWARM is at least
            // reported, not silently committed unremarked.
            staged
                .iter()
                .filter_map(|path| {
                    deny_reason(wt, path).map(|reason| SkippedFile {
                        path: path.clone(),
                        reason,
                    })
                })
                .collect()
        }
    };

    let index_after = status_porcelain(wt).map_err(ShipError::from)?;
    let (staged_now, _, _) = classify_status(&index_after);
    if staged_now.is_empty() {
        return Err(ShipError {
            kind: ShipErrorKind::NothingToCommit,
            message: "Nothing To Commit — Every Changed File Was Skipped Or There Are No Changes."
                .to_string(),
            remedy: None,
        });
    }

    let mut trailers = vec![format!("Swarm-Seq-Range: {seq_from}..{seq_to}")];
    if let Some(co_author) = co_authored_by
        && !co_author.trim().is_empty()
    {
        trailers.push(format!("Co-Authored-By: {}", co_author.trim()));
    }
    let full_message = format!("{}\n\n{}", message.trim_end(), trailers.join("\n"));

    let args = commit_args(wt, &full_message);
    let out = repo_locks
        .run_serialized(repo_root, || cli::run(&args, CREATE_TIMEOUT))
        .map_err(ShipError::from)?;
    if !out.success() {
        return Err(classify_commit_error(&out.stderr));
    }

    let sha = super::repo::head_sha(wt).map_err(ShipError::from)?;
    let diff = commit_diff_stat(wt, &sha).unwrap_or_default();

    Ok(CommitOutcome {
        sha,
        files_changed: diff.files_changed,
        insertions: diff.insertions,
        deletions: diff.deletions,
        seq_from,
        seq_to,
        skipped,
    })
}

// ── Push ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PushOutcome {
    pub pushed_ref: String,
}

fn classify_push_error(stderr: &str) -> ShipError {
    let lower = stderr.to_lowercase();
    if lower.contains("rejected")
        && (lower.contains("non-fast-forward")
            || lower.contains("fetch first")
            || lower.contains("stale info"))
    {
        return ShipError {
            kind: ShipErrorKind::PushRejected,
            message:
                "Push Rejected — `origin` Has Commits You Don't Have. Fetch And Rebase, Then Ship Again."
                    .to_string(),
            remedy: Some(ShipRemedy::FetchAndRebase),
        };
    }
    if lower.contains("authentication failed")
        || lower.contains("could not read username")
        || lower.contains("could not read password")
        || lower.contains("terminal prompts disabled")
        || lower.contains("403")
        || lower.contains("permission denied")
        || lower.contains("access denied")
    {
        return ShipError {
            kind: ShipErrorKind::AuthExpired,
            message:
                "Authentication Failed — Re-Authenticate With Your Git Credential Helper And Ship Again."
                    .to_string(),
            remedy: Some(ShipRemedy::ReAuthenticate),
        };
    }
    ShipError {
        kind: ShipErrorKind::Unknown,
        message: format!("Push Failed: {stderr}"),
        remedy: None,
    }
}

/// Pushes `origin <branch>` with `--set-upstream` — fixed argv, never
/// force. Guarded by [`guard_not_primary_checkout`] as the literal
/// first statement. The push itself runs under
/// `repo_locks.run_serialized`, same as [`stage_and_commit`]'s
/// mutating calls.
///
/// # Errors
///
/// * [`ShipErrorKind::PrimaryCheckout`] — the pre-mutation guard fired.
/// * [`ShipErrorKind::NoRemote`] — no `origin` remote configured.
/// * [`ShipErrorKind::PushRejected`] / [`ShipErrorKind::AuthExpired`] /
///   [`ShipErrorKind::Timeout`] / [`ShipErrorKind::Unknown`] — the push
///   itself failed; see [`classify_push_error`].
pub fn push(
    registry: &WorkerRegistry,
    repo_locks: &RepoLocks,
    id: WorkerId,
) -> Result<PushOutcome, ShipError> {
    let info = worktree_info_for_worker(registry, id)?;
    let wt = info.worktree_path.as_path();
    let repo_root = info.repo_root.as_path();

    guard_not_primary_checkout(wt)?;

    if remote_url(wt, "origin").is_none() {
        return Err(ShipError {
            kind: ShipErrorKind::NoRemote,
            message: "No `origin` Remote Configured.".to_string(),
            remedy: None,
        });
    }

    let args = push_args(wt, &info.branch);
    let out = repo_locks
        .run_serialized(repo_root, || cli::run(&args, CREATE_TIMEOUT))
        .map_err(ShipError::from)?;
    if !out.success() {
        return Err(classify_push_error(&out.stderr));
    }

    Ok(PushOutcome {
        pushed_ref: format!("origin/{}", info.branch),
    })
}

// ── Compare URL ───────────────────────────────────────────────────────

/// Builds the GitHub-style compare URL for `id`'s worktree, prefilled
/// with `title`/`body` (capped per [`remote::MAX_COMPARE_URL_LEN`]).
///
/// # Errors
///
/// * [`ShipErrorKind::NoRemote`] — no `origin` remote configured.
/// * [`ShipErrorKind::NonGitHubHost`] — the remote's host isn't one a
///   GitHub-style compare URL applies to.
pub fn compare_url(
    registry: &WorkerRegistry,
    id: WorkerId,
    title: &str,
    body: &str,
) -> Result<String, ShipError> {
    let info = worktree_info_for_worker(registry, id)?;
    let wt = info.worktree_path.as_path();

    let raw_remote = remote_url(wt, "origin").ok_or_else(|| ShipError {
        kind: ShipErrorKind::NoRemote,
        message: "No `origin` Remote Configured.".to_string(),
        remedy: None,
    })?;
    let parsed = remote::parse(&raw_remote).ok_or_else(|| ShipError {
        kind: ShipErrorKind::NonGitHubHost,
        message: "Could Not Parse The `origin` Remote URL.".to_string(),
        remedy: None,
    })?;
    if !remote::looks_like_github_host(&parsed.host) {
        return Err(ShipError {
            kind: ShipErrorKind::NonGitHubHost,
            message: format!(
                "`{}` Doesn't Look Like A GitHub Host — Use Copy Push Command Instead.",
                parsed.host
            ),
            remedy: None,
        });
    }

    let branch = current_branch(wt).ok().flatten().unwrap_or(info.branch);
    Ok(remote::compare_url(
        &parsed,
        &info.base_branch,
        &branch,
        title,
        body,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::worker::handle::{WorkerHandle, WorkerState};

    // ── Argv builder unit tests (DIRECTIVE: no-force/no-noverify proof) ──

    #[test]
    fn test_commit_args_never_contains_no_verify() {
        let wt = PathBuf::from("/tmp/wt");
        let args = commit_args(&wt, "feat: thing");
        assert!(
            !args.iter().any(|a| a == "--no-verify" || a == "-n"),
            "commit_args must never construct --no-verify/-n: {args:?}"
        );
        assert_eq!(
            args,
            vec![
                "-C".to_string(),
                wt.display().to_string(),
                "-c".to_string(),
                "core.longpaths=true".to_string(),
                "commit".to_string(),
                "-m".to_string(),
                "feat: thing".to_string(),
            ]
        );
    }

    #[test]
    fn test_push_args_never_contains_force() {
        let wt = PathBuf::from("/tmp/wt");
        let args = push_args(&wt, "swarm/agent-abcd1234");
        assert!(
            !args
                .iter()
                .any(|a| a == "--force" || a == "-f" || a == "--force-with-lease"),
            "push_args must never construct a force token: {args:?}"
        );
        assert_eq!(
            args,
            vec![
                "-C".to_string(),
                wt.display().to_string(),
                "-c".to_string(),
                "core.longpaths=true".to_string(),
                "push".to_string(),
                "--set-upstream".to_string(),
                "origin".to_string(),
                "swarm/agent-abcd1234".to_string(),
            ]
        );
    }

    #[test]
    fn test_add_args_explicit_never_contains_dash_a_or_all() {
        let wt = PathBuf::from("/tmp/wt");
        let args = add_args_explicit(&wt, &["src/a.rs".to_string(), "src/b.rs".to_string()]);
        assert!(!args.iter().any(|a| a == "-A" || a == "--all"));
        assert!(args.contains(&"--".to_string()));
        assert!(args.contains(&"src/a.rs".to_string()));
    }

    #[test]
    fn test_every_ship_argv_builder_carries_dash_c() {
        let wt = PathBuf::from("/tmp/wt");
        for args in [
            add_args_explicit(&wt, &["x".to_string()]),
            commit_args(&wt, "m"),
            push_args(&wt, "b"),
        ] {
            assert_eq!(args[0], "-C");
            assert_eq!(args[1], wt.display().to_string());
        }
    }

    // ── Protected branch / deny-list unit tests ──────────────────────

    #[test]
    fn test_is_protected_branch() {
        assert!(is_protected_branch("main"));
        assert!(is_protected_branch("master"));
        assert!(is_protected_branch("develop"));
        assert!(is_protected_branch("release/1.0"));
        assert!(!is_protected_branch("swarm/agent-abcd1234"));
        assert!(!is_protected_branch("release")); // exact "release/*" glob, not the bare word
    }

    #[test]
    fn test_deny_reason_matches_credential_shaped_names() {
        let tmp = std::env::temp_dir().join(format!("swarm-deny-test-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&tmp).unwrap();
        for name in [
            ".env",
            ".env.local",
            "server.pem",
            "id_rsa",
            "id_rsa.pub",
            "MY_SECRET.txt",
        ] {
            assert!(
                deny_reason(&tmp, name).is_some(),
                "expected {name} to be denied"
            );
        }
        for name in ["README.md", "src/main.rs", "package.json"] {
            assert!(
                deny_reason(&tmp, name).is_none(),
                "expected {name} to survive the deny list"
            );
        }
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn test_deny_reason_matches_oversized_files() {
        let tmp = std::env::temp_dir().join(format!("swarm-deny-size-test-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&tmp).unwrap();
        let big = tmp.join("blob.bin");
        std::fs::write(&big, vec![0u8; (MAX_STAGED_FILE_BYTES + 1) as usize]).unwrap();
        let small = tmp.join("tiny.bin");
        std::fs::write(&small, vec![0u8; 10]).unwrap();

        assert_eq!(
            deny_reason(&tmp, "blob.bin").as_deref(),
            Some("Skipped — Larger Than 5 MB")
        );
        assert!(deny_reason(&tmp, "tiny.bin").is_none());

        std::fs::remove_dir_all(&tmp).ok();
    }

    // ── Error classification unit tests ──────────────────────────────

    #[test]
    fn test_classify_push_error_kinds() {
        assert_eq!(
            classify_push_error("! [rejected] main -> main (non-fast-forward)").kind,
            ShipErrorKind::PushRejected
        );
        assert_eq!(
            classify_push_error("fatal: Authentication failed for 'https://...'").kind,
            ShipErrorKind::AuthExpired
        );
        assert_eq!(
            classify_push_error(
                "fatal: could not read Username for 'https://...': terminal prompts disabled"
            )
            .kind,
            ShipErrorKind::AuthExpired
        );
        assert_eq!(
            classify_push_error("some entirely unrecognized failure").kind,
            ShipErrorKind::Unknown
        );
    }

    #[test]
    fn test_classify_commit_error_kinds() {
        assert_eq!(
            classify_commit_error("nothing to commit, working tree clean").kind,
            ShipErrorKind::NothingToCommit
        );
        assert_eq!(
            classify_commit_error(
                "*** Please tell me who you are.\n\nRun git config --global user.email ..."
            )
            .kind,
            ShipErrorKind::IdentityMissing
        );
        assert_eq!(
            classify_commit_error("husky - pre-commit hook exited with code 1 (error)").kind,
            ShipErrorKind::HookFailed
        );
    }

    #[test]
    fn test_ship_error_from_app_error_detects_timeout() {
        let err: ShipError =
            AppError::Git("git push origin main timed out after 120s".to_string()).into();
        assert_eq!(err.kind, ShipErrorKind::Timeout);
    }

    #[test]
    fn test_ship_error_from_app_error_defaults_unknown() {
        let err: ShipError = AppError::Git("fatal: something unexpected".to_string()).into();
        assert_eq!(err.kind, ShipErrorKind::Unknown);
    }

    // ── ShipError serialization (documented divergence from String) ──

    #[test]
    fn test_ship_error_serializes_as_structured_object_not_a_bare_string() {
        let err = ShipError {
            kind: ShipErrorKind::PushRejected,
            message: "Push Rejected".to_string(),
            remedy: Some(ShipRemedy::FetchAndRebase),
        };
        let json = serde_json::to_value(&err).unwrap();
        assert_eq!(json["kind"], "pushRejected");
        assert_eq!(json["message"], "Push Rejected");
        assert_eq!(json["remedy"], "fetchAndRebase");
    }

    // ── Status parsing ────────────────────────────────────────────────

    #[test]
    fn test_parse_status_line_and_classify() {
        let lines =
            "M  staged.rs\n M unstaged.rs\nMM both.rs\n?? new.rs\nR  old.rs -> renamed.rs\n";
        let entries: Vec<StatusEntry> = lines.lines().filter_map(parse_status_line).collect();
        let (staged, unstaged, untracked) = classify_status(&entries);
        assert!(staged.contains(&"staged.rs".to_string()));
        assert!(staged.contains(&"both.rs".to_string()));
        assert!(staged.contains(&"renamed.rs".to_string()));
        assert!(unstaged.contains(&"unstaged.rs".to_string()));
        assert!(unstaged.contains(&"both.rs".to_string()));
        assert!(untracked.contains(&"new.rs".to_string()));
        assert!(!untracked.contains(&"both.rs".to_string()));
    }

    #[test]
    fn test_union_paths_dedupes_and_preserves_order() {
        let staged = vec!["a.rs".to_string(), "b.rs".to_string()];
        let unstaged = vec!["b.rs".to_string(), "c.rs".to_string()];
        let untracked = vec!["d.rs".to_string()];
        let union = union_paths(&staged, &unstaged, &untracked);
        assert_eq!(union, vec!["a.rs", "b.rs", "c.rs", "d.rs"]);
    }

    // ── worktree_info_for_worker accessor ────────────────────────────

    fn make_isolated_handle(worktree_path: &str, repo_root: &str, branch: &str) -> WorkerHandle {
        WorkerHandle {
            id: Uuid::new_v4(),
            state: WorkerState::Running,
            name: "test".to_string(),
            pid: None,
            started_at: 0,
            pty_writer: None,
            child: None,
            worktree_path: Some(worktree_path.to_string()),
            repo_root: Some(repo_root.to_string()),
            branch: Some(branch.to_string()),
            base_commit: Some("deadbeef".to_string()),
            last_shipped_seq: None,
            last_shipped_commit: None,
        }
    }

    #[test]
    fn test_worktree_info_for_worker_not_found() {
        let registry = WorkerRegistry::new();
        let err = worktree_info_for_worker(&registry, Uuid::new_v4()).unwrap_err();
        assert_eq!(err.kind, ShipErrorKind::WorkerNotFound);
    }

    #[test]
    fn test_worktree_info_for_worker_no_worktree() {
        let registry = WorkerRegistry::new();
        let handle = WorkerHandle {
            id: Uuid::new_v4(),
            state: WorkerState::Running,
            name: "unisolated".to_string(),
            pid: None,
            started_at: 0,
            pty_writer: None,
            child: None,
            worktree_path: None,
            repo_root: None,
            branch: None,
            base_commit: None,
            last_shipped_seq: None,
            last_shipped_commit: None,
        };
        let id = handle.id;
        registry.spawn_worker(handle).unwrap();
        let err = worktree_info_for_worker(&registry, id).unwrap_err();
        assert_eq!(err.kind, ShipErrorKind::NoWorktree);
    }

    #[test]
    fn test_worktree_info_for_worker_carries_last_shipped() {
        let registry = WorkerRegistry::new();
        let mut handle = make_isolated_handle("/tmp/wt", "/tmp/repo", "swarm/x-abcd1234");
        handle.last_shipped_seq = Some(42);
        handle.last_shipped_commit = Some("cafef00d".to_string());
        let id = handle.id;
        registry.spawn_worker(handle).unwrap();

        let info = worktree_info_for_worker(&registry, id).unwrap();
        assert_eq!(info.last_shipped_seq, Some(42));
        assert_eq!(info.last_shipped_commit.as_deref(), Some("cafef00d"));
    }

    // ── Real-git integration tests ────────────────────────────────────

    fn run_setup(dir: &Path, args: &[&str]) {
        let mut full = base_args(dir);
        full.extend(args.iter().map(|s| s.to_string()));
        let out = cli::run(&full, CREATE_TIMEOUT).expect("git setup command should run");
        assert!(out.success(), "git setup failed: {} ({full:?})", out.stderr);
    }

    /// Sets up a disposable repo with one commit on `main`, returning
    /// its root path.
    fn setup_repo(tag: &str) -> PathBuf {
        let base = std::env::temp_dir().join(format!("swarm-ship-{tag}-{}", Uuid::new_v4()));
        let repo = base.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        run_setup(&repo, &["init", "-b", "main"]);
        run_setup(&repo, &["config", "user.email", "swarm-test@example.com"]);
        run_setup(&repo, &["config", "user.name", "Swarm Test"]);
        std::fs::write(repo.join("README.md"), "hello").unwrap();
        run_setup(&repo, &["add", "-A"]);
        run_setup(&repo, &["commit", "-m", "initial"]);
        repo
    }

    /// DIRECTIVE: PrimaryCheckout guard fires BEFORE any mutation.
    /// Points a fake `ShipWorktreeInfo` at the repo's own primary
    /// checkout (simulating a bug/attack where the accessor resolves
    /// to the wrong path) and asserts `stage_and_commit` refuses
    /// without ever touching the working tree — the repo stays exactly
    /// as clean afterward as it was before the call.
    #[tokio::test]
    async fn test_primary_checkout_guard_fires_before_any_mutation() {
        let repo = setup_repo("primary-guard");
        let registry = WorkerRegistry::new();
        let repo_locks = RepoLocks::new();
        // Deliberately mis-point `worktree_path` at the primary
        // checkout itself.
        let handle = make_isolated_handle(
            &repo.display().to_string(),
            &repo.display().to_string(),
            "main",
        );
        let id = handle.id;
        registry.spawn_worker(handle).unwrap();

        std::fs::write(repo.join("untracked.txt"), "should never be staged").unwrap();

        let result = stage_and_commit(
            &registry,
            &repo_locks,
            id,
            "feat: should never land",
            StagingMode::All,
            0,
            0,
            None,
        );
        let err = result.expect_err("expected a PrimaryCheckout refusal");
        assert_eq!(err.kind, ShipErrorKind::PrimaryCheckout);

        // No mutation: the untracked file is still untracked, nothing
        // is staged, HEAD hasn't moved.
        let status = status_porcelain(&repo).unwrap();
        let (staged, _, untracked) = classify_status(&status);
        assert!(staged.is_empty(), "guard must fire before any `git add`");
        assert!(untracked.contains(&"untracked.txt".to_string()));

        // push() gets the same guard.
        let push_result = push(&registry, &repo_locks, id);
        assert_eq!(
            push_result.unwrap_err().kind,
            ShipErrorKind::PrimaryCheckout
        );

        std::fs::remove_dir_all(repo.parent().unwrap()).ok();
    }

    /// Full no-network integration test: a temp repo, a `git init
    /// --bare` `file://` origin, a real linked worktree, a real
    /// `stage_and_commit`, and a real `push` — asserts the bare
    /// repo's branch actually advanced. No hardcoded shell/platform
    /// assumptions; `git` itself is the only external dependency,
    /// already required by every other test in this crate.
    #[tokio::test]
    async fn test_full_ship_cycle_advances_a_real_bare_remote() {
        let base = std::env::temp_dir().join(format!("swarm-ship-e2e-{}", Uuid::new_v4()));
        let bare = base.join("origin.git");
        let repo = base.join("repo");
        let worktree = base.join("wt");
        std::fs::create_dir_all(&bare).unwrap();
        std::fs::create_dir_all(&repo).unwrap();

        run_setup(&bare, &["init", "--bare", "-b", "main"]);

        run_setup(&repo, &["init", "-b", "main"]);
        run_setup(&repo, &["config", "user.email", "swarm-test@example.com"]);
        run_setup(&repo, &["config", "user.name", "Swarm Test"]);
        std::fs::write(repo.join("README.md"), "hello").unwrap();
        run_setup(&repo, &["add", "-A"]);
        run_setup(&repo, &["commit", "-m", "initial"]);
        run_setup(
            &repo,
            &["remote", "add", "origin", &bare.display().to_string()],
        );
        run_setup(&repo, &["push", "origin", "main"]);

        let head = super::super::repo::head_sha(&repo).unwrap();
        super::super::worktree::add(&repo, &worktree, "swarm/agent-abcd1234", &head).unwrap();

        // The worker's own work: a new file plus a secret-shaped file
        // that must survive as `skipped`, never reach the commit.
        std::fs::write(worktree.join("feature.txt"), "real work").unwrap();
        std::fs::write(worktree.join(".env"), "API_KEY=should-never-ship").unwrap();

        let registry = WorkerRegistry::new();
        let repo_locks = RepoLocks::new();
        let handle = make_isolated_handle(
            &worktree.display().to_string(),
            &repo.display().to_string(),
            "swarm/agent-abcd1234",
        );
        let id = handle.id;
        registry.spawn_worker(handle).unwrap();

        let outcome = stage_and_commit(
            &registry,
            &repo_locks,
            id,
            "feat: add feature file",
            StagingMode::All,
            0,
            1,
            Some("SWARM <noreply@example.com>"),
        )
        .expect("stage_and_commit should succeed");

        assert_eq!(outcome.skipped.len(), 1);
        assert_eq!(outcome.skipped[0].path, ".env");
        assert!(outcome.files_changed >= 1);

        let push_outcome = push(&registry, &repo_locks, id).expect("push should succeed");
        assert_eq!(push_outcome.pushed_ref, "origin/swarm/agent-abcd1234");

        // The bare "remote" repo's branch must have actually advanced
        // to the pushed commit — the true, no-mock proof.
        let bare_tip = super::super::repo::rev_parse(&bare, "swarm/agent-abcd1234").unwrap();
        assert_eq!(bare_tip, outcome.sha);

        // The secret file never reached the commit at all.
        let show = cli::run(
            &{
                let mut a = base_args(&repo);
                a.extend(
                    ["show", "--name-only", "--format=", &outcome.sha]
                        .iter()
                        .map(|s| s.to_string()),
                );
                a
            },
            READ_TIMEOUT,
        )
        .unwrap();
        assert!(!show.stdout.contains(".env"));

        std::fs::remove_dir_all(&base).ok();
    }

    /// DIRECTIVE: secret-guard outcome — a `.env` file and an
    /// oversized blob are both skipped, neither is committed.
    #[tokio::test]
    async fn test_secret_and_size_guard_neither_file_is_committed() {
        let repo = setup_repo("secret-guard");
        let worktree = repo.parent().unwrap().join("wt");
        let head = super::super::repo::head_sha(&repo).unwrap();
        super::super::worktree::add(&repo, &worktree, "swarm/guard-test-abcd1234", &head).unwrap();

        std::fs::write(
            worktree.join("id_rsa"),
            "-----BEGIN OPENSSH PRIVATE KEY-----",
        )
        .unwrap();
        std::fs::write(
            worktree.join("blob.bin"),
            vec![0u8; (MAX_STAGED_FILE_BYTES + 1024) as usize],
        )
        .unwrap();
        std::fs::write(worktree.join("safe.txt"), "totally fine").unwrap();

        let registry = WorkerRegistry::new();
        let repo_locks = RepoLocks::new();
        let handle = make_isolated_handle(
            &worktree.display().to_string(),
            &repo.display().to_string(),
            "swarm/guard-test-abcd1234",
        );
        let id = handle.id;
        registry.spawn_worker(handle).unwrap();

        let outcome = stage_and_commit(
            &registry,
            &repo_locks,
            id,
            "chore: add safe file",
            StagingMode::All,
            0,
            1,
            None,
        )
        .expect("commit of the surviving file should succeed");

        let skipped_paths: Vec<&str> = outcome.skipped.iter().map(|s| s.path.as_str()).collect();
        assert!(skipped_paths.contains(&"id_rsa"));
        assert!(skipped_paths.contains(&"blob.bin"));
        assert!(!skipped_paths.contains(&"safe.txt"));

        let show = cli::run(
            &{
                let mut a = base_args(&repo);
                a.extend(
                    ["show", "--name-only", "--format=", &outcome.sha]
                        .iter()
                        .map(|s| s.to_string()),
                );
                a
            },
            READ_TIMEOUT,
        )
        .unwrap();
        assert!(!show.stdout.contains("id_rsa"));
        assert!(!show.stdout.contains("blob.bin"));
        assert!(show.stdout.contains("safe.txt"));

        std::fs::remove_dir_all(repo.parent().unwrap()).ok();
    }

    #[test]
    fn test_current_branch_detects_detached_head() {
        let repo = setup_repo("detached");
        let head = super::super::repo::head_sha(&repo).unwrap();
        run_setup(&repo, &["checkout", "--detach", &head]);
        assert_eq!(current_branch(&repo).unwrap(), None);
        std::fs::remove_dir_all(repo.parent().unwrap()).ok();
    }

    #[test]
    fn test_is_primary_checkout_true_for_repo_root_false_for_linked_worktree() {
        let repo = setup_repo("primary-vs-linked");
        assert!(is_primary_checkout(&repo).unwrap());

        let worktree = repo.parent().unwrap().join("linked");
        let head = super::super::repo::head_sha(&repo).unwrap();
        super::super::worktree::add(&repo, &worktree, "swarm/linked-abcd1234", &head).unwrap();
        assert!(!is_primary_checkout(&worktree).unwrap());

        std::fs::remove_dir_all(repo.parent().unwrap()).ok();
    }

    #[test]
    fn test_preflight_reports_blockers_for_primary_checkout_and_protected_branch() {
        let repo = setup_repo("preflight-blockers");
        let registry = WorkerRegistry::new();
        // main is both the current branch AND the base branch here, and
        // this points at the primary checkout — three of the six
        // refusal conditions fire at once.
        let handle = make_isolated_handle(
            &repo.display().to_string(),
            &repo.display().to_string(),
            "main",
        );
        let id = handle.id;
        registry.spawn_worker(handle).unwrap();

        let result = preflight(&registry, id).expect("preflight itself must not error");
        assert!(!result.can_ship);
        assert!(
            result
                .blockers
                .iter()
                .any(|b| b.contains("Primary Checkout"))
        );
        assert!(result.blockers.iter().any(|b| b.contains("Protected")));
        assert!(result.blockers.iter().any(|b| b.contains("Base Branch")));

        std::fs::remove_dir_all(repo.parent().unwrap()).ok();
    }

    #[test]
    fn test_preflight_can_ship_true_for_a_healthy_isolated_worktree() {
        let repo = setup_repo("preflight-healthy");
        let worktree = repo.parent().unwrap().join("wt");
        let head = super::super::repo::head_sha(&repo).unwrap();
        super::super::worktree::add(&repo, &worktree, "swarm/healthy-abcd1234", &head).unwrap();
        run_setup(
            &repo,
            &[
                "remote",
                "add",
                "origin",
                "https://github.com/example/repo.git",
            ],
        );

        let registry = WorkerRegistry::new();
        let handle = make_isolated_handle(
            &worktree.display().to_string(),
            &repo.display().to_string(),
            "swarm/healthy-abcd1234",
        );
        let id = handle.id;
        registry.spawn_worker(handle).unwrap();

        let result = preflight(&registry, id).unwrap();
        assert!(result.can_ship, "blockers: {:?}", result.blockers);
        assert_eq!(result.base_branch, "main");
        assert_eq!(result.host.as_deref(), Some("github.com"));

        std::fs::remove_dir_all(repo.parent().unwrap()).ok();
    }
}
