//! Disposable real-git fixtures for the git module's integration tests.
//! Every test that needs a repository builds it through [`TempRepo`],
//! so the setup (identity, default branch, hermetic config) lives in
//! one place.

use std::path::{Path, PathBuf};

use uuid::Uuid;

use super::cli::{self, CREATE_TIMEOUT, GitOutput};
use super::repo::args_in;

/// Runs `git -C <dir> args…` and asserts it succeeded.
#[track_caller]
pub(crate) fn git_in(dir: &Path, args: &[&str]) -> GitOutput {
    let argv = args_in(dir, args);
    let out = cli::run(&argv, CREATE_TIMEOUT).expect("git should run");
    assert!(out.success(), "git {args:?} failed: {}", out.stderr);
    out
}

/// A throwaway repository under the system temp directory: `init -b
/// main`, a local identity, `init.defaultBranch=main`, and one commit
/// adding `README.md`. Everything created beside it under
/// [`Self::base`] — linked worktrees, a bare `origin` — is deleted
/// together with it on drop.
pub(crate) struct TempRepo {
    base: PathBuf,
    root: PathBuf,
}

impl TempRepo {
    /// Creates the repository; `tag` names the temp directory so a
    /// leftover one identifies the test that made it.
    #[track_caller]
    pub(crate) fn new(tag: &str) -> Self {
        let base = std::env::temp_dir().join(format!("swarm-git-{tag}-{}", Uuid::new_v4()));
        let root = base.join("repo");
        std::fs::create_dir_all(&root).expect("create the temp repo directory");
        let repo = Self { base, root };
        repo.git(&["init", "-b", "main"]);
        for (key, value) in [
            ("user.email", "swarm-test@example.com"),
            ("user.name", "Swarm Test"),
            // Deterministic base-branch fallback regardless of the
            // host's global config.
            ("init.defaultBranch", "main"),
            // Hermetic against a developer's global signing and
            // line-ending settings.
            ("commit.gpgsign", "false"),
            ("tag.gpgsign", "false"),
            ("core.autocrlf", "false"),
        ] {
            repo.git(&["config", key, value]);
        }
        repo.write("README.md", "hello\n");
        repo.git(&["add", "README.md"]);
        repo.git(&["commit", "-m", "initial"]);
        repo
    }

    /// The repository's toplevel.
    pub(crate) fn root(&self) -> &Path {
        &self.root
    }

    /// The directory holding the repository and its siblings.
    pub(crate) fn base(&self) -> &Path {
        &self.base
    }

    /// Runs `git args…` in the repository, asserting success.
    #[track_caller]
    pub(crate) fn git(&self, args: &[&str]) -> GitOutput {
        git_in(&self.root, args)
    }

    /// Writes `contents` to `rel` inside the repository, creating
    /// parent directories.
    #[track_caller]
    pub(crate) fn write(&self, rel: &str, contents: &str) {
        write_file(&self.root, rel, contents);
    }

    /// Adds a linked worktree `<base>/<name>` on a new `branch` at
    /// `HEAD`, returning its path.
    #[track_caller]
    pub(crate) fn add_worktree(&self, name: &str, branch: &str) -> PathBuf {
        let path = self.base.join(name);
        let path_arg = path.display().to_string();
        self.git(&["worktree", "add", "-b", branch, &path_arg, "HEAD"]);
        path
    }

    /// Creates a bare repository `<base>/origin.git` whose default
    /// branch is the one checked out here, registers it as `origin`,
    /// and pushes that branch to it. Returns the bare repository's path.
    #[track_caller]
    pub(crate) fn add_bare_origin(&self) -> PathBuf {
        let branch = self
            .git(&["symbolic-ref", "--short", "HEAD"])
            .stdout_trimmed();
        let bare = self.base.join("origin.git");
        let bare_arg = bare.display().to_string();
        std::fs::create_dir_all(&bare).expect("create the bare remote directory");
        git_in(&bare, &["init", "--bare", "-b", &branch]);
        self.git(&["remote", "add", "origin", &bare_arg]);
        self.git(&["push", "origin", &branch]);
        bare
    }
}

impl Drop for TempRepo {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.base);
    }
}

/// Writes `contents` to `dir/rel`, creating parent directories.
#[track_caller]
pub(crate) fn write_file(dir: &Path, rel: &str, contents: &str) {
    let path = dir.join(rel);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).expect("create parent directories");
    }
    std::fs::write(&path, contents).expect("write the fixture file");
}
