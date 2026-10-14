//! Filesystem paths shared by every shell that embeds `swarm-core`.
//!
//! A single identifier-scoped data directory anchors the event log,
//! the config file, and `sessions.json` ([`crate::session::persist`]).
//! `swarm-core` never resolves this directory itself — that is
//! inherently platform/shell-specific (e.g. Tauri's
//! `app.path().app_data_dir()`) — the shell constructs [`Paths`] once at
//! startup and passes it in.
//!
//! The one directory `swarm-core` does resolve itself is the user's home
//! ([`home_dir`]): the root of the default worktrees directory
//! `~/.swarm/worktrees` and of the home scope `read_file` and
//! `write_file` allow.

use std::path::PathBuf;

use crate::error::AppError;

/// Resolved data directory for this run.
#[derive(Debug, Clone)]
pub struct Paths {
    /// Root directory for all persisted swarm-core state (event log,
    /// config file, session store). Must already exist — the shell is
    /// responsible for creating it before constructing `Paths`.
    pub data_dir: PathBuf,
}

/// Resolves the user's home directory with [`std::env::home_dir`]: `$HOME`
/// (then the password database) on Unix, the profile folder on Windows
/// — the same folder Tauri resolves `$HOME` to in the
/// `opener:allow-open-path` scope `$HOME/.swarm/worktrees/**` (see
/// `src-tauri/capabilities/default.json`). This is the root of
/// `~/.swarm/worktrees/**` and of the home scope `read_file` and
/// `write_file` allow.
///
/// # Errors
///
/// * [`AppError::Io`] — the platform reports no home directory
///   ([`std::io::ErrorKind::NotFound`]). Not a git failure: callers
///   such as the file commands never run git.
pub(crate) fn home_dir() -> Result<PathBuf, AppError> {
    home_dir_from(std::env::home_dir)
}

/// [`home_dir`] with the platform lookup injected, so a test can model a
/// host that has no home without mutating the process environment. An
/// empty path counts as no home.
fn home_dir_from(lookup: impl FnOnce() -> Option<PathBuf>) -> Result<PathBuf, AppError> {
    lookup()
        .filter(|home| !home.as_os_str().is_empty())
        .ok_or_else(|| {
            AppError::Io(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "could not resolve the home directory",
            ))
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_home_dir_resolves() {
        let home = home_dir().expect("the test environment has a home directory");
        assert!(!home.as_os_str().is_empty());
    }

    #[test]
    fn test_home_dir_from_returns_the_looked_up_path() {
        let home = home_dir_from(|| Some(PathBuf::from("/home/swarm"))).unwrap();
        assert_eq!(home, PathBuf::from("/home/swarm"));
    }

    #[test]
    fn test_home_dir_from_missing_or_empty_is_a_non_git_io_error() {
        for lookup in [None, Some(PathBuf::new())] {
            let err = home_dir_from(|| lookup).unwrap_err();
            assert!(
                matches!(&err, AppError::Io(e) if e.kind() == std::io::ErrorKind::NotFound),
                "{err:?}"
            );
            assert_eq!(
                err.to_string(),
                "IO error: could not resolve the home directory"
            );
        }
    }
}
