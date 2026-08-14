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

/// Argv for `git -C <repo_root> -c core.longpaths=true rev-parse HEAD`.
fn rev_parse_head_args(repo_root: &Path) -> Vec<String> {
    let mut args = base_args(repo_root);
    args.push("rev-parse".to_string());
    args.push("HEAD".to_string());
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

/// Resolves `HEAD`'s commit sha in the repo rooted at `repo_root`.
///
/// # Errors
///
/// * [`AppError::Git`] — `HEAD` could not be resolved (e.g. an
///   unborn/empty repository with no commits yet), `git` could not be
///   spawned, or the operation timed out.
pub fn head_sha(repo_root: &Path) -> Result<String, AppError> {
    let output = cli::run(&rev_parse_head_args(repo_root), READ_TIMEOUT)?;
    if !output.success() {
        return Err(AppError::Git(format!(
            "failed to resolve HEAD in {}: {}",
            repo_root.display(),
            output.stderr.trim()
        )));
    }
    let sha = output.stdout.trim();
    if sha.is_empty() {
        return Err(AppError::Git(format!(
            "git rev-parse HEAD returned empty output for {}",
            repo_root.display()
        )));
    }
    Ok(sha.to_string())
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
    fn test_rev_parse_head_args_carries_shared_prefix() {
        let dir = PathBuf::from("/tmp/repo");
        let args = rev_parse_head_args(&dir);
        assert_eq!(&args[..4], &base_args(&dir)[..]);
        assert_eq!(args[4], "rev-parse");
        assert_eq!(args[5], "HEAD");
    }

    #[test]
    fn test_discover_toplevel_rejects_non_repo_dir() {
        let tmp = std::env::temp_dir().join(format!("swarm-not-a-repo-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&tmp).unwrap();
        let result = discover_toplevel(&tmp);
        assert!(result.is_err());
        std::fs::remove_dir_all(&tmp).ok();
    }
}
