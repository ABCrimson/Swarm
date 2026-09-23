//! Repo discovery: toplevel resolution and `HEAD` sha lookup.
//!
//! Every argv builder here prepends the shared `-C <dir> -c
//! core.longpaths=true` prefix (see [`base_args`]) — `-C` scopes the
//! invocation to the target directory without ever calling
//! `Command::current_dir` (keeping the working directory of the
//! *caller* process untouched), and `core.longpaths=true` is set
//! per-invocation (never written to the user's global/repo config) so
//! long checkout paths under `~/.swarm/worktrees/**` don't hit
//! Windows' legacy `MAX_PATH` limit.

use std::path::{Path, PathBuf};

use super::cli::{self, READ_TIMEOUT};
use crate::error::AppError;

/// Shared argv prefix for every invocation in this module: `-C <dir>
/// -c core.longpaths=true`. Kept as its own function (rather than
/// inlined in each builder) so a unit test can assert every builder's
/// output actually starts with it.
pub(crate) fn base_args(dir: &Path) -> Vec<String> {
    vec![
        "-C".to_string(),
        dir.display().to_string(),
        "-c".to_string(),
        "core.longpaths=true".to_string(),
    ]
}

/// Argv for `git -C <dir> -c core.longpaths=true rev-parse --show-toplevel`.
fn rev_parse_toplevel_args(dir: &Path) -> Vec<String> {
    let mut args = base_args(dir);
    args.push("rev-parse".to_string());
    args.push("--show-toplevel".to_string());
    args
}

/// Argv for `git -C <repo_root> -c core.longpaths=true rev-parse <rev>`.
fn rev_parse_args(repo_root: &Path, rev: &str) -> Vec<String> {
    let mut args = base_args(repo_root);
    args.push("rev-parse".to_string());
    args.push(rev.to_string());
    args
}

/// Resolves `dir`'s repository toplevel (the directory containing
/// `.git`), following the same rules `git` itself uses (works from any
/// subdirectory of the repo).
///
/// # Errors
///
/// * [`AppError::Git`] — `dir` is not inside a git repository, `git`
///   could not be spawned, or the operation timed out.
pub fn discover_toplevel(dir: &Path) -> Result<PathBuf, AppError> {
    let output = cli::run(&rev_parse_toplevel_args(dir), READ_TIMEOUT)?;
    if !output.success() {
        return Err(AppError::Git(format!(
            "{} is not inside a git repository: {}",
            dir.display(),
            output.stderr.trim()
        )));
    }
    let toplevel = output.stdout.trim();
    if toplevel.is_empty() {
        return Err(AppError::Git(format!(
            "git rev-parse --show-toplevel returned empty output for {}",
            dir.display()
        )));
    }
    Ok(PathBuf::from(toplevel))
}

/// Resolves an arbitrary revision (a branch name, `HEAD`, a sha, etc)
/// to its commit sha in the repo rooted at `repo_root`. Works for a
/// branch ref even after the worktree that checked it out has been
/// removed — branches live in the shared `.git` object/ref database,
/// not in the (possibly-gone) worktree directory.
///
/// # Errors
///
/// * [`AppError::Git`] — `rev` could not be resolved (unknown ref, an
///   unborn/empty repository with no commits yet), `git` could not be
///   spawned, or the operation timed out.
pub fn rev_parse(repo_root: &Path, rev: &str) -> Result<String, AppError> {
    let output = cli::run(&rev_parse_args(repo_root, rev), READ_TIMEOUT)?;
    if !output.success() {
        return Err(AppError::Git(format!(
            "failed to resolve {rev} in {}: {}",
            repo_root.display(),
            output.stderr.trim()
        )));
    }
    let sha = output.stdout.trim();
    if sha.is_empty() {
        return Err(AppError::Git(format!(
            "git rev-parse {rev} returned empty output for {}",
            repo_root.display()
        )));
    }
    Ok(sha.to_string())
}

/// Resolves `HEAD`'s commit sha in the repo rooted at `repo_root`.
/// Thin wrapper over [`rev_parse`] — see its docs for error conditions.
pub fn head_sha(repo_root: &Path) -> Result<String, AppError> {
    rev_parse(repo_root, "HEAD")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn test_base_args_shape() {
        let args = base_args(&PathBuf::from("/tmp/repo"));
        assert_eq!(args[0], "-C");
        assert!(args[1].contains("repo"));
        assert_eq!(args[2], "-c");
        assert_eq!(args[3], "core.longpaths=true");
    }

    #[test]
    fn test_rev_parse_toplevel_args_carries_shared_prefix() {
        let dir = PathBuf::from("/tmp/repo");
        let args = rev_parse_toplevel_args(&dir);
        assert_eq!(&args[..4], &base_args(&dir)[..]);
        assert_eq!(args[4], "rev-parse");
        assert_eq!(args[5], "--show-toplevel");
    }

    #[test]
    fn test_rev_parse_args_carries_shared_prefix() {
        let dir = PathBuf::from("/tmp/repo");
        let args = rev_parse_args(&dir, "HEAD");
        assert_eq!(&args[..4], &base_args(&dir)[..]);
        assert_eq!(args[4], "rev-parse");
        assert_eq!(args[5], "HEAD");
    }

    #[test]
    fn test_rev_parse_args_accepts_arbitrary_rev() {
        let dir = PathBuf::from("/tmp/repo");
        let args = rev_parse_args(&dir, "swarm/agent-abcd1234");
        assert_eq!(args[5], "swarm/agent-abcd1234");
    }

    #[test]
    fn test_discover_toplevel_rejects_non_repo_dir() {
        let tmp = std::env::temp_dir().join(format!("swarm-not-a-repo-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&tmp).unwrap();
        let result = discover_toplevel(&tmp);
        assert!(result.is_err());
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn test_rev_parse_rejects_unknown_rev() {
        let tmp =
            std::env::temp_dir().join(format!("swarm-rev-parse-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&tmp).unwrap();
        let init = cli::run(
            &["init".to_string(), tmp.display().to_string()],
            READ_TIMEOUT,
        )
        .unwrap();
        assert!(init.success());
        let result = rev_parse(&tmp, "definitely-not-a-real-branch");
        assert!(result.is_err());
        std::fs::remove_dir_all(&tmp).ok();
    }
}
