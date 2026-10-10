//! Secret redaction and size capping for any git-produced text that can
//! reach a log line, a persisted `SwarmEvent`, or a UI toast.
//! [`crate::git::cli`] applies [`sanitize`] to every captured stderr
//! ([`crate::git::cli::GitOutput::stderr`]); stdout is data and stays
//! raw, so a caller that echoes stdout into a message sanitizes it
//! itself.
//!
//! # Why this exists
//!
//! `git`'s stderr can echo a remote URL with embedded credentials —
//! `https://user:pass@host/…`, or a bare token used as the username
//! (`https://ghp_…@github.com/…`, which GitHub accepts) — and a failed
//! push against a token-authenticated remote can echo the token itself.
//! None of that may leave the process boundary: not into `tracing`, not
//! onto `swarm://events`, not into a `ShipError.message` a user reads.
//!
//! # Ordering: redact first, then truncate
//!
//! Truncating first could cut a secret in half at the size boundary,
//! leaving a fragment that no longer matches any pattern. Redacting the
//! full text first is the only order that cannot leak a fragment.

use std::sync::LazyLock;

use regex::{Captures, Regex};

/// Hard cap, in bytes, on any git output string surfaced past this
/// module — a defense against pathological output size, not a display
/// concern.
pub const MAX_OUTPUT_BYTES: usize = 8 * 1024;

const REDACTED: &str = "[REDACTED]";

/// URL userinfo: `scheme://<userinfo>@`. Every userinfo is redacted —
/// `user:pass` and a bare token-as-username alike — except the
/// conventional, secret-free SSH user `git` (`ssh://git@host/…`).
static URL_USERINFO: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\b([a-z][a-z0-9+.-]*://)([^\s/@]+)@").expect("valid regex"));

/// Bare credential tokens, by issuer prefix:
///
/// - GitHub classic tokens: `ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`
/// - GitHub fine-grained personal access tokens: `github_pat_`
/// - GitLab personal access tokens: `glpat-`
/// - Anthropic API keys: `sk-ant-`
/// - OpenAI-style secret keys: `sk-`, `sk-proj-`, `sk-svcacct-`
/// - AWS access key ids: `AKIA` + 16
///
/// The distinctive prefixes match anywhere — a token glued to the text
/// before it is still a token. Only the generic `sk-` form and the AWS
/// key id need a word boundary, so `task-…` or `risk-…` never match.
static TOKEN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(concat!(
        r"gh[pousr]_[A-Za-z0-9]{20,}",
        r"|github_pat_[A-Za-z0-9_]{22,}",
        r"|glpat-[A-Za-z0-9_-]{20,}",
        r"|sk-ant-[A-Za-z0-9_-]{10,}",
        r"|\bsk-[A-Za-z0-9_-]{20,}",
        r"|\bAKIA[0-9A-Z]{16}\b",
    ))
    .expect("valid regex")
});

/// Redacts every recognized secret in `input`, replacing it with
/// `[REDACTED]`. A redacted URL keeps its scheme and the trailing `@`
/// (`https://[REDACTED]@github.com/…`) so it still reads as a URL.
#[must_use = "returns a new value; the input is unchanged"]
pub fn redact(input: &str) -> String {
    let without_userinfo = URL_USERINFO.replace_all(input, |caps: &Captures<'_>| {
        if caps[2].eq_ignore_ascii_case("git") {
            caps[0].to_owned()
        } else {
            format!("{}{REDACTED}@", &caps[1])
        }
    });
    TOKEN.replace_all(&without_userinfo, REDACTED).into_owned()
}

/// Caps `input` at roughly `max_bytes`, keeping its head **and** its
/// tail — git and its hooks print progress first and the failing line
/// last, so the tail is usually the part that explains the error. Cuts
/// only on UTF-8 char boundaries and marks how many bytes were dropped.
/// A no-op when `input` already fits.
#[must_use = "returns a new value; the input is unchanged"]
pub fn truncate(input: &str, max_bytes: usize) -> String {
    if input.len() <= max_bytes {
        return input.to_owned();
    }
    let head_end = input.floor_char_boundary(max_bytes / 2);
    let tail_start = input.ceil_char_boundary(input.len() - (max_bytes - max_bytes / 2));
    format!(
        "{}\n... [truncated {} bytes] ...\n{}",
        &input[..head_end],
        tail_start - head_end,
        &input[tail_start..]
    )
}

/// The full choke-point transform: redact secrets against the complete
/// text, then [`truncate`] to [`MAX_OUTPUT_BYTES`]. See the module doc
/// for why that order.
#[must_use = "returns a new value; the input is unchanged"]
pub fn sanitize(input: &str) -> String {
    truncate(&redact(input), MAX_OUTPUT_BYTES)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_redacts_url_credentials() {
        let input = "fatal: unable to access 'https://alice:hunter2@github.com/org/repo.git/'";
        let out = redact(input);
        assert!(!out.contains("alice"));
        assert!(!out.contains("hunter2"));
        assert!(out.contains("https://[REDACTED]@github.com"));
    }

    #[test]
    fn test_redacts_a_bare_token_used_as_the_url_username() {
        let token = format!("github_pat_11ABCDEFG0{}", "x".repeat(40));
        let input = format!("To https://{token}@github.com/o/r.git");
        let out = redact(&input);
        assert!(!out.contains(&token), "{out}");
        assert!(out.contains("https://[REDACTED]@github.com/o/r.git"));

        // An opaque, prefix-less token as the username is redacted too.
        let out = redact("https://abc123opaque@git.example.com/o/r.git");
        assert!(!out.contains("abc123opaque"), "{out}");
    }

    #[test]
    fn test_keeps_the_conventional_ssh_git_user() {
        let input = "ssh://git@github.com/org/repo.git";
        assert_eq!(redact(input), input);
        // scp-like syntax has no scheme and no credential shape at all.
        assert_eq!(
            redact("git@github.com:org/repo.git"),
            "git@github.com:org/repo.git"
        );
    }

    #[test]
    fn test_redacts_every_token_shape() {
        let tokens = [
            format!("ghp_{}", "a".repeat(36)),
            format!("gho_{}", "a".repeat(36)),
            format!("ghu_{}", "a".repeat(36)),
            format!("ghs_{}", "a".repeat(36)),
            format!("ghr_{}", "a".repeat(36)),
            format!("github_pat_{}", "B1_".repeat(25)),
            format!("glpat-{}", "c".repeat(20)),
            "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789".to_owned(),
            format!("sk-proj-{}", "d".repeat(40)),
            format!("sk-{}", "e".repeat(48)),
            "AKIAIOSFODNN7EXAMPLE".to_owned(),
        ];
        for token in tokens {
            let out = redact(&format!("remote: invalid credential {token} rejected"));
            assert!(
                !out.contains(&token),
                "expected {token} to be redacted: {out}"
            );
            assert!(out.contains(REDACTED));
        }
    }

    #[test]
    fn test_sk_prefix_needs_a_word_boundary() {
        let input = "branch swarm/task-abcdefghijklmnopqrstuvwxyz0123 pushed";
        assert_eq!(redact(input), input);
    }

    #[test]
    fn test_redact_is_noop_on_clean_text() {
        let input = "On branch main\nnothing to commit, working tree clean\n";
        assert_eq!(redact(input), input);
    }

    #[test]
    fn test_truncate_noop_under_budget() {
        let input = "short and sweet";
        assert_eq!(truncate(input, MAX_OUTPUT_BYTES), input);
    }

    #[test]
    fn test_truncate_keeps_head_and_tail_and_marks_the_cut() {
        let input = format!(
            "HEAD-LINE\n{}\nfatal: the line that explains it",
            "x".repeat(MAX_OUTPUT_BYTES * 2)
        );
        let out = truncate(&input, MAX_OUTPUT_BYTES);
        assert!(out.len() < input.len());
        assert!(out.starts_with("HEAD-LINE"));
        assert!(out.ends_with("fatal: the line that explains it"));
        assert!(out.contains("[truncated "));
        let dropped = input.len() - MAX_OUTPUT_BYTES;
        assert!(
            out.contains(&format!("[truncated {dropped} bytes]")),
            "{out}"
        );
    }

    #[test]
    fn test_truncate_never_splits_a_multibyte_char() {
        // Every char is 3 bytes; an odd budget lands mid-character on
        // both sides of the cut if truncation were byte-naive (which
        // would panic on the slice).
        let input = "€".repeat(4000);
        let out = truncate(&input, 11);
        assert!(out.starts_with('€'));
        assert!(out.ends_with('€'));
    }

    #[test]
    fn test_sanitize_redacts_before_truncating_so_a_split_token_cant_leak() {
        // A secret straddling the head cut: truncating first would keep
        // an unmatchable half of it.
        let key = format!("sk-ant-{}", "b".repeat(40));
        let padding = "x".repeat(MAX_OUTPUT_BYTES / 2 - 10);
        let input = format!("{padding}{key}{}", "y".repeat(MAX_OUTPUT_BYTES));
        let out = sanitize(&input);
        assert!(!out.contains(&key));
        assert!(!out.contains("sk-ant-"));
    }

    #[test]
    fn test_sanitize_handles_realistic_push_rejection_stderr() {
        let input = "To https://ghp_1234567890abcdefghijklmnopqrstuv@github.com/org/repo.git\n \
                      ! [rejected]        swarm/agent-abcd1234 -> swarm/agent-abcd1234 (fetch first)\n";
        let out = sanitize(input);
        assert!(!out.contains("ghp_1234567890abcdefghijklmnopqrstuv"));
        assert!(out.contains("rejected"));
    }
}
