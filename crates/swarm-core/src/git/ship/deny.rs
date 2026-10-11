//! The secret/size deny list every file a ship would commit passes
//! through first.

use std::collections::HashSet;
use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};

/// Files larger than this (5 MiB) are never staged.
pub(super) const MAX_STAGED_FILE_BYTES: u64 = 5 * 1024 * 1024;

/// A file the deny list kept out of a commit, with its Title Case
/// reason.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkippedFile {
    /// The path, relative to the worktree root.
    pub path: String,
    /// Why it was skipped (e.g. "Skipped — Looks Like A Credential").
    pub reason: String,
}

/// `true` when `rel_path`'s basename is `settings.json` and some
/// component of its path is literally `.claude` — the worktree root's
/// `.claude/settings.json` and any nested one. A pure path-shape check;
/// see [`deny_reason`] for why the shape alone never denies a path.
fn is_claude_settings_json(rel_path: &str) -> bool {
    let path = Path::new(rel_path);
    path.file_name().and_then(|n| n.to_str()) == Some("settings.json")
        && path.components().any(|c| c.as_os_str() == ".claude")
}

/// Why `rel_path` must be kept out of a commit, or `None` to allow it:
///
/// - a credential-shaped name — a basename (case-insensitive) starting
///   with `.env` or an SSH key name (`id_rsa`, `id_ed25519`, `id_ecdsa`,
///   `id_dsa`) or ending in `.pem`, `.key`, `.p12` or `.pfx`, or `secret`
///   anywhere in the full relative path (so `config/secrets/api.yaml`
///   is caught although its basename looks innocuous);
/// - larger than [`MAX_STAGED_FILE_BYTES`], measured on the working-tree
///   copy in `worktree` right now (a deleted path can only be denied by
///   name);
/// - an **untracked** `.claude/settings.json` (`is_untracked`, from a
///   `?` status entry).
///
/// # The untracked `.claude/settings.json` rule
///
/// SWARM never writes a `.claude/settings.json` into a worktree (the
/// Claude Code adapter passes its settings inline), so an untracked
/// copy is an out-of-band write, never something anyone meant to
/// ship. A **tracked** copy is
/// the user's own file, and whether to ship it is their call, like any
/// other tracked file — so a copy that is already staged (a human's or
/// the agent's own `git add`) counts as tracked and is never denied on
/// this basis. The rule therefore reflects the status snapshot a ship
/// takes, not a standing guarantee about the file.
pub(super) fn deny_reason(worktree: &Path, rel_path: &str, is_untracked: bool) -> Option<String> {
    if is_untracked && is_claude_settings_json(rel_path) {
        return Some("Skipped — SWARM Configuration File".to_owned());
    }

    let basename = Path::new(rel_path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(rel_path)
        .to_ascii_lowercase();
    let looks_like_credential = basename.starts_with(".env")
        || [".pem", ".key", ".p12", ".pfx"]
            .iter()
            .any(|&suffix| basename.ends_with(suffix))
        || ["id_rsa", "id_ed25519", "id_ecdsa", "id_dsa"]
            .iter()
            .any(|&prefix| basename.starts_with(prefix))
        || rel_path.to_ascii_lowercase().contains("secret");
    if looks_like_credential {
        return Some("Skipped — Looks Like A Credential".to_owned());
    }

    if let Ok(meta) = fs::metadata(worktree.join(rel_path))
        && meta.is_file()
        && meta.len() > MAX_STAGED_FILE_BYTES
    {
        return Some("Skipped — Larger Than 5 MB".to_owned());
    }

    None
}

/// Splits `candidates` into the paths that may be committed and the
/// ones the deny list keeps out. A candidate counts as untracked when
/// it is in `untracked`.
pub(super) fn partition(
    worktree: &Path,
    candidates: Vec<String>,
    untracked: &HashSet<&str>,
) -> (Vec<String>, Vec<SkippedFile>) {
    let mut survivors = Vec::new();
    let mut skipped = Vec::new();
    for path in candidates {
        match deny_reason(worktree, &path, untracked.contains(path.as_str())) {
            Some(reason) => skipped.push(SkippedFile { path, reason }),
            None => survivors.push(path),
        }
    }
    (survivors, skipped)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::test_support::TempRepo;

    #[test]
    fn test_deny_reason_matches_credential_shaped_names() {
        let repo = TempRepo::new("deny-names");
        for name in [
            ".env",
            ".env.local",
            "server.pem",
            "tls/server.KEY",
            "id_rsa",
            "id_rsa.pub",
            "id_ed25519",
            "id_ecdsa_sk",
            "cert.p12",
            "MY_SECRET.txt",
            "config/secrets/api.yaml",
        ] {
            assert_eq!(
                deny_reason(repo.root(), name, false).as_deref(),
                Some("Skipped — Looks Like A Credential"),
                "expected {name} to be denied"
            );
        }
        for name in ["README.md", "src/main.rs", "package.json", "environment.ts"] {
            assert!(
                deny_reason(repo.root(), name, false).is_none(),
                "expected {name} to survive the deny list"
            );
        }
    }

    #[test]
    fn test_deny_reason_matches_oversized_files() {
        let repo = TempRepo::new("deny-size");
        let oversized = usize::try_from(MAX_STAGED_FILE_BYTES).unwrap() + 1;
        std::fs::write(repo.root().join("blob.bin"), vec![0_u8; oversized]).unwrap();
        std::fs::write(repo.root().join("tiny.bin"), [0_u8; 10]).unwrap();

        assert_eq!(
            deny_reason(repo.root(), "blob.bin", false).as_deref(),
            Some("Skipped — Larger Than 5 MB")
        );
        assert!(deny_reason(repo.root(), "tiny.bin", false).is_none());
    }

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
    fn test_deny_reason_skips_untracked_but_not_tracked_claude_settings_json() {
        let repo = TempRepo::new("deny-claude");
        repo.write(".claude/settings.json", "{}");

        for path in [".claude/settings.json", "worker/.claude/settings.json"] {
            assert_eq!(
                deny_reason(repo.root(), path, true).as_deref(),
                Some("Skipped — SWARM Configuration File")
            );
        }
        // The same path tracked or staged is the user's own file.
        assert!(deny_reason(repo.root(), ".claude/settings.json", false).is_none());
    }

    #[test]
    fn test_partition_splits_survivors_from_skipped() {
        let repo = TempRepo::new("deny-partition");
        let untracked = HashSet::from([".claude/settings.json"]);
        let (survivors, skipped) = partition(
            repo.root(),
            vec![
                "src/lib.rs".to_owned(),
                ".env".to_owned(),
                ".claude/settings.json".to_owned(),
            ],
            &untracked,
        );
        assert_eq!(survivors, ["src/lib.rs"]);
        let skipped_paths: Vec<&str> = skipped.iter().map(|s| s.path.as_str()).collect();
        assert_eq!(skipped_paths, [".env", ".claude/settings.json"]);
    }
}
