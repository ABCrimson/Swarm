//! Working-tree state for the ship chain: one `git status
//! --porcelain=v2 --branch -z` snapshot, and `--numstat` accounting.
//!
//! `-z` output is the only safe input: without it git C-quotes any path
//! with a space, a control or a non-ASCII byte (`"a b.txt"`,
//! `"caf\303\251.txt"`), which then matches no file on disk and slips
//! past name-based checks. With it every path is verbatim, and a
//! rename's source is its own field rather than a ` -> ` split.
//! Paths are decoded as UTF-8; a name that is not valid UTF-8 (possible
//! only on Unix) is decoded lossily and then matches no file, so
//! staging it fails rather than staging something else.

use std::collections::HashSet;
use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};

use super::git;
use crate::error::AppError;
use crate::git::cli::SCAN_TIMEOUT;

/// One changed path in a [`StatusSnapshot`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct StatusEntry {
    /// The path, relative to the worktree root.
    pub path: String,
    /// A staged rename's or copy's source path.
    pub orig_path: Option<String>,
    /// Porcelain v2's `X` (index) column: `.` unchanged, `?` untracked.
    pub index: u8,
    /// Porcelain v2's `Y` (working tree) column.
    pub worktree: u8,
    /// An unmerged (conflicted) path.
    pub unmerged: bool,
}

impl StatusEntry {
    fn is_untracked(&self) -> bool {
        self.index == b'?'
    }
}

/// Branch state and changed paths from one `git status --porcelain=v2
/// --branch -z --untracked-files=all` call — the one query that replaces
/// separate `symbolic-ref`, `rev-parse @{u}` and `rev-list --count`
/// spawns.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(super) struct StatusSnapshot {
    /// The checked-out branch; `None` on a detached `HEAD`.
    pub head: Option<String>,
    /// The upstream (`origin/<branch>`), when one is configured.
    pub upstream: Option<String>,
    /// `(ahead, behind)` of the upstream; `None` without an upstream or
    /// when the upstream ref no longer exists.
    pub ahead_behind: Option<(u32, u32)>,
    /// Every changed, untracked or unmerged path.
    pub entries: Vec<StatusEntry>,
}

/// A snapshot's paths split the way `git status` shows them.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(super) struct Classified {
    /// Paths with an index change. A partially staged file is in both
    /// this and `unstaged`.
    pub staged: Vec<String>,
    /// Tracked paths with a working-tree change.
    pub unstaged: Vec<String>,
    /// Untracked files.
    pub untracked: Vec<String>,
}

impl StatusSnapshot {
    /// Reads `worktree`'s status.
    pub(super) fn read(worktree: &Path) -> Result<Self, AppError> {
        let output = git(
            worktree,
            &[
                "status",
                "--porcelain=v2",
                "--branch",
                "-z",
                "--untracked-files=all",
            ],
            SCAN_TIMEOUT,
        )?;
        if !output.success() {
            return Err(AppError::Git(format!(
                "git status failed: {}",
                output.stderr.trim()
            )));
        }
        Ok(Self::parse(&output.stdout))
    }

    /// Parses `--porcelain=v2 --branch -z` output. Unknown record kinds
    /// (including `!` ignored entries) are skipped.
    fn parse(raw: &[u8]) -> Self {
        let mut snapshot = Self::default();
        let mut records = raw.split(|&byte| byte == 0).filter(|r| !r.is_empty());
        while let Some(record) = records.next() {
            match record.first() {
                Some(b'#') => snapshot.parse_header(&String::from_utf8_lossy(record)),
                // `1 XY sub mH mI mW hH hI <path>`
                Some(b'1') => snapshot.push_changed(record, 9, None),
                // `2 XY sub mH mI mW hH hI Xscore <path>`, then the
                // source path as its own NUL-terminated record.
                Some(b'2') => {
                    let orig = records.next().map(decode);
                    snapshot.push_changed(record, 10, orig);
                }
                // `u XY sub m1 m2 m3 mW h1 h2 h3 <path>`
                Some(b'u') => snapshot.push_changed(record, 11, None),
                // `? <path>`
                Some(b'?') => snapshot.entries.push(StatusEntry {
                    path: decode(record.get(2..).unwrap_or_default()),
                    orig_path: None,
                    index: b'?',
                    worktree: b'?',
                    unmerged: false,
                }),
                _ => {}
            }
        }
        snapshot
    }

    fn parse_header(&mut self, header: &str) {
        if let Some(head) = header.strip_prefix("# branch.head ") {
            self.head = (head != "(detached)").then(|| head.to_owned());
        } else if let Some(upstream) = header.strip_prefix("# branch.upstream ") {
            self.upstream = Some(upstream.to_owned());
        } else if let Some(counts) = header.strip_prefix("# branch.ab ") {
            let mut parts = counts.split(' ');
            let ahead = parts.next().and_then(|a| a.strip_prefix('+')?.parse().ok());
            let behind = parts.next().and_then(|b| b.strip_prefix('-')?.parse().ok());
            self.ahead_behind = ahead.zip(behind);
        }
    }

    /// Pushes a `1`/`2`/`u` record: `fields` space-separated fields, the
    /// last being the path (which may itself contain spaces).
    fn push_changed(&mut self, record: &[u8], fields: usize, orig_path: Option<String>) {
        let mut parts = record.splitn(fields, |&byte| byte == b' ');
        let kind = parts.next();
        let Some(&[index, worktree]) = parts.next() else {
            return;
        };
        let Some(path) = parts.nth(fields - 3) else {
            return;
        };
        self.entries.push(StatusEntry {
            path: decode(path),
            orig_path,
            index,
            worktree,
            unmerged: kind == Some(b"u"),
        });
    }

    /// The snapshot's paths as staged/unstaged/untracked lists.
    pub(super) fn classify(&self) -> Classified {
        let mut classified = Classified::default();
        for entry in &self.entries {
            if entry.is_untracked() {
                classified.untracked.push(entry.path.clone());
                continue;
            }
            if entry.index != b'.' {
                classified.staged.push(entry.path.clone());
            }
            if entry.worktree != b'.' {
                classified.unstaged.push(entry.path.clone());
            }
        }
        classified
    }

    /// Paths with unresolved merge conflicts.
    pub(super) fn unmerged(&self) -> impl Iterator<Item = &str> {
        self.entries
            .iter()
            .filter(|entry| entry.unmerged)
            .map(|entry| entry.path.as_str())
    }

    /// The source paths of staged renames whose destination is in
    /// `paths` — a rename is a deletion plus an addition, and both
    /// halves belong to the same change.
    pub(super) fn rename_sources_of<'a>(
        &'a self,
        paths: &HashSet<&str>,
    ) -> impl Iterator<Item = &'a str> {
        self.entries.iter().filter_map(|entry| {
            let orig = entry.orig_path.as_deref()?;
            paths.contains(entry.path.as_str()).then_some(orig)
        })
    }
}

fn decode(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

// ── Diff stat ─────────────────────────────────────────────────────────

/// Files/insertions/deletions of a change, counted the way `git diff
/// --numstat --no-renames` counts them: a rename is a deletion plus an
/// addition, and a binary file counts as changed with no lines.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffStat {
    /// Files changed.
    pub files_changed: u32,
    /// Lines added.
    pub insertions: u32,
    /// Lines removed.
    pub deletions: u32,
}

impl DiffStat {
    fn add(&mut self, insertions: u32, deletions: u32) {
        self.files_changed = self.files_changed.saturating_add(1);
        self.insertions = self.insertions.saturating_add(insertions);
        self.deletions = self.deletions.saturating_add(deletions);
    }
}

/// Options every numstat query shares: NUL-separated verbatim paths,
/// renames split into delete + add (so a preview and the final commit
/// count the same way), and no user textconv or external diff programs.
pub(super) const NUMSTAT_ARGS: [&str; 4] = ["--numstat", "-z", "--no-renames", "--no-textconv"];

/// Runs a numstat-producing git command (`args` must include
/// [`NUMSTAT_ARGS`]) in `worktree`, counting only the paths `keep`
/// accepts.
pub(super) fn numstat(
    worktree: &Path,
    args: &[&str],
    keep: impl Fn(&str) -> bool,
) -> Result<DiffStat, AppError> {
    let output = git(worktree, args, SCAN_TIMEOUT)?;
    if !output.success() {
        return Err(AppError::Git(format!(
            "git {} --numstat failed: {}",
            args.first().copied().unwrap_or_default(),
            output.stderr.trim()
        )));
    }
    let mut stat = DiffStat::default();
    accumulate_numstat(&output.stdout, keep, &mut stat);
    Ok(stat)
}

/// Adds each `insertions\tdeletions\tpath` record of `-z --no-renames`
/// numstat output to `stat`. A binary file reports `-\t-` and counts as
/// changed with no lines.
fn accumulate_numstat(raw: &[u8], keep: impl Fn(&str) -> bool, stat: &mut DiffStat) {
    for record in raw.split(|&byte| byte == 0) {
        let text = String::from_utf8_lossy(record);
        let mut fields = text.splitn(3, '\t');
        let (Some(insertions), Some(deletions), Some(path)) =
            (fields.next(), fields.next(), fields.next())
        else {
            continue;
        };
        if keep(path) {
            stat.add(
                insertions.trim().parse().unwrap_or(0),
                deletions.trim().parse().unwrap_or(0),
            );
        }
    }
}

/// How many bytes git inspects for a NUL when deciding a file is binary.
const BINARY_SNIFF_BYTES: usize = 8000;

/// Adds an untracked file at `worktree/rel` to `stat` the way `git`
/// will count it once added: lines are `\n`-terminated (a final line
/// without one still counts), a file with a NUL in its first 8000 bytes
/// is binary (no lines), and a symlink is one line (its target). A path
/// that cannot be read is left out.
pub(super) fn add_untracked(stat: &mut DiffStat, worktree: &Path, rel: &str) {
    let full = worktree.join(rel);
    let Ok(meta) = fs::symlink_metadata(&full) else {
        return;
    };
    if meta.is_symlink() {
        stat.add(1, 0);
        return;
    }
    let Ok(contents) = fs::read(&full) else {
        return;
    };
    let sniff = &contents[..contents.len().min(BINARY_SNIFF_BYTES)];
    if sniff.contains(&0) {
        stat.add(0, 0);
        return;
    }
    stat.add(line_count(&contents), 0);
}

/// Lines in `contents` as git counts them.
fn line_count(contents: &[u8]) -> u32 {
    let newlines = contents.iter().filter(|&&byte| byte == b'\n').count();
    let unterminated = contents.last().is_some_and(|&byte| byte != b'\n');
    u32::try_from(newlines + usize::from(unterminated)).unwrap_or(u32::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::test_support::TempRepo;

    fn records(parts: &[&[u8]]) -> Vec<u8> {
        let mut raw = Vec::new();
        for part in parts {
            raw.extend_from_slice(part);
            raw.push(0);
        }
        raw
    }

    #[test]
    fn test_parse_headers() {
        let raw = records(&[
            b"# branch.oid 48fa963fc393d799a6c15c74e2937ca98a2f9621",
            b"# branch.head swarm/x-abcd1234",
            b"# branch.upstream origin/swarm/x-abcd1234",
            b"# branch.ab +3 -1",
        ]);
        let snapshot = StatusSnapshot::parse(&raw);
        assert_eq!(snapshot.head.as_deref(), Some("swarm/x-abcd1234"));
        assert_eq!(
            snapshot.upstream.as_deref(),
            Some("origin/swarm/x-abcd1234")
        );
        assert_eq!(snapshot.ahead_behind, Some((3, 1)));
        assert!(snapshot.entries.is_empty());
    }

    #[test]
    fn test_parse_detached_head_without_upstream() {
        let raw = records(&[b"# branch.oid abc", b"# branch.head (detached)"]);
        let snapshot = StatusSnapshot::parse(&raw);
        assert_eq!(snapshot.head, None);
        assert_eq!(snapshot.upstream, None);
        assert_eq!(snapshot.ahead_behind, None);
    }

    /// Paths come through verbatim: spaces, non-ASCII, brackets, and a
    /// rename whose names contain ` -> `.
    #[test]
    fn test_parse_entries_keeps_paths_verbatim() {
        let hash = "45b983be36b73c0788dc9cbcb76cbb80fc7bb057";
        let modified = format!("1 .M N... 100644 100644 100644 {hash} {hash} a b.txt");
        let staged = format!("1 A. N... 000000 100644 100644 {hash} {hash} caf\u{e9}.txt");
        let renamed = format!("2 R. N... 100644 100644 100644 {hash} {hash} R100 new -> x.txt");
        let conflict =
            format!("u UU N... 100644 100644 100644 100644 {hash} {hash} {hash} both.txt");
        let raw = records(&[
            modified.as_bytes(),
            staged.as_bytes(),
            renamed.as_bytes(),
            b"old -> y.txt",
            conflict.as_bytes(),
            b"? app/[slug]/page.tsx",
            b"! ignored.log",
        ]);
        let snapshot = StatusSnapshot::parse(&raw);
        let paths: Vec<&str> = snapshot.entries.iter().map(|e| e.path.as_str()).collect();
        assert_eq!(
            paths,
            [
                "a b.txt",
                "caf\u{e9}.txt",
                "new -> x.txt",
                "both.txt",
                "app/[slug]/page.tsx"
            ]
        );
        assert_eq!(
            snapshot.entries[2].orig_path.as_deref(),
            Some("old -> y.txt")
        );
        assert!(snapshot.entries[3].unmerged);
        assert_eq!(snapshot.unmerged().collect::<Vec<_>>(), ["both.txt"]);

        let classified = snapshot.classify();
        assert_eq!(
            classified.staged,
            ["caf\u{e9}.txt", "new -> x.txt", "both.txt"]
        );
        assert_eq!(classified.unstaged, ["a b.txt", "both.txt"]);
        assert_eq!(classified.untracked, ["app/[slug]/page.tsx"]);

        let wanted = HashSet::from(["new -> x.txt"]);
        assert_eq!(
            snapshot.rename_sources_of(&wanted).collect::<Vec<_>>(),
            ["old -> y.txt"]
        );
    }

    #[test]
    fn test_accumulate_numstat_counts_kept_paths_and_binaries() {
        let raw = records(&[b"3\t1\tsrc/a.rs", b"-\t-\tlogo.png", b"10\t0\tskipped.env"]);
        let mut stat = DiffStat::default();
        accumulate_numstat(&raw, |path| path != "skipped.env", &mut stat);
        assert_eq!(
            stat,
            DiffStat {
                files_changed: 2,
                insertions: 3,
                deletions: 1
            }
        );
    }

    #[test]
    fn test_accumulate_numstat_skips_empty_records() {
        let raw = records(&[b"", b"1\t2\ta.txt", b""]);
        let mut stat = DiffStat::default();
        accumulate_numstat(&raw, |_| true, &mut stat);
        assert_eq!(stat.files_changed, 1);
        assert_eq!((stat.insertions, stat.deletions), (1, 2));
    }

    /// git counts `"a\nb\n"` as two lines, not three, and a final line
    /// without a newline still counts.
    #[test]
    fn test_line_count_matches_git() {
        assert_eq!(line_count(b""), 0);
        assert_eq!(line_count(b"a\nb\n"), 2);
        assert_eq!(line_count(b"a\nb"), 2);
        assert_eq!(line_count(b"\n"), 1);
    }

    /// The preview's untracked estimate agrees with what git reports
    /// once the same files are committed.
    #[test]
    fn test_untracked_estimate_matches_git_numstat() {
        let repo = TempRepo::new("numstat-untracked");
        repo.write("two-lines.txt", "a\nb\n");
        repo.write("no-final-newline.txt", "a\nb");
        std::fs::write(repo.root().join("blob.bin"), b"\0\x01\x02").unwrap();

        let mut estimate = DiffStat::default();
        for path in ["two-lines.txt", "no-final-newline.txt", "blob.bin"] {
            add_untracked(&mut estimate, repo.root(), path);
        }

        repo.git(&["add", "-A"]);
        repo.git(&["commit", "-m", "files"]);
        let mut args = vec!["show", "--format="];
        args.extend(NUMSTAT_ARGS);
        args.push("HEAD");
        let actual = numstat(repo.root(), &args, |_| true).unwrap();

        assert_eq!(estimate, actual);
        assert_eq!(
            actual,
            DiffStat {
                files_changed: 3,
                insertions: 4,
                deletions: 0
            }
        );
    }

    /// A real repository, end to end: every shape of path survives the
    /// snapshot, and the branch headers match reality.
    #[test]
    fn test_read_against_real_git() {
        let repo = TempRepo::new("status-v2");
        repo.write("a b.txt", "x");
        repo.write("caf\u{e9}.txt", "x");
        repo.write("app/[slug]/page.tsx", "x");
        repo.write("old.txt", "x\n");
        repo.git(&["add", "old.txt"]);
        repo.git(&["commit", "-m", "old"]);
        repo.git(&["mv", "old.txt", "new.txt"]);

        let snapshot = StatusSnapshot::read(repo.root()).unwrap();
        assert_eq!(snapshot.head.as_deref(), Some("main"));
        assert_eq!(snapshot.upstream, None);
        let classified = snapshot.classify();
        assert_eq!(classified.staged, ["new.txt"]);
        let mut untracked = classified.untracked.clone();
        untracked.sort();
        assert_eq!(
            untracked,
            ["a b.txt", "app/[slug]/page.tsx", "caf\u{e9}.txt"]
        );
        assert_eq!(snapshot.entries[0].orig_path.as_deref(), Some("old.txt"));
    }
}
