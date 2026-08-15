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
/// branch forked from. `worker::lifecycle` records only the base
/// *commit* sha (not a branch name), so this is always a live lookup,
/// not a stored field. **Deliberately never** the primary checkout's
/// current `HEAD` — a human can check out any branch in the primary
/// checkout at any time, which has nothing to do with what the
/// worktree's isolation branch actually forked from. Resolution order:
///
/// 1. `git symbolic-ref --short refs/remotes/origin/HEAD`, stripped of
///    its `origin/` prefix — what the remote itself considers its
///    default branch (set by `git remote set-head origin -a`, or
///    automatically on a normal `git clone`).
/// 2. The repo's local `init.defaultBranch` config value.
/// 3. The literal fallback `"main"`.
fn resolve_base_branch(repo_root: &Path) -> String {
    choose_base_branch(
        origin_head_branch(repo_root),
        configured_default_branch(repo_root),
    )
}

/// The pure resolution-order decision, extracted from the git-plumbing
/// calls so it's unit-testable independent of the host machine's own
/// global git config (which may or may not have `init.defaultBranch`
/// set — a fully-git-plumbing round trip for the "neither is set, fall
/// back to the main literal" case would be flaky on a machine that
/// *does* have a global default configured).
fn choose_base_branch(origin_head: Option<String>, configured_default: Option<String>) -> String {
    origin_head
        .or(configured_default)
        .unwrap_or_else(|| "main".to_string())
}

fn origin_head_branch(repo_root: &Path) -> Option<String> {
    let out = run(
        repo_root,
        &["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
        READ_TIMEOUT,
    )
    .ok()?;
    if !out.success() {
        return None;
    }
    let raw = out.stdout.trim();
    if raw.is_empty() {
        return None;
    }
    Some(raw.strip_prefix("origin/").unwrap_or(raw).to_string())
}

fn configured_default_branch(repo_root: &Path) -> Option<String> {
    let out = run(
        repo_root,
        &["config", "--get", "init.defaultBranch"],
        READ_TIMEOUT,
    )
    .ok()?;
    if !out.success() {
        return None;
    }
    let raw = out.stdout.trim();
    if raw.is_empty() {
        None
    } else {
        Some(raw.to_string())
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

/// Resolves the branch **currently** checked out in `worktree_path`,
/// hard-failing (never silently falling back to a possibly-stale
/// stored `WorkerHandle.branch`) on a detached `HEAD` or an unreadable
/// ref. Used by every action that actually *acts* on the branch
/// (`push`, `compare_url`) so there is exactly one live resolution per
/// action — never a stored-vs-live skew between what preflight showed
/// and what push/compare actually operate on. `preflight` calls the
/// same underlying [`current_branch`] but degrades to a `blockers`
/// entry instead of a hard error, since preflight must never fail
/// merely because the tree is momentarily detached.
fn resolve_live_branch(worktree_path: &Path) -> Result<String, ShipError> {
    match current_branch(worktree_path) {
        Ok(Some(branch)) => Ok(branch),
        Ok(None) => Err(ShipError {
            kind: ShipErrorKind::InvalidBranch,
            message: "Worktree Is In A Detached HEAD State — Nothing To Ship From.".to_string(),
            remedy: None,
        }),
        Err(e) => Err(ShipError::from(e)),
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

/// Fallback `ahead` count for a branch with no upstream yet (a
/// never-pushed isolation branch — the overwhelmingly common case the
/// very first time a worker ships): commits reachable from `HEAD` but
/// not from `base_commit`. `behind` has no meaningful value here
/// (there is no upstream to be behind), so callers pair this with `0`.
fn ahead_since_base(worktree_path: &Path, base_commit: &str) -> u32 {
    let spec = format!("{base_commit}..HEAD");
    match run(worktree_path, &["rev-list", "--count", &spec], READ_TIMEOUT) {
        Ok(out) if out.success() => out.stdout.trim().parse().unwrap_or(0),
        _ => 0,
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

/// `true` when `rel_path`'s basename is `settings.json` and some
/// component of its path is literally `.claude` — matches both the
/// worktree root (`.claude/settings.json`) and any nested occurrence
/// (`worker/.claude/settings.json`). A pure path-shape check, no
/// filesystem access — see [`deny_reason`]'s untracked-only gating for
/// why matching the shape alone is not sufficient to deny a path.
fn is_claude_settings_json(rel_path: &str) -> bool {
    let path = Path::new(rel_path);
    path.file_name().and_then(|n| n.to_str()) == Some("settings.json")
        && path.components().any(|c| c.as_os_str() == ".claude")
}

/// Whether `rel_path` should be skipped from staging — secret-shaped
/// filenames (`.env*`, `*.pem`, `*.key`, `id_rsa*`, case-insensitive,
/// matched against the basename) or a `secret` substring anywhere in
/// the full relative path (case-insensitive — deliberately **not**
/// basename-only, so a nested `config/secrets/api.yaml` is caught even
/// though its own filename looks innocuous), or larger than 5MB. Size
/// is checked against the file as it exists in `worktree_path` right
/// now; a path with no existing file (already deleted) can't be
/// size-skipped, only name-skipped.
///
/// # Defense in depth: untracked `.claude/settings.json`
///
/// Nothing writes `.claude/settings.json` into a worker's worktree
/// anymore (PR #11 removed that) — so an UNTRACKED copy (`is_untracked`,
/// derived from a `git status` `??` entry — see this function's
/// callers) can only be stray droppings from an older build or an
/// out-of-band write, never something the user or SWARM itself is
/// intentionally tracking. It is always denied, regardless of the
/// credential/size heuristics below.
///
/// A TRACKED `.claude/settings.json` (already committed, or staged —
/// `is_untracked == false`) is a different story: it is the user's own
/// pre-existing file, and whether to ship it is the user's call, same
/// as any other tracked file. This function never denies a tracked copy
/// on that basis alone.
///
/// **Honest scope (review NIT-3):** `is_untracked` reflects the
/// `git status` snapshot taken at the moment [`preflight`] or
/// [`stage_and_commit`] runs its own [`status_porcelain`] call — this
/// is a point-in-time check, not a standing guarantee. If something
/// (a human, or the worker's own agent shelling out inside its
/// worktree) runs `git add -A`/`git add .claude/settings.json` BEFORE
/// that call, the file is already staged by the time this function
/// ever sees it, `is_untracked` is `false`, and `mode: "all"` ships it
/// like any other staged file — the deny only ever fires for a file
/// this specific ship attempt would otherwise have picked up as an
/// untracked survivor itself. This is a deliberate tradeoff, not an
/// oversight: catching every possible prior-staging path would mean
/// denying tracked files unconditionally, which would override a
/// user's or agent's own explicit intent to commit a file they just
/// staged — the one case this defense is explicitly NOT meant to
/// override (see the tracked-copy paragraph above).
fn deny_reason(worktree_path: &Path, rel_path: &str, is_untracked: bool) -> Option<String> {
    if is_untracked && is_claude_settings_json(rel_path) {
        return Some("Skipped — SWARM Configuration File".to_string());
    }

    let full_path_lower = rel_path.to_ascii_lowercase();
    let basename = Path::new(rel_path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(rel_path)
        .to_ascii_lowercase();

    let looks_like_credential = basename.starts_with(".env")
        || basename.ends_with(".pem")
        || basename.ends_with(".key")
        || basename.starts_with("id_rsa")
        || full_path_lower.contains("secret");
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

// ── gh capability probe (reserved for Phase 3 — NOT called from Phase 1) ──
//
// Phase 1 never acts on `gh` availability (PR creation is Phase 3), so
// none of the three items below are wired into `preflight` — they are
// kept, `#[allow(dead_code)]`, as the ready-made probe the Phase 3
// `create_pr` command will call. Wiring an unused-in-Phase-1
// capability field into `ShipPreflight` was reviewed and rejected: a
// preflight field nothing reads is exactly the kind of "looks acted
// upon but isn't" surface this codebase avoids.

/// Runs `bin args...` with stdio suppressed and a short kill-on-timeout
/// budget, returning whether it exited successfully.
#[allow(dead_code)]
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

#[allow(dead_code)]
fn probe_gh_available() -> bool {
    command_succeeds_quickly("gh", &["--version"], Duration::from_secs(3))
}

#[allow(dead_code)]
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
    /// `true` when `host` looks like GitHub/GHES and `ship_compare_url`
    /// would therefore succeed — the frontend uses this to disable
    /// *only* the "Open Compare Page" action while leaving Commit Only
    /// / Commit + Push available (see [`remote::looks_like_github_host`]).
    pub host_supports_compare: bool,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub staged: Vec<String>,
    pub unstaged: Vec<String>,
    pub untracked: Vec<String>,
    pub skipped: Vec<SkippedFile>,
    pub diff_stat: DiffStat,
    pub can_ship: bool,
    pub blockers: Vec<String>,
}

/// Computes the full ship preflight for `id`, evaluated for the given
/// staging `mode` (the deny-list preview and diff stat are mode-aware
/// — see [`stage_and_commit`]'s own per-mode enforcement, which this
/// mirrors): branch/remote/tracking state, working-tree status, and
/// the seven refusal conditions (toplevel mismatch, primary checkout,
/// detached `HEAD`, `branch == baseBranch`, protected branch, missing
/// remote, nothing to ship at all) as Title Case `blockers` — `canShip`
/// is `true` only when `blockers` is empty. None of the seven
/// conditions make this function itself fail; it always returns `Ok`
/// once the worker/worktree resolve at all (see the `Errors` section).
///
/// # Errors
///
/// * [`ShipErrorKind::WorkerNotFound`] / [`ShipErrorKind::NoWorktree`]
///   — same as [`worktree_info_for_worker`].
pub fn preflight(
    registry: &WorkerRegistry,
    id: WorkerId,
    mode: StagingMode,
) -> Result<ShipPreflight, ShipError> {
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
    let host_supports_compare = host.as_deref().is_some_and(remote::looks_like_github_host);

    let upstream = upstream_ref(wt);
    let (ahead, behind) = match &upstream {
        Some(u) => ahead_behind(wt, u),
        None => (ahead_since_base(wt, &info.base_commit), 0),
    };

    let entries = status_porcelain(wt).map_err(ShipError::from)?;
    let (staged, unstaged, untracked) = classify_status(&entries);

    if staged.is_empty() && unstaged.is_empty() && untracked.is_empty() && ahead == 0 {
        blockers.push(
            "Nothing To Ship — The Working Tree Is Clean And There's Nothing To Push.".to_string(),
        );
    }

    // Mode-aware candidate set: "all" previews what `git add -- <survivors>`
    // would touch (the full union); "staged" previews only the index,
    // since that's the only thing `stage_and_commit`'s "staged" branch
    // actually commits (and, after the B3 fix, actively unstages any
    // denied path from) — showing the full union's skip list while in
    // "staged" mode would be an inaccurate preview of what's about to
    // happen.
    let candidates = match mode {
        StagingMode::All => union_paths(&staged, &unstaged, &untracked),
        StagingMode::Staged => staged.clone(),
    };

    let untracked_set: HashSet<&str> = untracked.iter().map(|s| s.as_str()).collect();
    let mut skipped = Vec::new();
    for path in &candidates {
        let is_untracked = untracked_set.contains(path.as_str());
        if let Some(reason) = deny_reason(wt, path, is_untracked) {
            skipped.push(SkippedFile {
                path: path.clone(),
                reason,
            });
        }
    }
    let skipped_set: HashSet<&str> = skipped.iter().map(|s| s.path.as_str()).collect();

    let (tracked_survivors, untracked_survivors): (Vec<String>, Vec<String>) = match mode {
        StagingMode::All => (
            union_paths(&staged, &unstaged, &[])
                .into_iter()
                .filter(|p| !skipped_set.contains(p.as_str()))
                .collect(),
            untracked
                .iter()
                .filter(|p| !skipped_set.contains(p.as_str()))
                .cloned()
                .collect(),
        ),
        StagingMode::Staged => (
            staged
                .iter()
                .filter(|p| !skipped_set.contains(p.as_str()))
                .cloned()
                .collect(),
            Vec::new(),
        ),
    };
    let diff_stat = preview_diff_stat(wt, &tracked_survivors, &untracked_survivors);

    let can_ship = blockers.is_empty();

    Ok(ShipPreflight {
        worker_id: id,
        branch,
        base_branch: info.base_branch,
        remote,
        host,
        host_supports_compare,
        upstream,
        ahead,
        behind,
        staged,
        unstaged,
        untracked,
        skipped,
        diff_stat,
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

/// Argv for `git restore --staged -- <paths>` — unstages `paths`
/// without touching the working-tree copy. Used only by
/// [`stage_and_commit`]'s `"staged"` mode to actually enforce the deny
/// list (rather than merely reporting it) before committing.
fn restore_staged_args(worktree_path: &Path, paths: &[String]) -> Vec<String> {
    let mut args = base_args(worktree_path);
    args.push("restore".to_string());
    args.push("--staged".to_string());
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
            let untracked_set: HashSet<&str> = untracked.iter().map(|s| s.as_str()).collect();
            let candidates = union_paths(&staged, &unstaged, &untracked);
            let mut skipped = Vec::new();
            let mut survivors = Vec::new();
            for path in candidates {
                let is_untracked = untracked_set.contains(path.as_str());
                match deny_reason(wt, &path, is_untracked) {
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
            // DIRECTIVE (B3): the deny list is *enforced* here, not
            // merely reported — a denied path in the pre-staged index
            // (staged by something other than SWARM, e.g. a human's
            // own `git add .`) is actively unstaged via `git restore
            // --staged` before the commit runs, under the same
            // RepoLocks serialization as every other mutation. Earlier
            // behaviour only *displayed* `skipped` while still
            // committing the secret — the Title Case "Skipped" label
            // was a lie the UI told the user. If the unstage itself
            // fails, the commit is hard-aborted rather than risk
            // committing the secret anyway.
            let mut skipped = Vec::new();
            let mut denied_paths = Vec::new();
            for path in &staged {
                // `staged` entries are index_status != ' ' — by
                // definition already tracked, never an untracked `??`
                // entry — so this is never the untracked-artifact case
                // deny_reason's `is_untracked` gates on.
                if let Some(reason) = deny_reason(wt, path, false) {
                    denied_paths.push(path.clone());
                    skipped.push(SkippedFile {
                        path: path.clone(),
                        reason,
                    });
                }
            }
            if !denied_paths.is_empty() {
                let args = restore_staged_args(wt, &denied_paths);
                let out = repo_locks
                    .run_serialized(repo_root, || cli::run(&args, CREATE_TIMEOUT))
                    .map_err(ShipError::from)?;
                if !out.success() {
                    return Err(ShipError {
                        kind: ShipErrorKind::Unknown,
                        message: format!(
                            "Failed To Unstage Denied Files Before Commit — Refusing To Ship: {}",
                            out.stderr
                        ),
                        remedy: None,
                    });
                }
            }
            skipped
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

    let mut trailers = Vec::new();
    // DIRECTIVE (F10): never emit a degenerate range — `0..0` means
    // "we truly have no seq data" (not "the range starts and ends at
    // the beginning of the log"), and `seq_to < seq_from` can only mean
    // a caller-side resolution bug. Either way, a trailer that lies
    // about the range is worse than no trailer.
    if !(seq_from == 0 && seq_to == 0) && seq_to >= seq_from {
        trailers.push(format!("Swarm-Seq-Range: {seq_from}..{seq_to}"));
    }
    if let Some(co_author) = co_authored_by {
        let trimmed = co_author.trim();
        // Single-line only: a config value with an embedded newline/CR
        // could inject extra trailer-shaped lines (or corrupt the
        // message) — drop the trailer entirely rather than sanitize it
        // into something the user never actually configured.
        if !trimmed.is_empty() && !trimmed.contains(['\n', '\r']) {
            trailers.push(format!("Co-Authored-By: {trimmed}"));
        }
    }
    let full_message = if trailers.is_empty() {
        message.trim_end().to_string()
    } else {
        format!("{}\n\n{}", message.trim_end(), trailers.join("\n"))
    };

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
    /// `HEAD` sha at push time, resolved server-side (never trusted
    /// from a caller-supplied value — see [`push`]'s doc on why this
    /// enables pushing a commit `stage_and_commit` didn't just make).
    pub sha: String,
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
/// first statement. `branch` is resolved **live** via
/// [`resolve_live_branch`], never the stored `WorkerHandle.branch` —
/// see that function's doc for why. The push itself runs under
/// `repo_locks.run_serialized`, same as [`stage_and_commit`]'s
/// mutating calls.
///
/// Resolves `HEAD`'s sha itself (never a caller-supplied value) and
/// returns it as `PushOutcome.sha` — this is what makes it safe to
/// call `push` with **no** fresh commit from `stage_and_commit` in the
/// same ship attempt: a worker that already has unpushed commits
/// (`ShipPreflight.ahead > 0`, e.g. from an earlier "Commit Only") can
/// go straight to `push`, and `push` will push and correctly report
/// whatever `HEAD` actually is at that moment, not a stale value.
///
/// # Errors
///
/// * [`ShipErrorKind::PrimaryCheckout`] — the pre-mutation guard fired.
/// * [`ShipErrorKind::InvalidBranch`] — detached `HEAD`.
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
    let branch = resolve_live_branch(wt)?;

    if remote_url(wt, "origin").is_none() {
        return Err(ShipError {
            kind: ShipErrorKind::NoRemote,
            message: "No `origin` Remote Configured.".to_string(),
            remedy: None,
        });
    }

    let sha = super::repo::head_sha(wt).map_err(ShipError::from)?;

    let args = push_args(wt, &branch);
    let out = repo_locks
        .run_serialized(repo_root, || cli::run(&args, CREATE_TIMEOUT))
        .map_err(ShipError::from)?;
    if !out.success() {
        return Err(classify_push_error(&out.stderr));
    }

    Ok(PushOutcome {
        pushed_ref: format!("origin/{branch}"),
        sha,
    })
}

// ── Compare URL ───────────────────────────────────────────────────────

/// Builds the GitHub-style compare URL for `id`'s worktree, prefilled
/// with `title`/`body` (capped per [`remote::MAX_COMPARE_URL_LEN`]).
/// `branch` is resolved **live** via [`resolve_live_branch`], never
/// the stored `WorkerHandle.branch` — same reasoning as [`push`].
///
/// The frontend is expected to pre-check `ShipPreflight.hostSupportsCompare`
/// and disable the "Open Compare Page" action before ever calling this
/// (leaving Commit Only / Commit + Push available) — this function's
/// own [`ShipErrorKind::NonGitHubHost`] is the defensive fallback for
/// a stale preflight, not the primary UX.
///
/// # Errors
///
/// * [`ShipErrorKind::InvalidBranch`] — detached `HEAD`.
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
    let branch = resolve_live_branch(wt)?;

    let raw_remote = remote_url(wt, "origin").ok_or_else(|| ShipError {
        kind: ShipErrorKind::NoRemote,
        message: "No `origin` Remote Configured.".to_string(),
        remedy: None,
    })?;
    let parsed = remote::parse(&raw_remote).ok_or_else(|| ShipError {
        kind: ShipErrorKind::NonGitHubHost,
        message: "Could Not Parse The `origin` Remote URL Into A Compare Link.".to_string(),
        remedy: None,
    })?;
    if !remote::looks_like_github_host(&parsed.host) {
        return Err(ShipError {
            kind: ShipErrorKind::NonGitHubHost,
            message: format!(
                "`{}` Doesn't Look Like A GitHub Host — A Compare Link Can't Be Built For It.",
                parsed.host
            ),
            remedy: None,
        });
    }

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
                deny_reason(&tmp, name, false).is_some(),
                "expected {name} to be denied"
            );
        }
        for name in ["README.md", "src/main.rs", "package.json"] {
            assert!(
                deny_reason(&tmp, name, false).is_none(),
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
            deny_reason(&tmp, "blob.bin", false).as_deref(),
            Some("Skipped — Larger Than 5 MB")
        );
        assert!(deny_reason(&tmp, "tiny.bin", false).is_none());

        std::fs::remove_dir_all(&tmp).ok();
    }

    // ── Untracked `.claude/settings.json` defense in depth ────────────

    #[test]
    fn test_is_claude_settings_json_matches_root_and_nested_paths() {
        assert!(is_claude_settings_json(".claude/settings.json"));
        assert!(is_claude_settings_json("worker/.claude/settings.json"));
        assert!(is_claude_settings_json("a/b/.claude/settings.json"));
        assert!(!is_claude_settings_json("settings.json"));
        assert!(!is_claude_settings_json(".claude/other.json"));
        assert!(!is_claude_settings_json("claude/settings.json"));
        assert!(!is_claude_settings_json(".claude-old/settings.json"));
    }

    #[test]
    fn test_deny_reason_skips_untracked_claude_settings_json() {
        let tmp = std::env::temp_dir().join(format!("swarm-deny-claude-test-{}", Uuid::new_v4()));
        std::fs::create_dir_all(tmp.join(".claude")).unwrap();
        std::fs::write(tmp.join(".claude/settings.json"), "{}").unwrap();

        assert_eq!(
            deny_reason(&tmp, ".claude/settings.json", true).as_deref(),
            Some("Skipped — SWARM Configuration File")
        );
        assert_eq!(
            deny_reason(&tmp, "worker/.claude/settings.json", true).as_deref(),
            Some("Skipped — SWARM Configuration File")
        );

        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn test_deny_reason_leaves_tracked_claude_settings_json_alone() {
        let tmp = std::env::temp_dir().join(format!("swarm-deny-claude-test-{}", Uuid::new_v4()));
        std::fs::create_dir_all(tmp.join(".claude")).unwrap();
        std::fs::write(tmp.join(".claude/settings.json"), "{}").unwrap();

        // Same path, `is_untracked: false` — this is a tracked/staged
        // copy (the user's own file), never denied on that basis.
        assert!(deny_reason(&tmp, ".claude/settings.json", false).is_none());

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
        // Deterministic base_branch resolution regardless of the host
        // machine's own global git config (see resolve_base_branch's
        // fallback chain) — every test built on this fixture expects
        // "main".
        run_setup(&repo, &["config", "init.defaultBranch", "main"]);
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

    /// DIRECTIVE: an UNTRACKED `.claude/settings.json` in a worker's
    /// worktree — never written by SWARM itself since PR #11, so this
    /// can only be stray droppings — is deny-listed and never reaches
    /// the commit, same real-git proof shape as the secret/size guard
    /// test above.
    #[tokio::test]
    async fn test_untracked_claude_settings_json_is_skipped() {
        let repo = setup_repo("untracked-claude-settings");
        let worktree = repo.parent().unwrap().join("wt");
        let head = super::super::repo::head_sha(&repo).unwrap();
        super::super::worktree::add(&repo, &worktree, "swarm/untracked-settings-abcd1234", &head)
            .unwrap();

        std::fs::create_dir_all(worktree.join(".claude")).unwrap();
        std::fs::write(worktree.join(".claude/settings.json"), "{}").unwrap();
        std::fs::write(worktree.join("safe.txt"), "totally fine").unwrap();

        let registry = WorkerRegistry::new();
        let repo_locks = RepoLocks::new();
        let handle = make_isolated_handle(
            &worktree.display().to_string(),
            &repo.display().to_string(),
            "swarm/untracked-settings-abcd1234",
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
        assert!(skipped_paths.contains(&".claude/settings.json"));
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
        assert!(!show.stdout.contains(".claude/settings.json"));
        assert!(show.stdout.contains("safe.txt"));

        std::fs::remove_dir_all(repo.parent().unwrap()).ok();
    }

    /// DIRECTIVE: the flip side — a `.claude/settings.json` the user
    /// already committed into repo history (tracked, not SWARM
    /// droppings) is left entirely to the user's own shipping intent.
    /// Modifying it in the worktree and shipping must NOT deny-list it,
    /// proven against a real commit the same way the untracked case is
    /// proven absent.
    #[tokio::test]
    async fn test_tracked_claude_settings_json_is_not_skipped() {
        let repo = setup_repo("tracked-claude-settings");
        std::fs::create_dir_all(repo.join(".claude")).unwrap();
        std::fs::write(repo.join(".claude/settings.json"), "{\"permissions\":{}}").unwrap();
        run_setup(&repo, &["add", "-A"]);
        run_setup(&repo, &["commit", "-m", "chore: track user settings"]);

        let worktree = repo.parent().unwrap().join("wt");
        let head = super::super::repo::head_sha(&repo).unwrap();
        super::super::worktree::add(&repo, &worktree, "swarm/tracked-settings-abcd1234", &head)
            .unwrap();

        // The worker modifies the already-tracked file (still tracked,
        // just dirty) and adds an unrelated safe file.
        std::fs::write(
            worktree.join(".claude/settings.json"),
            "{\"permissions\":{\"allow\":[\"Bash\"]}}",
        )
        .unwrap();
        std::fs::write(worktree.join("safe.txt"), "totally fine").unwrap();

        let registry = WorkerRegistry::new();
        let repo_locks = RepoLocks::new();
        let handle = make_isolated_handle(
            &worktree.display().to_string(),
            &repo.display().to_string(),
            "swarm/tracked-settings-abcd1234",
        );
        let id = handle.id;
        registry.spawn_worker(handle).unwrap();

        let outcome = stage_and_commit(
            &registry,
            &repo_locks,
            id,
            "chore: update settings + safe file",
            StagingMode::All,
            0,
            1,
            None,
        )
        .expect("commit should succeed");

        let skipped_paths: Vec<&str> = outcome.skipped.iter().map(|s| s.path.as_str()).collect();
        assert!(
            !skipped_paths.contains(&".claude/settings.json"),
            "a tracked, user-owned .claude/settings.json must never be deny-listed: {skipped_paths:?}"
        );

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
        assert!(
            show.stdout.contains(".claude/settings.json"),
            "the modified tracked file should have been committed"
        );
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

        let result =
            preflight(&registry, id, StagingMode::All).expect("preflight itself must not error");
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
        // A real, unshipped change — otherwise the F6 "Nothing To Ship"
        // blocker correctly fires and this fixture would no longer be
        // "healthy".
        std::fs::write(worktree.join("new.txt"), "content").unwrap();

        let registry = WorkerRegistry::new();
        let handle = make_isolated_handle(
            &worktree.display().to_string(),
            &repo.display().to_string(),
            "swarm/healthy-abcd1234",
        );
        let id = handle.id;
        registry.spawn_worker(handle).unwrap();

        let result = preflight(&registry, id, StagingMode::All).unwrap();
        assert!(result.can_ship, "blockers: {:?}", result.blockers);
        assert_eq!(result.base_branch, "main");
        assert_eq!(result.host.as_deref(), Some("github.com"));
        assert!(result.host_supports_compare);

        std::fs::remove_dir_all(repo.parent().unwrap()).ok();
    }

    #[test]
    fn test_preflight_nothing_to_ship_blocker_when_clean_and_ahead_zero() {
        let repo = setup_repo("preflight-nothing-to-ship");
        let worktree = repo.parent().unwrap().join("wt");
        let head = super::super::repo::head_sha(&repo).unwrap();
        super::super::worktree::add(&repo, &worktree, "swarm/clean-abcd1234", &head).unwrap();
        run_setup(
            &repo,
            &[
                "remote",
                "add",
                "origin",
                "https://github.com/example/repo.git",
            ],
        );
        // No changes at all: clean tree, never diverged from base_commit.

        let registry = WorkerRegistry::new();
        let handle = make_isolated_handle(
            &worktree.display().to_string(),
            &repo.display().to_string(),
            "swarm/clean-abcd1234",
        );
        let id = handle.id;
        registry.spawn_worker(handle).unwrap();

        let result = preflight(&registry, id, StagingMode::All).unwrap();
        assert!(!result.can_ship);
        assert!(
            result
                .blockers
                .iter()
                .any(|b| b.contains("Nothing To Ship"))
        );

        std::fs::remove_dir_all(repo.parent().unwrap()).ok();
    }

    // ── B2: ahead-without-upstream fallback ──────────────────────────

    #[test]
    fn test_preflight_computes_ahead_from_base_commit_when_no_upstream() {
        let repo = setup_repo("ahead-no-upstream");
        let worktree = repo.parent().unwrap().join("wt");
        let head = super::super::repo::head_sha(&repo).unwrap();
        super::super::worktree::add(&repo, &worktree, "swarm/ahead-abcd1234", &head).unwrap();
        run_setup(
            &repo,
            &[
                "remote",
                "add",
                "origin",
                "https://github.com/example/repo.git",
            ],
        );

        // Two real commits in the worktree, never pushed — no upstream
        // exists at all.
        std::fs::write(worktree.join("a.txt"), "a").unwrap();
        run_setup(&worktree, &["add", "-A"]);
        run_setup(&worktree, &["commit", "-m", "first"]);
        std::fs::write(worktree.join("b.txt"), "b").unwrap();
        run_setup(&worktree, &["add", "-A"]);
        run_setup(&worktree, &["commit", "-m", "second"]);

        let registry = WorkerRegistry::new();
        let mut handle = make_isolated_handle(
            &worktree.display().to_string(),
            &repo.display().to_string(),
            "swarm/ahead-abcd1234",
        );
        // The real base sha — `make_isolated_handle`'s hardcoded
        // "deadbeef" placeholder doesn't resolve in this repo, and
        // `ahead_since_base` needs a real revision to diff against.
        handle.base_commit = Some(head.clone());
        let id = handle.id;
        registry.spawn_worker(handle).unwrap();

        let result = preflight(&registry, id, StagingMode::All).unwrap();
        assert_eq!(result.upstream, None);
        assert_eq!(result.ahead, 2);
        assert_eq!(result.behind, 0);
        // A clean tree with ahead > 0 must NOT trip the Nothing-To-Ship
        // blocker.
        assert!(
            !result
                .blockers
                .iter()
                .any(|b| b.contains("Nothing To Ship"))
        );

        std::fs::remove_dir_all(repo.parent().unwrap()).ok();
    }

    // ── B2: stranded-commit recovery (push with no fresh commit) ─────

    #[test]
    fn test_push_resolves_and_pushes_existing_head_with_no_prior_stage_and_commit_call() {
        let base = std::env::temp_dir().join(format!("swarm-ship-stranded-{}", Uuid::new_v4()));
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
        super::super::worktree::add(&repo, &worktree, "swarm/stranded-abcd1234", &head).unwrap();

        // Simulates "Commit Only" having already happened in a prior
        // ship attempt: a real commit exists in the worktree, but
        // stage_and_commit is never called again — push() alone must
        // still be able to push it.
        std::fs::write(worktree.join("feature.txt"), "already committed").unwrap();
        run_setup(&worktree, &["add", "-A"]);
        run_setup(&worktree, &["commit", "-m", "feat: prior commit-only"]);
        let expected_sha = super::super::repo::head_sha(&worktree).unwrap();

        let registry = WorkerRegistry::new();
        let repo_locks = RepoLocks::new();
        let handle = make_isolated_handle(
            &worktree.display().to_string(),
            &repo.display().to_string(),
            "swarm/stranded-abcd1234",
        );
        let id = handle.id;
        registry.spawn_worker(handle).unwrap();

        let outcome = push(&registry, &repo_locks, id).expect("push should succeed");
        assert_eq!(outcome.sha, expected_sha);
        assert_eq!(outcome.pushed_ref, "origin/swarm/stranded-abcd1234");

        let bare_tip = super::super::repo::rev_parse(&bare, "swarm/stranded-abcd1234").unwrap();
        assert_eq!(bare_tip, expected_sha);

        std::fs::remove_dir_all(&base).ok();
    }

    // ── F8: push/compare resolve the LIVE branch, never a stale stored one ──

    #[test]
    fn test_push_uses_live_branch_not_stale_stored_handle_branch() {
        let base = std::env::temp_dir().join(format!("swarm-ship-live-branch-{}", Uuid::new_v4()));
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
        super::super::worktree::add(&repo, &worktree, "swarm/original-abcd1234", &head).unwrap();
        // The worktree's actual checked-out branch is renamed after
        // creation — the stored WorkerHandle.branch ("swarm/original-abcd1234")
        // is now stale.
        run_setup(&worktree, &["branch", "-m", "swarm/renamed-abcd1234"]);
        std::fs::write(worktree.join("feature.txt"), "work").unwrap();
        run_setup(&worktree, &["add", "-A"]);
        run_setup(&worktree, &["commit", "-m", "feat: work"]);

        let registry = WorkerRegistry::new();
        let repo_locks = RepoLocks::new();
        let handle = make_isolated_handle(
            &worktree.display().to_string(),
            &repo.display().to_string(),
            "swarm/original-abcd1234", // stale
        );
        let id = handle.id;
        registry.spawn_worker(handle).unwrap();

        let outcome = push(&registry, &repo_locks, id).expect("push should succeed");
        assert_eq!(outcome.pushed_ref, "origin/swarm/renamed-abcd1234");

        // The bare repo must have the RENAMED branch, not the stale one.
        assert!(
            super::super::repo::rev_parse(&bare, "swarm/renamed-abcd1234").is_ok(),
            "expected the live (renamed) branch to have been pushed"
        );
        assert!(
            super::super::repo::rev_parse(&bare, "swarm/original-abcd1234").is_err(),
            "the stale stored branch name must never have been pushed"
        );

        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn test_push_hard_fails_on_detached_head() {
        let repo = setup_repo("push-detached");
        let worktree = repo.parent().unwrap().join("wt");
        let head = super::super::repo::head_sha(&repo).unwrap();
        super::super::worktree::add(&repo, &worktree, "swarm/detached-abcd1234", &head).unwrap();
        let wt_head = super::super::repo::head_sha(&worktree).unwrap();
        run_setup(&worktree, &["checkout", "--detach", &wt_head]);

        let registry = WorkerRegistry::new();
        let repo_locks = RepoLocks::new();
        let handle = make_isolated_handle(
            &worktree.display().to_string(),
            &repo.display().to_string(),
            "swarm/detached-abcd1234",
        );
        let id = handle.id;
        registry.spawn_worker(handle).unwrap();

        let err = push(&registry, &repo_locks, id).unwrap_err();
        assert_eq!(err.kind, ShipErrorKind::InvalidBranch);

        std::fs::remove_dir_all(repo.parent().unwrap()).ok();
    }

    // ── F9: base_branch resolution order ─────────────────────────────

    #[test]
    fn test_resolve_base_branch_uses_origin_head_over_local_checkout() {
        let base =
            std::env::temp_dir().join(format!("swarm-base-branch-origin-{}", Uuid::new_v4()));
        let bare = base.join("origin.git");
        let local = base.join("local");
        std::fs::create_dir_all(&bare).unwrap();
        std::fs::create_dir_all(&local).unwrap();

        run_setup(&bare, &["init", "--bare", "-b", "master"]);

        run_setup(&local, &["init", "-b", "master"]);
        run_setup(&local, &["config", "user.email", "swarm-test@example.com"]);
        run_setup(&local, &["config", "user.name", "Swarm Test"]);
        std::fs::write(local.join("README.md"), "hello").unwrap();
        run_setup(&local, &["add", "-A"]);
        run_setup(&local, &["commit", "-m", "initial"]);
        run_setup(
            &local,
            &["remote", "add", "origin", &bare.display().to_string()],
        );
        run_setup(&local, &["push", "origin", "master"]);
        run_setup(&local, &["fetch", "origin"]);
        run_setup(&local, &["remote", "set-head", "origin", "-a"]);

        // The LOCAL checkout is on a different branch than origin's
        // default — resolve_base_branch must report origin's ("master"),
        // never the local checkout's current branch.
        run_setup(&local, &["checkout", "-b", "some-feature-branch"]);

        assert_eq!(resolve_base_branch(&local), "master");
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn test_resolve_base_branch_falls_back_to_configured_default_branch() {
        let repo = setup_repo("base-branch-config-fallback");
        // No origin/HEAD exists at all (no remote). Overwrite the
        // deterministic "main" setup_repo already applied, to a
        // distinct value neither matching the repo's real current
        // branch nor the literal "main" fallback, to prove this really
        // is the config value being read.
        run_setup(&repo, &["config", "init.defaultBranch", "trunk"]);
        assert_eq!(resolve_base_branch(&repo), "trunk");
        std::fs::remove_dir_all(repo.parent().unwrap()).ok();
    }

    /// Pure decision-logic test (see `choose_base_branch`'s doc for why
    /// this isn't a real-git round trip): with neither `origin/HEAD`
    /// nor a configured default present, the literal `"main"` fallback
    /// applies — independent of whatever the *host machine's own*
    /// global git config happens to have set.
    #[test]
    fn test_choose_base_branch_falls_back_to_main_literal_when_neither_source_is_set() {
        assert_eq!(choose_base_branch(None, None), "main");
    }

    #[test]
    fn test_choose_base_branch_prefers_origin_head_over_configured_default() {
        assert_eq!(
            choose_base_branch(Some("master".to_string()), Some("trunk".to_string())),
            "master"
        );
    }

    #[test]
    fn test_choose_base_branch_uses_configured_default_when_origin_head_absent() {
        assert_eq!(choose_base_branch(None, Some("trunk".to_string())), "trunk");
    }

    // ── F14: deny-list "secret" matches the full path, not just basename ──

    #[test]
    fn test_deny_reason_secret_matches_nested_directory_not_just_basename() {
        let tmp = std::env::temp_dir().join(format!("swarm-deny-nested-{}", Uuid::new_v4()));
        std::fs::create_dir_all(tmp.join("config/secrets")).unwrap();
        std::fs::write(tmp.join("config/secrets/api.yaml"), "key: x").unwrap();
        assert!(
            deny_reason(&tmp, "config/secrets/api.yaml", false).is_some(),
            "a path with 'secret' in a directory segment must be denied even though the basename doesn't mention it"
        );
        std::fs::remove_dir_all(&tmp).ok();
    }

    // ── B3: staged mode actually enforces the deny list (unstages, not just reports) ──

    #[tokio::test]
    async fn test_staged_mode_unstages_and_omits_denied_secret_from_the_commit() {
        let repo = setup_repo("staged-mode-secret");
        let worktree = repo.parent().unwrap().join("wt");
        let head = super::super::repo::head_sha(&repo).unwrap();
        super::super::worktree::add(&repo, &worktree, "swarm/staged-secret-abcd1234", &head)
            .unwrap();

        std::fs::write(worktree.join(".env"), "API_KEY=leak").unwrap();
        std::fs::write(worktree.join("safe.txt"), "fine").unwrap();
        run_setup(&worktree, &["add", "-A"]); // pre-stages BOTH files, like a human's own `git add .`

        let registry = WorkerRegistry::new();
        let repo_locks = RepoLocks::new();
        let handle = make_isolated_handle(
            &worktree.display().to_string(),
            &repo.display().to_string(),
            "swarm/staged-secret-abcd1234",
        );
        let id = handle.id;
        registry.spawn_worker(handle).unwrap();

        let outcome = stage_and_commit(
            &registry,
            &repo_locks,
            id,
            "chore: staged mode commit",
            StagingMode::Staged,
            0,
            1,
            None,
        )
        .expect("commit of the surviving staged file should succeed");

        assert_eq!(outcome.skipped.len(), 1);
        assert_eq!(outcome.skipped[0].path, ".env");

        // The secret must be unstaged (not merely reported) ...
        let status = status_porcelain(&worktree).unwrap();
        let (staged_after, _, untracked_after) = classify_status(&status);
        assert!(
            !staged_after.contains(&".env".to_string()),
            "the denied file must have been unstaged before commit, not left staged"
        );
        // ... and physically absent from the commit itself.
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
        assert!(show.stdout.contains("safe.txt"));

        // The file itself still exists on disk, just untracked again —
        // "restore --staged" never touches the working-tree copy.
        assert!(worktree.join(".env").exists());
        assert!(untracked_after.contains(&".env".to_string()));

        std::fs::remove_dir_all(repo.parent().unwrap()).ok();
    }

    // ── F10: degenerate Swarm-Seq-Range trailer is omitted ────────────

    #[tokio::test]
    async fn test_degenerate_seq_range_omits_the_trailer_entirely() {
        let repo = setup_repo("degenerate-seq-range");
        let worktree = repo.parent().unwrap().join("wt");
        let head = super::super::repo::head_sha(&repo).unwrap();
        super::super::worktree::add(&repo, &worktree, "swarm/degenerate-abcd1234", &head).unwrap();
        std::fs::write(worktree.join("a.txt"), "a").unwrap();

        let registry = WorkerRegistry::new();
        let repo_locks = RepoLocks::new();
        let handle = make_isolated_handle(
            &worktree.display().to_string(),
            &repo.display().to_string(),
            "swarm/degenerate-abcd1234",
        );
        let id = handle.id;
        registry.spawn_worker(handle).unwrap();

        // seq_from == seq_to == 0: "unknown" range, must be omitted.
        let outcome = stage_and_commit(
            &registry,
            &repo_locks,
            id,
            "feat: unknown range",
            StagingMode::All,
            0,
            0,
            None,
        )
        .unwrap();
        let show = cli::run(
            &{
                let mut a = base_args(&worktree);
                a.extend(
                    ["show", "-s", "--format=%B", &outcome.sha]
                        .iter()
                        .map(|s| s.to_string()),
                );
                a
            },
            READ_TIMEOUT,
        )
        .unwrap();
        assert!(!show.stdout.contains("Swarm-Seq-Range"));

        std::fs::remove_dir_all(repo.parent().unwrap()).ok();
    }

    #[tokio::test]
    async fn test_valid_seq_range_is_included_in_the_trailer() {
        let repo = setup_repo("valid-seq-range");
        let worktree = repo.parent().unwrap().join("wt");
        let head = super::super::repo::head_sha(&repo).unwrap();
        super::super::worktree::add(&repo, &worktree, "swarm/valid-range-abcd1234", &head).unwrap();
        std::fs::write(worktree.join("a.txt"), "a").unwrap();

        let registry = WorkerRegistry::new();
        let repo_locks = RepoLocks::new();
        let handle = make_isolated_handle(
            &worktree.display().to_string(),
            &repo.display().to_string(),
            "swarm/valid-range-abcd1234",
        );
        let id = handle.id;
        registry.spawn_worker(handle).unwrap();

        let outcome = stage_and_commit(
            &registry,
            &repo_locks,
            id,
            "feat: valid range",
            StagingMode::All,
            5,
            12,
            None,
        )
        .unwrap();
        let show = cli::run(
            &{
                let mut a = base_args(&worktree);
                a.extend(
                    ["show", "-s", "--format=%B", &outcome.sha]
                        .iter()
                        .map(|s| s.to_string()),
                );
                a
            },
            READ_TIMEOUT,
        )
        .unwrap();
        assert!(show.stdout.contains("Swarm-Seq-Range: 5..12"));

        std::fs::remove_dir_all(repo.parent().unwrap()).ok();
    }

    // ── nit: Co-Authored-By trim + reject embedded newlines ───────────

    #[tokio::test]
    async fn test_co_authored_by_with_embedded_newline_is_dropped_not_injected() {
        let repo = setup_repo("co-author-newline");
        let worktree = repo.parent().unwrap().join("wt");
        let head = super::super::repo::head_sha(&repo).unwrap();
        super::super::worktree::add(&repo, &worktree, "swarm/co-author-abcd1234", &head).unwrap();
        std::fs::write(worktree.join("a.txt"), "a").unwrap();

        let registry = WorkerRegistry::new();
        let repo_locks = RepoLocks::new();
        let handle = make_isolated_handle(
            &worktree.display().to_string(),
            &repo.display().to_string(),
            "swarm/co-author-abcd1234",
        );
        let id = handle.id;
        registry.spawn_worker(handle).unwrap();

        let outcome = stage_and_commit(
            &registry,
            &repo_locks,
            id,
            "feat: co-author injection attempt",
            StagingMode::All,
            1,
            2,
            Some("Evil <evil@example.com>\nSwarm-Seq-Range: 999..999"),
        )
        .unwrap();
        let show = cli::run(
            &{
                let mut a = base_args(&worktree);
                a.extend(
                    ["show", "-s", "--format=%B", &outcome.sha]
                        .iter()
                        .map(|s| s.to_string()),
                );
                a
            },
            READ_TIMEOUT,
        )
        .unwrap();
        assert!(!show.stdout.contains("Evil"));
        assert!(!show.stdout.contains("999..999"));
        // The real, legitimate trailer must still be present.
        assert!(show.stdout.contains("Swarm-Seq-Range: 1..2"));

        std::fs::remove_dir_all(repo.parent().unwrap()).ok();
    }
}
