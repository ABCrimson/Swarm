//! Repo discovery: toplevel and admin-directory resolution, and
//! revision → commit sha lookup. Every argv here starts with `cli::args_in`.

use std::path::{Path, PathBuf};

use super::cli::{self, READ_TIMEOUT};
// Re-exported so the `ship` submodules keep importing `repo::args_in`; the
// builder itself lives in `cli`.
pub(crate) use super::cli::args_in;
use crate::error::AppError;

/// Argv for `git rev-parse --show-toplevel`.
fn rev_parse_toplevel_args(dir: &Path) -> Vec<String> {
    args_in(dir, &["rev-parse", "--show-toplevel"])
}

/// Argv for `git rev-parse --verify --end-of-options <rev>^{commit}`.
///
/// `--verify` makes git fail on anything that is not exactly one valid
/// object name — without it a same-named file at the repo root passes
/// straight through as if it were a sha. `--end-of-options` keeps a
/// `rev` starting with `-` from being parsed as an option, and the
/// `^{commit}` peel resolves an annotated tag to the commit it tags.
fn rev_parse_args(repo_root: &Path, rev: &str) -> Vec<String> {
    args_in(
        repo_root,
        &[
            "rev-parse",
            "--verify",
            "--end-of-options",
            &format!("{rev}^{{commit}}"),
        ],
    )
}

/// The error for a failed `git rev-parse` in `dir`. It says "is not
/// inside a git repository" only when git said so; otherwise it gives
/// git's own reason (a missing directory, dubious ownership).
fn rev_parse_failure(dir: &Path, output: &cli::GitOutput) -> AppError {
    let reason = if output.raw_stderr().contains("not a git repository") {
        "is not inside a git repository"
    } else {
        "could not be resolved by git rev-parse"
    };
    AppError::Git(format!(
        "{} {reason}: {}",
        dir.display(),
        output.stderr.trim()
    ))
}

/// Resolves `dir`'s repository toplevel (the directory containing
/// `.git`), following git's own rules (works from any subdirectory).
///
/// # Errors
///
/// * [`AppError::Git`] — `dir` is not absolute (an empty path included,
///   which `git -C` would treat as the process's own cwd), is not inside
///   a git repository or git could not resolve it (a missing directory,
///   dubious ownership), or `git` could not be spawned.
/// * [`AppError::GitTimeout`] — the query exceeded its budget.
pub fn discover_toplevel(dir: &Path) -> Result<PathBuf, AppError> {
    if !dir.is_absolute() {
        return Err(AppError::Git(format!(
            "repository path must be absolute: {:?}",
            dir.display().to_string()
        )));
    }
    let output = cli::run(&rev_parse_toplevel_args(dir), READ_TIMEOUT)?;
    if !output.success() {
        return Err(rev_parse_failure(dir, &output));
    }
    let toplevel = output.stdout_trimmed();
    if toplevel.is_empty() {
        return Err(AppError::Git(format!(
            "git rev-parse --show-toplevel returned empty output for {}",
            dir.display()
        )));
    }
    Ok(PathBuf::from(toplevel))
}

/// Where a checkout lives: its toplevel, its own admin directory
/// (`--git-dir`) and the repository's shared one (`--git-common-dir`),
/// all absolute.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Location {
    /// The checkout's toplevel directory.
    pub toplevel: PathBuf,
    /// The checkout's own admin directory: `<repo>/.git` for the primary
    /// checkout, `<repo>/.git/worktrees/<name>` for a linked worktree.
    pub git_dir: PathBuf,
    /// The repository's shared `.git` directory.
    pub common_dir: PathBuf,
}

impl Location {
    /// Whether this checkout is the repository's primary checkout: only
    /// there is the admin directory the shared one. A linked worktree's
    /// `--git-dir` always differs from `--git-common-dir`.
    #[must_use = "the check is the only result"]
    pub fn is_primary_checkout(&self) -> bool {
        canonical(&self.git_dir) == canonical(&self.common_dir)
    }

    /// Whether `dir` is exactly this checkout's toplevel — not a
    /// subdirectory of it, and not a path that has since been moved or
    /// deleted.
    #[must_use = "the check is the only result"]
    pub fn is_toplevel(&self, dir: &Path) -> bool {
        canonical(&self.toplevel) == canonical(dir)
    }
}

/// `path` with symlinks and `.`/`..` resolved when it exists, else as
/// given — both sides of a comparison go through the same function.
fn canonical(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
}

/// Resolves [`Location`] for `dir` in one `git rev-parse
/// --path-format=absolute --show-toplevel --git-dir --git-common-dir`
/// call.
///
/// # Errors
///
/// * [`AppError::Git`] — `dir` is not inside a git repository or git
///   could not resolve it (a missing directory, dubious ownership), or
///   the output did not have the expected three lines.
/// * [`AppError::GitTimeout`] — the query exceeded its budget.
pub fn locate(dir: &Path) -> Result<Location, AppError> {
    let args = args_in(
        dir,
        &[
            "rev-parse",
            "--path-format=absolute",
            "--show-toplevel",
            "--git-dir",
            "--git-common-dir",
        ],
    );
    let output = cli::run(&args, READ_TIMEOUT)?;
    if !output.success() {
        return Err(rev_parse_failure(dir, &output));
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let mut lines = text.lines().map(PathBuf::from);
    match (lines.next(), lines.next(), lines.next()) {
        (Some(toplevel), Some(git_dir), Some(common_dir)) => Ok(Location {
            toplevel,
            git_dir,
            common_dir,
        }),
        _ => Err(AppError::Git(format!(
            "unexpected `git rev-parse` output for {}",
            dir.display()
        ))),
    }
}

/// Resolves a revision (a branch name, `HEAD`, a tag, a sha) to its
/// commit sha in the repo rooted at `repo_root`. Works for a branch
/// even after the worktree that checked it out was removed — branches
/// live in the shared ref database, not in the worktree directory.
///
/// # Errors
///
/// * [`AppError::Git`] — `rev` does not name a commit (unknown ref, an
///   unborn repository, a file name), or `git` could not be spawned.
/// * [`AppError::GitTimeout`] — the query exceeded its budget.
pub fn rev_parse(repo_root: &Path, rev: &str) -> Result<String, AppError> {
    let output = cli::run(&rev_parse_args(repo_root, rev), READ_TIMEOUT)?;
    if !output.success() {
        return Err(AppError::Git(format!(
            "failed to resolve {rev} in {}: {}",
            repo_root.display(),
            output.stderr.trim()
        )));
    }
    let sha = output.stdout_trimmed();
    if sha.is_empty() {
        return Err(AppError::Git(format!(
            "git rev-parse {rev} returned empty output for {}",
            repo_root.display()
        )));
    }
    Ok(sha)
}

/// Resolves `HEAD`'s commit sha in the repo rooted at `repo_root` — a
/// thin wrapper over [`rev_parse`], with the same errors.
///
/// # Errors
///
/// See [`rev_parse`].
pub fn head_sha(repo_root: &Path) -> Result<String, AppError> {
    rev_parse(repo_root, "HEAD")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::cli::base_args;
    use crate::git::test_support::TempRepo;

    #[test]
    fn test_rev_parse_toplevel_args_carries_shared_prefix() {
        let dir = Path::new("/tmp/repo");
        let args = rev_parse_toplevel_args(dir);
        assert_eq!(args[..4], base_args(dir)[..]);
        assert_eq!(args[4..], ["rev-parse", "--show-toplevel"]);
    }

    #[test]
    fn test_rev_parse_args_verify_and_peel_to_a_commit() {
        let dir = Path::new("/tmp/repo");
        let args = rev_parse_args(dir, "swarm/agent-abcd1234");
        assert_eq!(args[..4], base_args(dir)[..]);
        assert_eq!(
            args[4..],
            [
                "rev-parse",
                "--verify",
                "--end-of-options",
                "swarm/agent-abcd1234^{commit}"
            ]
        );
    }

    #[test]
    fn test_discover_toplevel_rejects_non_repo_dir() {
        let tmp = std::env::temp_dir().join(format!("swarm-not-a-repo-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&tmp).unwrap();
        assert!(discover_toplevel(&tmp).is_err());
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn test_discover_toplevel_names_the_rev_parse_failure_truthfully() {
        let tmp = std::env::temp_dir().join(format!("swarm-not-a-repo-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&tmp).unwrap();
        let not_repo = discover_toplevel(&tmp).unwrap_err().to_string();
        std::fs::remove_dir_all(&tmp).ok();
        assert!(
            not_repo.contains("is not inside a git repository"),
            "{not_repo}"
        );
        let missing = std::env::temp_dir().join(format!("swarm-missing-{}", uuid::Uuid::new_v4()));
        let err = discover_toplevel(&missing).unwrap_err().to_string();
        assert!(
            err.contains("could not be resolved by git rev-parse"),
            "{err}"
        );
        assert!(!err.contains("is not inside a git repository"), "{err}");
    }

    #[test]
    fn test_discover_toplevel_rejects_empty_and_relative_paths() {
        assert!(discover_toplevel(Path::new("")).is_err());
        assert!(discover_toplevel(Path::new("..")).is_err());
    }

    #[test]
    fn test_rev_parse_rejects_unknown_rev() {
        let repo = TempRepo::new("rev-parse-unknown");
        assert!(rev_parse(repo.root(), "definitely-not-a-real-branch").is_err());
    }

    /// Without `--verify`, `git rev-parse README.md` prints `README.md`
    /// and exits 0 — a file name would pass as a "sha".
    #[test]
    fn test_rev_parse_rejects_a_file_name_and_an_option_shaped_rev() {
        let repo = TempRepo::new("rev-parse-file");
        assert!(rev_parse(repo.root(), "README.md").is_err());
        assert!(rev_parse(repo.root(), "--all").is_err());
    }

    #[test]
    fn test_rev_parse_peels_an_annotated_tag_to_its_commit() {
        let repo = TempRepo::new("rev-parse-tag");
        repo.git(&["tag", "-a", "v1", "-m", "release"]);
        let head = head_sha(repo.root()).unwrap();
        assert_eq!(rev_parse(repo.root(), "v1").unwrap(), head);
    }

    #[test]
    fn test_locate_tells_the_primary_checkout_from_a_linked_worktree() {
        let repo = TempRepo::new("locate");
        let primary = locate(repo.root()).unwrap();
        assert!(primary.is_primary_checkout());
        assert!(primary.is_toplevel(repo.root()));

        let worktree = repo.add_worktree("wt", "swarm/locate-abcd1234");
        let linked = locate(&worktree).unwrap();
        assert!(!linked.is_primary_checkout());
        assert!(linked.is_toplevel(&worktree));
        assert!(!linked.is_toplevel(repo.root()));
    }
}
