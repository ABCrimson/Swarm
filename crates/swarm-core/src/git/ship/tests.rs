//! Tests for the ship chain: its guards and branch resolution, and,
//! against disposable real repositories ([`TempRepo`]) with a worker on
//! a linked worktree, the whole chain, asserting on what actually landed
//! in git.

use std::path::Path;
use std::time::Duration;

use uuid::Uuid;

use super::*;
use crate::git::test_support::{TempRepo, git_in, write_file};
use crate::worker::handle::{WorkerHandle, WorkerState};
use crate::worker::registry::PushRecord;

/// Registers a worker whose worktree is `worktree`, forked from
/// `repo`'s current `HEAD`.
fn register(registry: &WorkerRegistry, repo: &TempRepo, worktree: &Path, branch: &str) -> WorkerId {
    let base_commit = repo::head_sha(repo.root()).unwrap();
    register_at(registry, repo, worktree, branch, &base_commit)
}

/// [`register`] with an explicit recorded base commit.
fn register_at(
    registry: &WorkerRegistry,
    repo: &TempRepo,
    worktree: &Path,
    branch: &str,
    base_commit: &str,
) -> WorkerId {
    let handle = WorkerHandle {
        id: Uuid::new_v4(),
        state: WorkerState::Running,
        name: "test".to_owned(),
        pid: None,
        started_at: 0,
        pty_writer: None,
        child: None,
        worktree_path: Some(worktree.display().to_string()),
        repo_root: Some(repo.root().display().to_string()),
        branch: Some(branch.to_owned()),
        base_commit: Some(base_commit.to_owned()),
        last_shipped_seq: None,
        last_shipped_commit: None,
    };
    let id = handle.id;
    registry.register(handle).unwrap();
    id
}

/// A repo, a linked worktree on `branch`, and a worker registered on it.
fn fixture(tag: &str, branch: &str) -> (TempRepo, std::path::PathBuf, WorkerRegistry, WorkerId) {
    let repo = TempRepo::new(tag);
    let worktree = repo.add_worktree("wt", branch);
    let registry = WorkerRegistry::new();
    let id = register(&registry, &repo, &worktree, branch);
    (repo, worktree, registry, id)
}

fn request(mode: StagingMode, message: &str) -> CommitRequest {
    CommitRequest {
        message: message.to_owned(),
        mode,
        seq_from: 0,
        seq_to: 1,
        co_authored_by: None,
    }
}

/// The paths commit `sha` touched.
fn committed_paths(dir: &Path, sha: &str) -> Vec<String> {
    let output = git_in(dir, &["show", "--name-only", "-z", "--format=", sha]);
    output
        .stdout
        .split(|&byte| byte == 0)
        .filter(|name| !name.is_empty())
        .map(|name| String::from_utf8_lossy(name).into_owned())
        .collect()
}

fn commit_message(dir: &Path, sha: &str) -> String {
    let output = git_in(dir, &["show", "-s", "--format=%B", sha]);
    String::from_utf8_lossy(&output.stdout).into_owned()
}

fn skipped_paths(skipped: &[SkippedFile]) -> Vec<&str> {
    skipped.iter().map(|file| file.path.as_str()).collect()
}

// ── worktree_info_for_worker ─────────────────────────────────────────

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
        name: "unisolated".to_owned(),
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
    registry.register(handle).unwrap();
    let err = worktree_info_for_worker(&registry, id).unwrap_err();
    assert_eq!(err.kind, ShipErrorKind::NoWorktree);
}

/// A pure registry read: it resolves even when nothing exists on disk
/// (no git runs), and leaves the registry writable afterwards.
#[test]
fn test_worktree_info_for_worker_is_a_pure_registry_read() {
    let repo = TempRepo::new("info-pure");
    let registry = WorkerRegistry::new();
    let id = register(&registry, &repo, Path::new("/nonexistent/wt"), "swarm/x");
    registry.set_last_shipped(&id, 42, "cafef00d").unwrap();

    let info = worktree_info_for_worker(&registry, id).unwrap();
    assert_eq!(info.worktree_path, Path::new("/nonexistent/wt"));
    assert_eq!(info.last_shipped_seq, Some(42));
    registry.set_last_shipped(&id, 43, "f00d").unwrap();
}

// ── Guards and branch resolution ─────────────────────────────────────

#[test]
fn test_is_protected_branch() {
    assert!(is_protected_branch("main"));
    assert!(is_protected_branch("master"));
    assert!(is_protected_branch("develop"));
    assert!(is_protected_branch("release/1.0"));
    assert!(!is_protected_branch("swarm/agent-abcd1234"));
    // The `release/*` glob, not the bare word.
    assert!(!is_protected_branch("release"));
}

#[test]
fn test_literal_pathspecs_payload_shape() {
    let payload = literal_pathspecs(["a b.txt", "app/[slug]/page.tsx"]);
    assert_eq!(
        payload,
        b":(top,literal)a b.txt\0:(top,literal)app/[slug]/page.tsx\0"
    );
    assert!(literal_pathspecs([]).is_empty());
}

#[test]
fn test_choose_base_branch_resolution_order() {
    assert_eq!(
        choose_base_branch(|| Some("master".to_owned()), || Some("trunk".to_owned())),
        "master"
    );
    assert_eq!(
        choose_base_branch(|| None, || Some("trunk".to_owned())),
        "trunk"
    );
    assert_eq!(choose_base_branch(|| None, || None), "main");
}

/// The configured default is only consulted when `origin/HEAD` is
/// missing — one git query instead of two in the common case.
#[test]
fn test_choose_base_branch_is_lazy() {
    let branch = choose_base_branch(
        || Some("main".to_owned()),
        || panic!("the fallback must not run when origin/HEAD resolved"),
    );
    assert_eq!(branch, "main");
}

#[test]
fn test_resolve_base_branch_uses_origin_head_over_local_checkout() {
    let repo = TempRepo::new("base-branch-origin");
    repo.git(&["branch", "-m", "main", "master"]);
    repo.add_bare_origin();
    repo.git(&["remote", "set-head", "origin", "-a"]);
    // The local checkout moves to another branch; the answer is
    // still origin's default, never the local HEAD.
    repo.git(&["checkout", "-b", "some-feature-branch"]);

    assert_eq!(resolve_base_branch(repo.root()), "master");
}

#[test]
fn test_resolve_base_branch_falls_back_to_configured_default_branch() {
    let repo = TempRepo::new("base-branch-config");
    // No remote, so no origin/HEAD; a value distinct from both the
    // current branch and the "main" literal proves the config read.
    repo.git(&["config", "init.defaultBranch", "trunk"]);
    assert_eq!(resolve_base_branch(repo.root()), "trunk");
}

#[test]
fn test_current_branch_detects_detached_head() {
    let repo = TempRepo::new("detached");
    assert_eq!(
        current_branch(repo.root()).unwrap().as_deref(),
        Some("main")
    );
    repo.git(&["checkout", "--detach"]);
    assert_eq!(current_branch(repo.root()).unwrap(), None);
}

/// A tag named like the branch must not turn `main` into `heads/main`.
#[test]
fn test_current_branch_is_exact_when_a_tag_shares_its_name() {
    let repo = TempRepo::new("branch-tag-clash");
    repo.git(&["tag", "main"]);
    assert_eq!(
        current_branch(repo.root()).unwrap().as_deref(),
        Some("main")
    );
}

/// A failed read is an error, never "detached" (`Ok(None)`).
#[test]
fn test_current_branch_errors_when_git_cannot_read_the_directory() {
    let repo = TempRepo::new("branch-gone");
    assert!(current_branch(&repo.base().join("gone")).is_err());
}

/// Only exit 2 means "no such remote"; any other failure is an error.
#[test]
fn test_remote_url_errors_on_a_failed_read_and_is_none_for_a_missing_remote() {
    let repo = TempRepo::new("remote-url");
    assert!(remote_url(&repo.base().join("gone"), "origin").is_err());
    assert_eq!(remote_url(repo.root(), "origin").unwrap(), None);
}

#[test]
fn test_guard_accepts_a_linked_worktree_and_refuses_the_primary_checkout() {
    let repo = TempRepo::new("guard");
    let worktree = repo.add_worktree("wt", "swarm/guard-abcd1234");
    assert!(guard_not_primary_checkout(&worktree).is_ok());

    let err = guard_not_primary_checkout(repo.root()).unwrap_err();
    assert_eq!(err.kind, ShipErrorKind::PrimaryCheckout);
    assert_eq!(err.message, PRIMARY_CHECKOUT);

    // A subdirectory of a worktree is not the worktree.
    std::fs::create_dir_all(worktree.join("sub")).unwrap();
    let err = guard_not_primary_checkout(&worktree.join("sub")).unwrap_err();
    assert_eq!(err.message, NOT_A_WORKTREE);

    // Nor is a path that no longer exists.
    let err = guard_not_primary_checkout(&repo.base().join("gone")).unwrap_err();
    assert_eq!(err.kind, ShipErrorKind::PrimaryCheckout);
}

// ── The primary-checkout guard ───────────────────────────────────────

/// DIRECTIVE: the guard fires before any mutation. A worker mis-pointed
/// at the primary checkout is refused, and the tree is untouched.
#[test]
fn test_primary_checkout_guard_fires_before_any_mutation() {
    let repo = TempRepo::new("primary-guard");
    let registry = WorkerRegistry::new();
    let id = register(&registry, &repo, repo.root(), "main");
    repo.write("untracked.txt", "should never be staged");

    let err = stage_and_commit(
        &registry,
        &RepoLocks::new(),
        id,
        &request(StagingMode::All, "feat: should never land"),
    )
    .unwrap_err();
    assert_eq!(err.kind, ShipErrorKind::PrimaryCheckout);

    let classified = status::StatusSnapshot::read(repo.root())
        .unwrap()
        .classify();
    assert!(classified.staged.is_empty(), "no `git add` may have run");
    assert_eq!(classified.untracked, ["untracked.txt"]);

    let err = push(&registry, &RepoLocks::new(), id).unwrap_err();
    assert_eq!(err.kind, ShipErrorKind::PrimaryCheckout);
}

// ── Commit + push ────────────────────────────────────────────────────

/// No-network end to end: a bare `origin`, a linked worktree, a real
/// commit and a real push; the bare repo's branch must advance to it.
#[test]
fn test_full_ship_cycle_advances_a_real_bare_remote() {
    let repo = TempRepo::new("ship-e2e");
    let bare = repo.add_bare_origin();
    let worktree = repo.add_worktree("wt", "swarm/agent-abcd1234");
    let registry = WorkerRegistry::new();
    let repo_locks = RepoLocks::new();
    let id = register(&registry, &repo, &worktree, "swarm/agent-abcd1234");

    write_file(&worktree, "feature.txt", "real work");
    write_file(&worktree, ".env", "API_KEY=should-never-ship");

    let outcome = stage_and_commit(
        &registry,
        &repo_locks,
        id,
        &CommitRequest {
            co_authored_by: Some("SWARM <noreply@example.com>".to_owned()),
            ..request(StagingMode::All, "feat: add feature file")
        },
    )
    .unwrap();
    assert_eq!(skipped_paths(&outcome.skipped), [".env"]);
    assert_eq!(committed_paths(&worktree, &outcome.sha), ["feature.txt"]);

    let pushed = push(&registry, &repo_locks, id).unwrap();
    assert_eq!(pushed.pushed_ref, "origin/swarm/agent-abcd1234");
    assert_eq!(pushed.sha, outcome.sha);
    assert_eq!(
        repo::rev_parse(&bare, "swarm/agent-abcd1234").unwrap(),
        outcome.sha
    );
}

/// DIRECTIVE: a secret-shaped file and an oversized blob are both
/// skipped; neither is committed.
#[test]
fn test_secret_and_size_guard_neither_file_is_committed() {
    let (_repo, worktree, registry, id) = fixture("secret-guard", "swarm/guard-abcd1234");
    write_file(&worktree, "id_rsa", "-----BEGIN OPENSSH PRIVATE KEY-----");
    let oversized = usize::try_from(deny::MAX_STAGED_FILE_BYTES).unwrap() + 1024;
    std::fs::write(worktree.join("blob.bin"), vec![0_u8; oversized]).unwrap();
    write_file(&worktree, "safe.txt", "totally fine");

    let outcome = stage_and_commit(
        &registry,
        &RepoLocks::new(),
        id,
        &request(StagingMode::All, "chore: add safe file"),
    )
    .unwrap();

    let mut skipped = skipped_paths(&outcome.skipped);
    skipped.sort_unstable();
    assert_eq!(skipped, ["blob.bin", "id_rsa"]);
    assert_eq!(committed_paths(&worktree, &outcome.sha), ["safe.txt"]);
}

/// The audit's blob size: 1,024 bytes over [`deny::MAX_STAGED_FILE_BYTES`].
const AUDIT_BLOB_BYTES: usize = 5_243_904;

/// B1: the size guard measures the blob the commit would contain. A
/// 5,243,904-byte blob is staged, then the working copy is shrunk
/// without re-adding: staged-only mode commits the index, so the oversized
/// blob must be denied, unstaged and left out.
#[test]
fn test_staged_mode_denies_an_oversized_index_blob_whose_working_copy_shrank() {
    let (_repo, worktree, registry, id) = fixture("b1-shrunk", "swarm/b1-shrunk-abcd1234");
    std::fs::write(worktree.join("blob.bin"), vec![0_u8; AUDIT_BLOB_BYTES]).unwrap();
    write_file(&worktree, "safe.txt", "fine");
    git_in(&worktree, &["add", "blob.bin", "safe.txt"]);
    std::fs::write(worktree.join("blob.bin"), b"tiny").unwrap();

    let outcome = stage_and_commit(
        &registry,
        &RepoLocks::new(),
        id,
        &request(StagingMode::Staged, "feat: staged"),
    )
    .unwrap();

    assert_eq!(committed_paths(&worktree, &outcome.sha), ["safe.txt"]);
    assert_eq!(
        outcome.skipped,
        [SkippedFile {
            path: "blob.bin".to_owned(),
            reason: "Skipped — Larger Than 5 MB".to_owned(),
        }]
    );
    // Unstaged, never deleted: the (tiny) working copy is untouched.
    let after = status::StatusSnapshot::read(&worktree).unwrap().classify();
    assert_eq!(after.untracked, ["blob.bin"]);
    assert_eq!(std::fs::read(worktree.join("blob.bin")).unwrap(), b"tiny");
}

/// B1, the other direction: staged-only mode never reads the working
/// copy to decide what is committed, so a small staged blob ships even
/// though the file on disk has since grown past the limit.
#[test]
fn test_staged_mode_commits_a_small_index_blob_whose_working_copy_grew() {
    let (_repo, worktree, registry, id) = fixture("b1-grew", "swarm/b1-grew-abcd1234");
    write_file(&worktree, "blob.bin", "small");
    git_in(&worktree, &["add", "blob.bin"]);
    std::fs::write(worktree.join("blob.bin"), vec![0_u8; AUDIT_BLOB_BYTES]).unwrap();

    let outcome = stage_and_commit(
        &registry,
        &RepoLocks::new(),
        id,
        &request(StagingMode::Staged, "feat: staged"),
    )
    .unwrap();

    assert_eq!(committed_paths(&worktree, &outcome.sha), ["blob.bin"]);
    assert!(outcome.skipped.is_empty(), "{:?}", outcome.skipped);
    let blob = git_in(
        &worktree,
        &["cat-file", "-s", &format!("{}:blob.bin", outcome.sha)],
    );
    assert_eq!(blob.stdout_trimmed(), "5");
}

/// S3: a staged 6 MB file with a non-UTF-8 name never reaches a commit
/// in staged-only mode: the ship is refused (it cannot be unstaged).
/// Staged mode commits the index, so the entry is staged through the
/// index alone; that lets the test run on macOS, whose APFS cannot hold
/// the name.
#[cfg(unix)]
#[test]
fn test_staged_mode_never_commits_an_oversized_non_utf8_name() {
    use crate::git::test_support::stage_raw_name;

    let (_repo, worktree, registry, id) = fixture("s3-non-utf8", "swarm/s3-abcd1234");
    stage_raw_name(&worktree, b"big\xff.bin", &vec![0_u8; 6 * 1024 * 1024]);
    write_file(&worktree, "safe.txt", "fine");
    // By name, not `.`: the raw-named entry has no file on disk, and
    // `add .` would stage that absence as its removal.
    git_in(&worktree, &["add", "safe.txt"]);

    // Fail closed: the lossy name cannot be unstaged by pathspec, so the
    // ship is refused rather than committing or silently skipping.
    let err = stage_and_commit(
        &registry,
        &RepoLocks::new(),
        id,
        &request(StagingMode::Staged, "feat: staged"),
    )
    .unwrap_err();
    assert!(err.message.contains("Refusing To Ship"), "{}", err.message);

    let tree = git_in(&worktree, &["ls-tree", "-r", "--name-only", "HEAD"]);
    let tree = String::from_utf8_lossy(&tree.stdout).into_owned();
    assert!(!tree.contains("big"), "oversized blob committed: {tree}");
}

/// Security: "all" mode unstages a pre-staged `.env`, reports it
/// skipped and leaves it out of the commit (still on disk, untracked).
#[test]
fn test_all_mode_unstages_a_pre_staged_secret() {
    let (_repo, worktree, registry, id) = fixture("all-prestaged", "swarm/prestaged-abcd1234");
    write_file(&worktree, ".env", "API_KEY=leak");
    write_file(&worktree, "safe.txt", "fine");
    git_in(&worktree, &["add", ".env"]);

    let outcome = stage_and_commit(
        &registry,
        &RepoLocks::new(),
        id,
        &request(StagingMode::All, "feat: work"),
    )
    .unwrap();

    assert_eq!(skipped_paths(&outcome.skipped), [".env"]);
    assert_eq!(committed_paths(&worktree, &outcome.sha), ["safe.txt"]);
    let after = status::StatusSnapshot::read(&worktree).unwrap().classify();
    assert_eq!(after.untracked, [".env"], "unstaged, and still on disk");
}

/// Security: with *only* a pre-staged secret, "all" mode unstages it and
/// fails with `NothingToCommit`, so no commit holding just the secret exists.
#[test]
fn test_all_mode_with_only_a_pre_staged_secret_commits_nothing() {
    let (repo, worktree, registry, id) = fixture("all-only-secret", "swarm/only-secret-abcd1234");
    write_file(&worktree, "server.pem", "-----BEGIN PRIVATE KEY-----");
    git_in(&worktree, &["add", "server.pem"]);

    let err = stage_and_commit(
        &registry,
        &RepoLocks::new(),
        id,
        &request(StagingMode::All, "feat: nothing real"),
    )
    .unwrap_err();

    assert_eq!(err.kind, ShipErrorKind::NothingToCommit);
    assert_eq!(
        repo::head_sha(&worktree).unwrap(),
        repo::head_sha(repo.root()).unwrap(),
        "no commit may have been made"
    );
}

/// DIRECTIVE (B3): "staged" mode enforces the deny list too — the
/// denied file is unstaged, not merely reported.
#[test]
fn test_staged_mode_unstages_and_omits_denied_secret_from_the_commit() {
    let (_repo, worktree, registry, id) = fixture("staged-secret", "swarm/staged-secret-abcd1234");
    write_file(&worktree, ".env", "API_KEY=leak");
    write_file(&worktree, "safe.txt", "fine");
    git_in(&worktree, &["add", "-A"]);

    let outcome = stage_and_commit(
        &registry,
        &RepoLocks::new(),
        id,
        &request(StagingMode::Staged, "chore: staged mode commit"),
    )
    .unwrap();

    assert_eq!(skipped_paths(&outcome.skipped), [".env"]);
    assert_eq!(committed_paths(&worktree, &outcome.sha), ["safe.txt"]);
    let after = status::StatusSnapshot::read(&worktree).unwrap().classify();
    assert!(after.staged.is_empty());
    assert_eq!(after.untracked, [".env"]);
}

/// Names with spaces and non-ASCII come verbatim from `status
/// --porcelain=v2 -z` (never C-quoted), so they stage cleanly and
/// `.env copy` still hits the deny list.
#[test]
fn test_names_with_spaces_and_non_ascii_ship_and_are_deny_checked() {
    let (_repo, worktree, registry, id) = fixture("quoted-names", "swarm/quoted-abcd1234");
    write_file(&worktree, "My Notes.md", "notes");
    write_file(&worktree, "caf\u{e9}.txt", "caf\u{e9}");
    write_file(&worktree, "dir with space/file.txt", "x");
    write_file(&worktree, ".env copy", "API_KEY=leak");

    let outcome = stage_and_commit(
        &registry,
        &RepoLocks::new(),
        id,
        &request(StagingMode::All, "feat: awkward names"),
    )
    .unwrap();

    assert_eq!(skipped_paths(&outcome.skipped), [".env copy"]);
    let mut committed = committed_paths(&worktree, &outcome.sha);
    committed.sort();
    assert_eq!(
        committed,
        ["My Notes.md", "caf\u{e9}.txt", "dir with space/file.txt"]
    );
}

/// Status output is parsed in full however large it is: ~400 paths push
/// it far past 8 KB, every file still ships, and the path that sorts
/// last is still deny-checked.
#[test]
fn test_status_output_over_8_kb_ships_every_file_and_denies_the_last() {
    let (_repo, worktree, registry, id) = fixture("large-status", "swarm/large-abcd1234");
    for index in 0..400 {
        write_file(
            &worktree,
            &format!("generated/component-number-{index:04}.tsx"),
            "export {};\n",
        );
    }
    // Sorts after every generated path, so it sits past any 8 KB cut.
    write_file(&worktree, "zz-config/.env.production", "API_KEY=leak");

    for mode in [StagingMode::Staged, StagingMode::All] {
        if mode == StagingMode::Staged {
            // Pre-stage everything, secret included, like `git add .`.
            git_in(&worktree, &["add", "-A"]);
        }
        let outcome = stage_and_commit(
            &registry,
            &RepoLocks::new(),
            id,
            &request(mode, "feat: generated components"),
        )
        .unwrap();
        assert_eq!(
            skipped_paths(&outcome.skipped),
            ["zz-config/.env.production"],
            "{mode:?}"
        );
        let committed = committed_paths(&worktree, &outcome.sha);
        assert_eq!(committed.len(), 400, "{mode:?}");
        assert!(!committed.iter().any(|path| path.contains(".env")));
        // Reset for the next mode: undo the commit, keep the files.
        git_in(&worktree, &["reset", "--mixed", "HEAD~1"]);
    }
}

/// Pathspecs are literal: a survivor whose name is also a glob must not
/// drag a denied file it happens to match into the commit.
#[test]
fn test_glob_shaped_survivor_does_not_stage_a_denied_file_it_matches() {
    let (_repo, worktree, registry, id) = fixture("literal-pathspec", "swarm/literal-abcd1234");
    // As a glob, `[.]env.example.md` matches `.env.example.md`.
    write_file(&worktree, "[.]env.example.md", "docs");
    write_file(&worktree, ".env.example.md", "API_KEY=leak");
    write_file(&worktree, "app/[slug]/page.tsx", "export {};");

    let outcome = stage_and_commit(
        &registry,
        &RepoLocks::new(),
        id,
        &request(StagingMode::All, "feat: routes"),
    )
    .unwrap();

    assert_eq!(skipped_paths(&outcome.skipped), [".env.example.md"]);
    let mut committed = committed_paths(&worktree, &outcome.sha);
    committed.sort();
    assert_eq!(committed, ["[.]env.example.md", "app/[slug]/page.tsx"]);
}

/// DIRECTIVE: an untracked `.claude/settings.json` is a leftover, never
/// shipped.
#[test]
fn test_untracked_claude_settings_json_is_skipped() {
    let (_repo, worktree, registry, id) =
        fixture("untracked-settings", "swarm/untracked-settings-abcd1234");
    write_file(&worktree, ".claude/settings.json", "{}");
    write_file(&worktree, "safe.txt", "totally fine");

    let outcome = stage_and_commit(
        &registry,
        &RepoLocks::new(),
        id,
        &request(StagingMode::All, "chore: add safe file"),
    )
    .unwrap();

    assert_eq!(skipped_paths(&outcome.skipped), [".claude/settings.json"]);
    assert_eq!(committed_paths(&worktree, &outcome.sha), ["safe.txt"]);
}

/// DIRECTIVE: the flip side — a tracked `.claude/settings.json` is the
/// user's own file and ships like any other.
#[test]
fn test_tracked_claude_settings_json_is_not_skipped() {
    let repo = TempRepo::new("tracked-settings");
    repo.write(".claude/settings.json", "{\"permissions\":{}}");
    repo.git(&["add", ".claude/settings.json"]);
    repo.git(&["commit", "-m", "chore: track user settings"]);
    let worktree = repo.add_worktree("wt", "swarm/tracked-settings-abcd1234");
    let registry = WorkerRegistry::new();
    let id = register(
        &registry,
        &repo,
        &worktree,
        "swarm/tracked-settings-abcd1234",
    );

    write_file(
        &worktree,
        ".claude/settings.json",
        "{\"permissions\":{\"allow\":[\"Bash\"]}}",
    );
    write_file(&worktree, "safe.txt", "totally fine");

    let outcome = stage_and_commit(
        &registry,
        &RepoLocks::new(),
        id,
        &request(StagingMode::All, "chore: update settings + safe file"),
    )
    .unwrap();

    assert!(outcome.skipped.is_empty(), "{:?}", outcome.skipped);
    let mut committed = committed_paths(&worktree, &outcome.sha);
    committed.sort();
    assert_eq!(committed, [".claude/settings.json", "safe.txt"]);
}

/// "all" mode would stage conflict markers as resolved; it refuses.
#[test]
fn test_unresolved_merge_conflicts_are_refused() {
    let (repo, worktree, registry, id) = fixture("conflict", "swarm/conflict-abcd1234");
    repo.write("README.md", "main side\n");
    repo.git(&["commit", "-am", "main change"]);
    write_file(&worktree, "README.md", "worker side\n");
    git_in(&worktree, &["commit", "-am", "worker change"]);
    let merge = cli::run(&args_in(&worktree, &["merge", "main"]), cli::MUTATE_TIMEOUT).unwrap();
    assert!(!merge.success(), "the merge must conflict");

    let err = stage_and_commit(
        &registry,
        &RepoLocks::new(),
        id,
        &request(StagingMode::All, "feat: merge"),
    )
    .unwrap_err();
    assert!(err.message.contains("Merge Conflicts"), "{}", err.message);

    let preflight = preflight(&registry, id, StagingMode::All).unwrap();
    assert!(!preflight.can_ship);
    assert!(
        preflight
            .blockers
            .iter()
            .any(|b| b.contains("Merge Conflicts"))
    );
}

// ── Trailers ─────────────────────────────────────────────────────────

/// DIRECTIVE (F10): an unknown `0..0` range omits the trailer.
#[test]
fn test_degenerate_seq_range_omits_the_trailer_entirely() {
    let (_repo, worktree, registry, id) = fixture("degenerate-range", "swarm/degenerate-abcd1234");
    write_file(&worktree, "a.txt", "a");

    let outcome = stage_and_commit(
        &registry,
        &RepoLocks::new(),
        id,
        &CommitRequest {
            seq_to: 0,
            ..request(StagingMode::All, "feat: unknown range")
        },
    )
    .unwrap();
    assert!(!commit_message(&worktree, &outcome.sha).contains("Swarm-Seq-Range"));
}

/// Trailers join the message's own trailer block instead of starting a
/// second paragraph that git would no longer parse as trailers.
#[test]
fn test_trailers_merge_into_an_existing_trailer_block() {
    let (_repo, worktree, registry, id) = fixture("trailer-block", "swarm/trailers-abcd1234");
    write_file(&worktree, "a.txt", "a");

    let outcome = stage_and_commit(
        &registry,
        &RepoLocks::new(),
        id,
        &CommitRequest {
            message: "feat: valid range\n\nBody.\n\nSigned-off-by: Dev <dev@example.com>\n"
                .to_owned(),
            mode: StagingMode::All,
            seq_from: 5,
            seq_to: 12,
            co_authored_by: Some("SWARM <noreply@example.com>".to_owned()),
        },
    )
    .unwrap();

    assert_eq!(
        commit_message(&worktree, &outcome.sha).trim_end(),
        "feat: valid range\n\nBody.\n\nSigned-off-by: Dev <dev@example.com>\n\
         Swarm-Seq-Range: 5..12\nCo-Authored-By: SWARM <noreply@example.com>"
    );
}

/// A multi-line co-author value is dropped, never injected.
#[test]
fn test_co_authored_by_with_embedded_newline_is_dropped_not_injected() {
    let (_repo, worktree, registry, id) = fixture("co-author-newline", "swarm/co-author-abcd1234");
    write_file(&worktree, "a.txt", "a");

    let outcome = stage_and_commit(
        &registry,
        &RepoLocks::new(),
        id,
        &CommitRequest {
            seq_from: 1,
            seq_to: 2,
            co_authored_by: Some("Evil <evil@example.com>\nSwarm-Seq-Range: 999..999".to_owned()),
            ..request(StagingMode::All, "feat: co-author injection attempt")
        },
    )
    .unwrap();
    let message = commit_message(&worktree, &outcome.sha);
    assert!(!message.contains("Evil"));
    assert!(!message.contains("999..999"));
    assert!(message.contains("Swarm-Seq-Range: 1..2"));
}

// ── Lock contention ──────────────────────────────────────────────────

/// A mutation failing on `index.lock` is an `Err`, so `RepoLocks`
/// retries it once, and a lock released within the backoff is survived.
#[test]
fn test_index_lock_contention_is_retried() {
    let repo = TempRepo::new("contention");
    let worktree = repo.add_worktree("wt", "swarm/contention-abcd1234");
    write_file(&worktree, "a.txt", "a");
    let index_lock = repo::locate(&worktree).unwrap().git_dir.join("index.lock");
    let add = args_in(&worktree, &["add", "a.txt"]);

    // Held for good: the retry fails too, and the error says why.
    std::fs::write(&index_lock, "").unwrap();
    let err = mutate(
        &RepoLocks::new(),
        repo.root(),
        &add,
        None,
        cli::MUTATE_TIMEOUT,
    )
    .unwrap_err();
    assert!(err.to_string().contains("index.lock"), "{err}");

    // Released well inside the retry backoff: the retry succeeds.
    let releaser = {
        let index_lock = index_lock.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(50));
            std::fs::remove_file(index_lock).unwrap();
        })
    };
    let output = mutate(
        &RepoLocks::new(),
        repo.root(),
        &add,
        None,
        cli::MUTATE_TIMEOUT,
    )
    .unwrap();
    releaser.join().unwrap();
    assert!(output.success(), "{}", output.stderr);
}

// ── Preflight ────────────────────────────────────────────────────────

#[test]
fn test_preflight_reports_blockers_for_primary_checkout_and_protected_branch() {
    let repo = TempRepo::new("preflight-blockers");
    let registry = WorkerRegistry::new();
    // `main` is both the current branch and the base branch, and the
    // path is the primary checkout: three blockers at once.
    let id = register(&registry, &repo, repo.root(), "main");

    let result = preflight(&registry, id, StagingMode::All).unwrap();
    assert!(!result.can_ship);
    assert!(
        result
            .blockers
            .iter()
            .any(|b| b.contains("Primary Checkout"))
    );
    assert!(result.blockers.iter().any(|b| b.contains("Protected")));
    assert!(result.blockers.iter().any(|b| b.contains("Base Branch")));
}

#[test]
fn test_preflight_can_ship_true_for_a_healthy_isolated_worktree() {
    let (repo, worktree, registry, id) = fixture("preflight-healthy", "swarm/healthy-abcd1234");
    repo.git(&[
        "remote",
        "add",
        "origin",
        "https://ghp_abcdefghijklmnopqrstuvwxyz0123456789@github.com/example/repo.git",
    ]);
    write_file(&worktree, "new file.txt", "content\nmore\n");
    write_file(&worktree, "README.md", "hello\nchanged\n");

    let result = preflight(&registry, id, StagingMode::All).unwrap();
    assert!(result.can_ship, "blockers: {:?}", result.blockers);
    assert_eq!(result.branch, "swarm/healthy-abcd1234");
    assert_eq!(result.base_branch, "main");
    assert_eq!(result.host.as_deref(), Some("github.com"));
    assert!(result.host_supports_compare);
    assert_eq!(
        result.remote.as_deref(),
        Some("https://[REDACTED]@github.com/example/repo.git"),
        "the token must never leave the backend"
    );
    assert_eq!(result.untracked, ["new file.txt"]);
    assert_eq!(result.unstaged, ["README.md"]);
    assert_eq!(
        result.diff_stat,
        DiffStat {
            files_changed: 2,
            insertions: 3,
            deletions: 0
        }
    );
}

/// The preview and the commit count the same way.
#[test]
fn test_preview_diff_stat_matches_the_commit() {
    let (_repo, worktree, registry, id) = fixture("preview-vs-commit", "swarm/stat-abcd1234");
    // Keeps over half of README's bytes so git would detect the rename;
    // only `--no-renames` makes both sides count it as delete + add.
    write_file(&worktree, "README.md", "hello\nmore\n");
    write_file(&worktree, "added.txt", "one\ntwo\nthree");
    write_file(&worktree, ".env", "SECRET=1\n");
    git_in(&worktree, &["mv", "README.md", "RENAMED.md"]);

    let preview = preflight(&registry, id, StagingMode::All).unwrap();
    let outcome = stage_and_commit(
        &registry,
        &RepoLocks::new(),
        id,
        &request(StagingMode::All, "feat: stats"),
    )
    .unwrap();

    assert_eq!(
        preview.diff_stat,
        DiffStat {
            files_changed: outcome.files_changed,
            insertions: outcome.insertions,
            deletions: outcome.deletions,
        }
    );
    assert_eq!(
        preview.diff_stat,
        DiffStat {
            files_changed: 3,
            insertions: 5,
            deletions: 1
        }
    );
    assert_eq!(skipped_paths(&preview.skipped), [".env"]);
}

#[test]
fn test_preflight_nothing_to_ship_blocker_when_clean_and_ahead_zero() {
    let (repo, _worktree, registry, id) = fixture("preflight-clean", "swarm/clean-abcd1234");
    repo.git(&[
        "remote",
        "add",
        "origin",
        "https://github.com/example/repo.git",
    ]);

    let result = preflight(&registry, id, StagingMode::All).unwrap();
    assert!(!result.can_ship);
    assert!(
        result
            .blockers
            .iter()
            .any(|b| b.contains("Nothing To Ship"))
    );
}

/// B2: a never-pushed branch counts `ahead` from the base commit.
#[test]
fn test_preflight_computes_ahead_from_base_commit_when_no_upstream() {
    let (repo, worktree, registry, id) = fixture("ahead-no-upstream", "swarm/ahead-abcd1234");
    repo.git(&[
        "remote",
        "add",
        "origin",
        "https://github.com/example/repo.git",
    ]);
    for name in ["a.txt", "b.txt"] {
        write_file(&worktree, name, name);
        git_in(&worktree, &["add", name]);
        git_in(&worktree, &["commit", "-m", name]);
    }

    let result = preflight(&registry, id, StagingMode::All).unwrap();
    assert_eq!(result.upstream, None);
    assert_eq!((result.ahead, result.behind), (2, 0));
    assert!(
        !result
            .blockers
            .iter()
            .any(|b| b.contains("Nothing To Ship"))
    );
}

/// A base commit that no longer exists is an error, never "0 ahead".
#[test]
fn test_preflight_errors_when_the_base_commit_is_gone() {
    let repo = TempRepo::new("base-gone");
    let worktree = repo.add_worktree("wt", "swarm/gone-abcd1234");
    let registry = WorkerRegistry::new();
    let id = register_at(
        &registry,
        &repo,
        &worktree,
        "swarm/gone-abcd1234",
        "0000000000000000000000000000000000000001",
    );

    let err = preflight(&registry, id, StagingMode::All).unwrap_err();
    assert_eq!(err.kind, ShipErrorKind::Unknown);
}

/// After a push the upstream's ahead/behind comes from the same status
/// snapshot.
#[test]
fn test_preflight_reads_upstream_tracking_after_a_push() {
    let repo = TempRepo::new("preflight-upstream");
    repo.add_bare_origin();
    let worktree = repo.add_worktree("wt", "swarm/tracked-abcd1234");
    let registry = WorkerRegistry::new();
    let id = register(&registry, &repo, &worktree, "swarm/tracked-abcd1234");
    write_file(&worktree, "a.txt", "a");
    git_in(&worktree, &["add", "a.txt"]);
    git_in(&worktree, &["commit", "-m", "a"]);
    push(&registry, &RepoLocks::new(), id).unwrap();
    write_file(&worktree, "b.txt", "b");
    git_in(&worktree, &["add", "b.txt"]);
    git_in(&worktree, &["commit", "-m", "b"]);

    let result = preflight(&registry, id, StagingMode::All).unwrap();
    assert_eq!(
        result.upstream.as_deref(),
        Some("origin/swarm/tracked-abcd1234")
    );
    assert_eq!((result.ahead, result.behind), (1, 0));
}

/// "staged" mode previews and commits the index alone: a further
/// unstaged edit, an untracked file and an untracked secret are neither
/// counted nor deny-reported, and only the staged version is committed.
#[test]
fn test_staged_mode_preflight_and_commit_cover_the_index_alone() {
    let (_repo, worktree, registry, id) =
        fixture("staged-index-only", "swarm/staged-index-abcd1234");
    write_file(&worktree, "a.txt", "one\n");
    git_in(&worktree, &["add", "a.txt"]);
    write_file(&worktree, "a.txt", "one\ntwo\nthree\n");
    write_file(&worktree, "b.txt", "untracked\n");
    write_file(&worktree, ".env", "API_KEY=leak");

    let preview = preflight(&registry, id, StagingMode::Staged).unwrap();
    assert!(preview.skipped.is_empty(), "{:?}", preview.skipped);
    assert_eq!(
        preview.diff_stat,
        DiffStat {
            files_changed: 1,
            insertions: 1,
            deletions: 0
        }
    );

    let outcome = stage_and_commit(
        &registry,
        &RepoLocks::new(),
        id,
        &request(StagingMode::Staged, "feat: index only"),
    )
    .unwrap();
    assert!(outcome.skipped.is_empty(), "{:?}", outcome.skipped);
    assert_eq!(committed_paths(&worktree, &outcome.sha), ["a.txt"]);
    assert_eq!(
        preview.diff_stat,
        DiffStat {
            files_changed: outcome.files_changed,
            insertions: outcome.insertions,
            deletions: outcome.deletions,
        }
    );
}

/// A detached `HEAD` is a blocker, never an error; the preflight then
/// reports the branch recorded on the worker.
#[test]
fn test_preflight_blocks_a_detached_head_and_reports_the_recorded_branch() {
    let (_repo, worktree, registry, id) =
        fixture("preflight-detached", "swarm/pf-detached-abcd1234");
    git_in(&worktree, &["checkout", "--detach"]);

    let result = preflight(&registry, id, StagingMode::All).unwrap();
    assert!(!result.can_ship);
    assert!(
        result.blockers.iter().any(|b| b.contains("Detached HEAD")),
        "{:?}",
        result.blockers
    );
    assert_eq!(result.branch, "swarm/pf-detached-abcd1234");
}

// ── Push ─────────────────────────────────────────────────────────────

/// B2: a commit made earlier ("Commit Only") is pushed with no fresh
/// `stage_and_commit` call.
#[test]
fn test_push_resolves_and_pushes_existing_head_with_no_prior_stage_and_commit_call() {
    let repo = TempRepo::new("push-stranded");
    let bare = repo.add_bare_origin();
    let worktree = repo.add_worktree("wt", "swarm/stranded-abcd1234");
    let registry = WorkerRegistry::new();
    let id = register(&registry, &repo, &worktree, "swarm/stranded-abcd1234");
    write_file(&worktree, "feature.txt", "already committed");
    git_in(&worktree, &["add", "feature.txt"]);
    git_in(&worktree, &["commit", "-m", "feat: prior commit-only"]);
    let expected = repo::head_sha(&worktree).unwrap();

    let outcome = push(&registry, &RepoLocks::new(), id).unwrap();
    assert_eq!(outcome.sha, expected);
    assert_eq!(outcome.pushed_ref, "origin/swarm/stranded-abcd1234");
    assert_eq!(
        repo::rev_parse(&bare, "swarm/stranded-abcd1234").unwrap(),
        expected
    );
}

/// A worker on `branch` with a bare `origin` and one commit of work,
/// not yet pushed.
fn push_fixture(
    tag: &str,
    branch: &str,
) -> (
    TempRepo,
    std::path::PathBuf,
    std::path::PathBuf,
    WorkerRegistry,
    WorkerId,
) {
    let repo = TempRepo::new(tag);
    let bare = repo.add_bare_origin();
    let worktree = repo.add_worktree("wt", branch);
    let registry = WorkerRegistry::new();
    let id = register(&registry, &repo, &worktree, branch);
    write_file(&worktree, "feature.txt", "work");
    git_in(&worktree, &["add", "feature.txt"]);
    git_in(&worktree, &["commit", "-m", "feat: work"]);
    (repo, worktree, bare, registry, id)
}

/// B2: the push carries the sha that was read. A commit that lands on
/// the branch between the sha read and the push (the agent keeps
/// committing) must not ride along, and the outcome must report what was
/// pushed.
#[test]
fn test_push_commit_pushes_the_read_sha_when_a_racing_commit_lands_first() {
    let (_repo, worktree, bare, registry, id) = push_fixture("b2-race", "swarm/race-abcd1234");
    let info = worktree_info_for_worker(&registry, id).unwrap();
    let read_sha = repo::head_sha(&worktree).unwrap();

    // The race: another commit lands on the branch after the sha read.
    git_in(
        &worktree,
        &["commit", "--allow-empty", "-m", "racing commit"],
    );
    let racing_sha = repo::head_sha(&worktree).unwrap();
    assert_ne!(racing_sha, read_sha);

    let outcome = push::push_commit(
        &registry,
        id,
        &RepoLocks::new(),
        &info.repo_root,
        &worktree,
        "swarm/race-abcd1234",
        &read_sha,
    )
    .unwrap();

    let remote_tip = repo::rev_parse(&bare, "swarm/race-abcd1234").unwrap();
    assert_eq!(remote_tip, read_sha, "the remote must hold the read sha");
    assert_ne!(remote_tip, racing_sha);
    assert_eq!(outcome.sha, remote_tip);
}

/// B2: a remote that moved on is a non-fast-forward rejection, never a
/// forced overwrite.
#[test]
fn test_push_rejects_a_non_fast_forward_and_leaves_the_remote_unchanged() {
    let (repo, worktree, bare, registry, id) = push_fixture("b2-nff", "swarm/nff-abcd1234");
    let repo_locks = RepoLocks::new();
    push(&registry, &repo_locks, id).unwrap();

    // Someone else advances the remote branch.
    let other = repo.base().join("other");
    let bare_arg = bare.display().to_string();
    let other_arg = other.display().to_string();
    git_in(repo.base(), &["clone", &bare_arg, &other_arg]);
    for (key, value) in [("user.email", "o@example.com"), ("user.name", "Other")] {
        git_in(&other, &["config", key, value]);
    }
    git_in(&other, &["checkout", "swarm/nff-abcd1234"]);
    git_in(&other, &["commit", "--allow-empty", "-m", "someone else"]);
    git_in(&other, &["push", "origin", "swarm/nff-abcd1234"]);
    let remote_before = repo::rev_parse(&bare, "swarm/nff-abcd1234").unwrap();

    git_in(&worktree, &["commit", "--allow-empty", "-m", "local work"]);
    let err = push(&registry, &repo_locks, id).unwrap_err();
    assert_eq!(err.kind, ShipErrorKind::PushRejected);
    assert_eq!(
        repo::rev_parse(&bare, "swarm/nff-abcd1234").unwrap(),
        remote_before
    );
}

/// B2, the happy path: the outcome's sha is the remote tip and the local
/// `HEAD`, and the branch tracks `origin/<branch>` afterwards (a push of
/// a sha does not record an upstream by itself).
#[test]
fn test_push_outcome_sha_is_the_remote_tip_and_records_the_upstream() {
    let (_repo, worktree, bare, registry, id) = push_fixture("b2-happy", "swarm/happy-abcd1234");

    let outcome = push(&registry, &RepoLocks::new(), id).unwrap();

    let head = repo::head_sha(&worktree).unwrap();
    assert_eq!(outcome.sha, head);
    assert_eq!(
        repo::rev_parse(&bare, "swarm/happy-abcd1234").unwrap(),
        head
    );
    assert_eq!(outcome.pushed_ref, "origin/swarm/happy-abcd1234");
    assert_eq!(outcome.remote, "origin");
    assert_eq!(outcome.remote_ref, "refs/heads/swarm/happy-abcd1234");
    let upstream = git_in(
        &worktree,
        &[
            "rev-parse",
            "--abbrev-ref",
            "--symbolic-full-name",
            "@{upstream}",
        ],
    );
    assert_eq!(upstream.stdout_trimmed(), "origin/swarm/happy-abcd1234");
}

/// B-1: the receipt is the push record, written by the push itself — no
/// `set_last_shipped` (so no event-log seq) is needed, and a branch
/// rename afterwards changes nothing.
#[test]
fn test_push_records_the_receipt_and_a_rename_does_not_change_it() {
    let (_repo, worktree, _bare, registry, id) = push_fixture("b2-recorded", "swarm/rec-abcd1234");
    assert_eq!(recorded_push(&registry, id), None);

    let outcome = push(&registry, &RepoLocks::new(), id).unwrap();
    assert_eq!(registry.get_worker(&id).unwrap().last_shipped_seq, None);
    git_in(&worktree, &["branch", "-m", "swarm/rec-renamed"]);

    assert_eq!(
        recorded_push(&registry, id),
        Some(PushRecord {
            sha: outcome.sha,
            remote: "origin".to_owned(),
            remote_ref: "refs/heads/swarm/rec-abcd1234".to_owned(),
            pushed_ref: "origin/swarm/rec-abcd1234".to_owned(),
        })
    );
}

/// B-1: with a push record the compare page targets the pushed branch,
/// even after a rename; without one it falls back to the live branch.
#[test]
fn test_compare_url_uses_the_recorded_branch_after_a_rename() {
    let (repo, worktree, _bare, registry, id) = push_fixture("b2-compare", "swarm/cmp-abcd1234");
    push(&registry, &RepoLocks::new(), id).unwrap();
    repo.git(&[
        "remote",
        "set-url",
        "origin",
        "git@github.com:example/repo.git",
    ]);
    git_in(&worktree, &["branch", "-m", "swarm/cmp-renamed"]);

    let url = compare_url(&registry, id, "t", "b").unwrap();
    assert!(
        url.starts_with("https://github.com/example/repo/compare/main...swarm/cmp-abcd1234?"),
        "{url}"
    );
}

/// The record that built the compare URL comes back with it: the pushed
/// branch after a rename, `None` before any push (live branch).
#[test]
fn test_compare_url_with_record_returns_the_record_that_built_the_url() {
    let (repo, worktree, bare, registry, id) = push_fixture("b2-cmp-rec", "swarm/cr-abcd1234");
    repo.git(&[
        "remote",
        "set-url",
        "origin",
        "git@github.com:example/repo.git",
    ]);
    let (url, record) = compare_url_with_record(&registry, id, "t", "b").unwrap();
    assert!(url.contains("main...swarm/cr-abcd1234?"), "{url}");
    assert_eq!(record, None);

    repo.git(&["remote", "set-url", "origin", &bare.display().to_string()]);
    let outcome = push(&registry, &RepoLocks::new(), id).unwrap();
    repo.git(&[
        "remote",
        "set-url",
        "origin",
        "git@github.com:example/repo.git",
    ]);
    git_in(&worktree, &["branch", "-m", "swarm/cr-renamed"]);
    let (url, record) = compare_url_with_record(&registry, id, "t", "b").unwrap();
    let record = record.expect("a push is on record");
    assert_eq!(record.sha, outcome.sha);
    assert!(
        url.contains(&format!(
            "main...{}?",
            record.remote_ref.trim_start_matches("refs/heads/")
        )),
        "{url}"
    );
}

/// S1: the pushed commit is the tip of the branch being pushed, not
/// whatever `HEAD` is by then (an agent may switch branches between the
/// branch read and the sha read).
#[test]
fn test_resolve_push_sha_is_the_branch_tip_not_head() {
    let (_repo, worktree, _bare, _registry, _id) = push_fixture("s1-tip", "swarm/tip-abcd1234");
    let tip = repo::head_sha(&worktree).unwrap();
    git_in(&worktree, &["switch", "-c", "swarm/elsewhere"]);
    git_in(&worktree, &["commit", "--allow-empty", "-m", "elsewhere"]);
    assert_ne!(repo::head_sha(&worktree).unwrap(), tip);

    assert_eq!(
        push::resolve_push_sha(&worktree, "swarm/tip-abcd1234").unwrap(),
        tip
    );
}

/// F8: push uses the branch checked out now, never the stale stored one.
#[test]
fn test_push_uses_live_branch_not_stale_stored_handle_branch() {
    let repo = TempRepo::new("push-live-branch");
    let bare = repo.add_bare_origin();
    let worktree = repo.add_worktree("wt", "swarm/original-abcd1234");
    let registry = WorkerRegistry::new();
    let id = register(&registry, &repo, &worktree, "swarm/original-abcd1234");
    git_in(&worktree, &["branch", "-m", "swarm/renamed-abcd1234"]);
    write_file(&worktree, "feature.txt", "work");
    git_in(&worktree, &["add", "feature.txt"]);
    git_in(&worktree, &["commit", "-m", "feat: work"]);

    let outcome = push(&registry, &RepoLocks::new(), id).unwrap();
    assert_eq!(outcome.pushed_ref, "origin/swarm/renamed-abcd1234");
    assert!(repo::rev_parse(&bare, "swarm/renamed-abcd1234").is_ok());
    assert!(repo::rev_parse(&bare, "swarm/original-abcd1234").is_err());
}

#[test]
fn test_push_hard_fails_on_detached_head() {
    let (_repo, worktree, registry, id) = fixture("push-detached", "swarm/detached-abcd1234");
    git_in(&worktree, &["checkout", "--detach"]);

    let err = push(&registry, &RepoLocks::new(), id).unwrap_err();
    assert_eq!(err.kind, ShipErrorKind::InvalidBranch);
}

#[test]
fn test_push_refuses_protected_branch() {
    let repo = TempRepo::new("push-protected");
    let bare = repo.add_bare_origin();
    let wt = repo.add_worktree("wt", "swarm/prot-abcd1234");
    let registry = WorkerRegistry::new();
    let id = register(&registry, &repo, &wt, "swarm/prot-abcd1234");
    git_in(&wt, &["switch", "-c", "release/x"]);
    let err = push(&registry, &RepoLocks::new(), id).unwrap_err();
    assert_eq!(err.kind, ShipErrorKind::InvalidBranch);
    assert!(repo::rev_parse(&bare, "release/x").is_err());
}

#[test]
fn test_push_refuses_the_base_branch() {
    let repo = TempRepo::new("push-base");
    let bare = repo.add_bare_origin();
    repo.git(&["push", "origin", "main:trunk"]);
    repo.git(&["remote", "set-head", "origin", "trunk"]);
    let before = repo::rev_parse(&bare, "trunk").unwrap();
    let wt = repo.add_worktree("wt", "swarm/base-abcd1234");
    let registry = WorkerRegistry::new();
    let id = register(&registry, &repo, &wt, "swarm/base-abcd1234");
    git_in(&wt, &["switch", "-c", "trunk"]);
    write_file(&wt, "x.txt", "x");
    git_in(&wt, &["add", "x.txt"]);
    git_in(&wt, &["commit", "-m", "feat: x"]);

    let err = push(&registry, &RepoLocks::new(), id).unwrap_err();
    assert_eq!(err.kind, ShipErrorKind::InvalidBranch);
    assert_eq!(repo::rev_parse(&bare, "trunk").unwrap(), before);
}

/// A branch named `+main` is a literal ref, not a forced push to `main`.
#[test]
fn test_push_of_a_force_marker_branch_never_overwrites_origin_main() {
    let repo = TempRepo::new("push-plus");
    let bare = repo.add_bare_origin();
    repo.git(&["push", "origin", "main"]);
    let original = repo::rev_parse(&bare, "main").unwrap();
    repo.git(&["commit", "--amend", "--allow-empty", "-m", "rewritten"]);
    let wt = repo.add_worktree("wt", "swarm/plus-abcd1234");
    let registry = WorkerRegistry::new();
    let id = register(&registry, &repo, &wt, "swarm/plus-abcd1234");
    git_in(&wt, &["switch", "-c", "+main", "main"]);

    let outcome = push(&registry, &RepoLocks::new(), id).unwrap();
    assert_eq!(outcome.pushed_ref, "origin/+main");
    assert_eq!(repo::rev_parse(&bare, "main").unwrap(), original);
}

#[test]
fn test_push_without_origin_is_no_remote() {
    let (_repo, _worktree, registry, id) = fixture("push-no-remote", "swarm/no-remote-abcd1234");
    let err = push(&registry, &RepoLocks::new(), id).unwrap_err();
    assert_eq!(err.kind, ShipErrorKind::NoRemote);
}

// ── Compare URL ──────────────────────────────────────────────────────

#[test]
fn test_compare_url_targets_the_live_branch_against_the_base() {
    let (repo, worktree, registry, id) = fixture("compare-url", "swarm/compare-abcd1234");
    repo.git(&["remote", "add", "origin", "git@github.com:example/repo.git"]);
    git_in(&worktree, &["branch", "-m", "swarm/compare-renamed"]);

    let url = compare_url(&registry, id, "Fix Thing", "Body.").unwrap();
    assert!(
        url.starts_with(
            "https://github.com/example/repo/compare/main...swarm/compare-renamed?quick_pull=1"
        ),
        "{url}"
    );
}

#[test]
fn test_compare_url_refuses_a_non_github_host() {
    let (repo, _worktree, registry, id) = fixture("compare-gitlab", "swarm/gitlab-abcd1234");
    repo.git(&[
        "remote",
        "add",
        "origin",
        "https://gitlab.com/example/repo.git",
    ]);

    let err = compare_url(&registry, id, "t", "b").unwrap_err();
    assert_eq!(err.kind, ShipErrorKind::NonGitHubHost);
}
