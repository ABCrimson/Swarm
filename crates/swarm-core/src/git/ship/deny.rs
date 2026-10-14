//! The secret/size deny list every file a ship would commit passes
//! through first.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::error::AppError;
use crate::git::cli::{self, SCAN_TIMEOUT, args_in};

/// Files larger than this (5 MiB) are never committed.
pub(super) const MAX_STAGED_FILE_BYTES: u64 = 5 * 1024 * 1024;

/// The reason a path over [`MAX_STAGED_FILE_BYTES`] is skipped with.
const OVERSIZED_REASON: &str = "Skipped — Larger Than 5 MB";

/// Which bytes the size limit measures — always the ones the commit
/// would contain.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum SizeBasis {
    /// The blob in the index. A staged-only commit is the index as it
    /// stands, so the working-tree copy (shrunk or grown since `git
    /// add`) is never read.
    Index,
    /// The working-tree file. "Stage everything" mode screens its
    /// candidates before `git add` runs, and `git add` is about to
    /// replace each index entry with exactly this file. The index is
    /// measured again after staging ([`SizeBasis::Index`]), which is
    /// the check that guards the commit itself.
    WorkingCopy,
}

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

/// Why `rel_path` must be kept out of a commit by name alone, or `None`
/// to allow it:
///
/// - a credential-shaped name — a basename (case-insensitive) starting
///   with `.env` or an SSH key name (`id_rsa`, `id_ed25519`, `id_ecdsa`,
///   `id_dsa`) or ending in `.pem`, `.key`, `.p12` or `.pfx`, or `secret`
///   anywhere in the full relative path (so `config/secrets/api.yaml`
///   is caught although its basename looks innocuous);
/// - an **untracked** `.claude/settings.json` (`is_untracked`, from a
///   `?` status entry).
///
/// The size rule is not here: it needs the bytes the commit would
/// contain, which [`partition`] measures per [`SizeBasis`].
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
fn name_deny_reason(rel_path: &str, is_untracked: bool) -> Option<String> {
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
    looks_like_credential.then(|| "Skipped — Looks Like A Credential".to_owned())
}

/// Sizes in bytes of the stage-0 index blobs of `paths`, from two
/// plumbing calls through the single git runner: `git ls-files --stage
/// -z` (path to blob id) and `git cat-file --batch-check` (blob id to
/// size). A path with no stage-0 entry (a staged deletion, an unmerged
/// path) and a submodule gitlink (mode `160000`, a commit id) have no
/// blob and are absent from the result.
///
/// The whole index is listed instead of passing a pathspec list: the
/// listing is the index git already holds in memory, and it keeps a
/// large change set off the command line. Blob ids — never paths — go
/// to `cat-file`'s line-oriented stdin, so a path containing a newline
/// cannot desync it.
///
/// # Errors
///
/// * [`AppError::Git`] — a command failed or its output was not in the
///   documented shape (fail closed: an unmeasured blob is never waved
///   through).
/// * [`AppError::GitTimeout`] — a call exceeded [`SCAN_TIMEOUT`].
fn index_blob_sizes(
    worktree: &Path,
    paths: &HashSet<&str>,
) -> Result<HashMap<String, u64>, AppError> {
    if paths.is_empty() {
        return Ok(HashMap::new());
    }
    let listing = cli::run(
        &args_in(worktree, &["ls-files", "--stage", "-z"]),
        SCAN_TIMEOUT,
    )?;
    if !listing.success() {
        return Err(AppError::Git(format!(
            "`git ls-files --stage` failed: {}",
            listing.stderr.trim()
        )));
    }
    // Records are `<mode> SP <object> SP <stage> TAB <path>`, NUL-terminated.
    // Paths decode lossily, exactly as the status snapshot's do, so a
    // non-UTF-8 name matches its candidate; two raw names that decode
    // alike share one entry and the largest blob wins. A record that does
    // not parse fails closed.
    let mut entries: Vec<(String, String)> = Vec::new();
    for record in listing.stdout.split(|&byte| byte == 0) {
        if record.is_empty() {
            continue;
        }
        let record = String::from_utf8_lossy(record);
        let parsed = record.split_once('\t').and_then(|(meta, path)| {
            let mut fields = meta.split(' ');
            Some((fields.next()?, fields.next()?, fields.next()?, path))
        });
        let Some((mode, oid, stage, path)) = parsed else {
            return Err(AppError::Git(format!(
                "unexpected `git ls-files --stage` record: {record:?}"
            )));
        };
        if stage == "0" && mode != "160000" && paths.contains(path) {
            entries.push((path.to_owned(), oid.to_owned()));
        }
    }
    if entries.is_empty() {
        return Ok(HashMap::new());
    }

    let oids: HashSet<&str> = entries.iter().map(|(_, oid)| oid.as_str()).collect();
    let stdin: String = oids.iter().map(|oid| format!("{oid}\n")).collect();
    let checked = cli::run_with_stdin(
        &args_in(
            worktree,
            &["cat-file", "--batch-check=%(objectname) %(objectsize)"],
        ),
        stdin.as_bytes(),
        SCAN_TIMEOUT,
    )?;
    if !checked.success() {
        return Err(AppError::Git(format!(
            "`git cat-file --batch-check` failed: {}",
            checked.stderr.trim()
        )));
    }
    let mut size_of_oid: HashMap<String, u64> = HashMap::new();
    for line in String::from_utf8_lossy(&checked.stdout).lines() {
        // `<object> missing` and any other shape fail closed.
        let Some((oid, size)) = line
            .split_once(' ')
            .and_then(|(oid, size)| Some((oid, size.parse::<u64>().ok()?)))
        else {
            return Err(AppError::Git(format!(
                "unexpected `git cat-file --batch-check` line: {line:?}"
            )));
        };
        size_of_oid.insert(oid.to_owned(), size);
    }
    let mut size_of_path: HashMap<String, u64> = HashMap::new();
    for (path, oid) in entries {
        let Some(&size) = size_of_oid.get(&oid) else {
            return Err(AppError::Git(format!(
                "`git cat-file --batch-check` reported no size for blob {oid} of {path}"
            )));
        };
        let largest = size_of_path.entry(path).or_default();
        *largest = (*largest).max(size);
    }
    Ok(size_of_path)
}

/// Splits `candidates` into the paths that may be committed and the
/// ones the deny list keeps out. A candidate counts as untracked when
/// it is in `untracked`. Names are screened first (see
/// [`name_deny_reason`]); a surviving path is denied when the bytes the
/// commit would contain, per `basis`, exceed [`MAX_STAGED_FILE_BYTES`].
/// A path with nothing to measure (deleted in the working tree, or a
/// staged deletion) has no size to deny.
///
/// # Errors
///
/// [`AppError`] from measuring index blobs ([`SizeBasis::Index`]);
/// never for [`SizeBasis::WorkingCopy`].
pub(super) fn partition(
    worktree: &Path,
    candidates: Vec<String>,
    untracked: &HashSet<&str>,
    basis: SizeBasis,
) -> Result<(Vec<String>, Vec<SkippedFile>), AppError> {
    let mut skipped = Vec::new();
    let mut unmeasured = Vec::new();
    for path in candidates {
        match name_deny_reason(&path, untracked.contains(path.as_str())) {
            Some(reason) => skipped.push(SkippedFile { path, reason }),
            None => unmeasured.push(path),
        }
    }

    let index_sizes = match basis {
        SizeBasis::Index => {
            let wanted: HashSet<&str> = unmeasured.iter().map(String::as_str).collect();
            index_blob_sizes(worktree, &wanted)?
        }
        SizeBasis::WorkingCopy => HashMap::new(),
    };
    let mut survivors = Vec::new();
    for path in unmeasured {
        let size = match basis {
            SizeBasis::Index => index_sizes.get(&path).copied(),
            // `symlink_metadata`: a symlink is committed as its link text,
            // so it is measured as a link, never as its target.
            SizeBasis::WorkingCopy => fs::symlink_metadata(worktree.join(&path))
                .ok()
                .filter(fs::Metadata::is_file)
                .map(|meta| meta.len()),
        };
        if size.is_some_and(|size| size > MAX_STAGED_FILE_BYTES) {
            skipped.push(SkippedFile {
                path,
                reason: OVERSIZED_REASON.to_owned(),
            });
        } else {
            survivors.push(path);
        }
    }
    Ok((survivors, skipped))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::test_support::TempRepo;

    #[test]
    fn test_name_deny_reason_matches_credential_shaped_names() {
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
                name_deny_reason(name, false).as_deref(),
                Some("Skipped — Looks Like A Credential"),
                "expected {name} to be denied"
            );
        }
        for name in ["README.md", "src/main.rs", "package.json", "environment.ts"] {
            assert!(
                name_deny_reason(name, false).is_none(),
                "expected {name} to survive the deny list"
            );
        }
    }

    #[test]
    fn test_partition_measures_the_working_copy_in_working_copy_basis() {
        let repo = TempRepo::new("deny-size-wc");
        let oversized = usize::try_from(MAX_STAGED_FILE_BYTES).unwrap() + 1;
        std::fs::write(repo.root().join("blob.bin"), vec![0_u8; oversized]).unwrap();
        std::fs::write(repo.root().join("tiny.bin"), [0_u8; 10]).unwrap();

        let (survivors, skipped) = partition(
            repo.root(),
            vec![
                "blob.bin".to_owned(),
                "tiny.bin".to_owned(),
                "gone.bin".to_owned(),
            ],
            &HashSet::new(),
            SizeBasis::WorkingCopy,
        )
        .unwrap();
        assert_eq!(survivors, ["tiny.bin", "gone.bin"]);
        assert_eq!(
            skipped,
            [SkippedFile {
                path: "blob.bin".to_owned(),
                reason: "Skipped — Larger Than 5 MB".to_owned(),
            }]
        );
    }

    /// The limit is inclusive: exactly [`MAX_STAGED_FILE_BYTES`] ships.
    #[test]
    fn test_partition_measures_the_index_blob_in_index_basis() {
        let repo = TempRepo::new("deny-size-index");
        let limit = usize::try_from(MAX_STAGED_FILE_BYTES).unwrap();
        std::fs::write(repo.root().join("over.bin"), vec![0_u8; limit + 1]).unwrap();
        std::fs::write(repo.root().join("at.bin"), vec![1_u8; limit]).unwrap();
        std::fs::write(repo.root().join("small.bin"), b"small").unwrap();
        repo.git(&["add", "over.bin", "at.bin", "small.bin"]);
        // Working copies diverge from the index in both directions.
        std::fs::write(repo.root().join("over.bin"), b"shrunk").unwrap();
        std::fs::write(repo.root().join("small.bin"), vec![2_u8; limit + 1]).unwrap();

        let (survivors, skipped) = partition(
            repo.root(),
            vec![
                "over.bin".to_owned(),
                "at.bin".to_owned(),
                "small.bin".to_owned(),
                "never-staged.bin".to_owned(),
            ],
            &HashSet::new(),
            SizeBasis::Index,
        )
        .unwrap();
        assert_eq!(survivors, ["at.bin", "small.bin", "never-staged.bin"]);
        assert_eq!(
            skipped,
            [SkippedFile {
                path: "over.bin".to_owned(),
                reason: "Skipped — Larger Than 5 MB".to_owned(),
            }]
        );
    }

    /// S3: git reports the raw bytes of a non-UTF-8 name; status decodes
    /// it lossily, so the index listing must decode the same way to
    /// match the candidate.
    #[cfg(unix)]
    #[test]
    fn test_partition_denies_an_oversized_non_utf8_name_in_index_basis() {
        use std::os::unix::ffi::OsStrExt;

        let repo = TempRepo::new("deny-non-utf8");
        let name = std::ffi::OsStr::from_bytes(b"big\xff.bin");
        let size = usize::try_from(MAX_STAGED_FILE_BYTES).unwrap() + 1;
        std::fs::write(repo.root().join(name), vec![0_u8; size]).unwrap();
        repo.git(&["add", "."]);
        let lossy = String::from_utf8_lossy(name.as_bytes()).into_owned();

        let (survivors, skipped) = partition(
            repo.root(),
            vec![lossy.clone()],
            &HashSet::new(),
            SizeBasis::Index,
        )
        .unwrap();
        assert!(survivors.is_empty(), "{survivors:?}");
        assert_eq!(skipped.len(), 1);
        assert_eq!(skipped[0].path, lossy);
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
    fn test_name_deny_reason_skips_untracked_but_not_tracked_claude_settings_json() {
        for path in [".claude/settings.json", "worker/.claude/settings.json"] {
            assert_eq!(
                name_deny_reason(path, true).as_deref(),
                Some("Skipped — SWARM Configuration File")
            );
        }
        // The same path tracked or staged is the user's own file.
        assert!(name_deny_reason(".claude/settings.json", false).is_none());
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
            SizeBasis::WorkingCopy,
        )
        .unwrap();
        assert_eq!(survivors, ["src/lib.rs"]);
        let skipped_paths: Vec<&str> = skipped.iter().map(|s| s.path.as_str()).collect();
        assert_eq!(skipped_paths, [".env", ".claude/settings.json"]);
    }
}
