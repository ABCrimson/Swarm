//! Secret redaction + output truncation for anything a git child
//! process could print — the choke point [`git::cli::run`] applies
//! this to every captured stdout/stderr before it can reach a log
//! line, a persisted `SwarmEvent`, or a UI toast.
//!
//! # Why this exists
//!
//! `git`'s own stderr can echo back a remote URL with embedded HTTP
//! basic-auth credentials (`https://user:pass@host/...`), and a failed
//! push against a token-authenticated remote can echo the token itself
//! in a diagnostic message. Neither of those should ever leave the
//! process boundary un-redacted — not into `tracing`, not onto
//! `swarm://events`, not into a `ShipError.message` a user reads in a
//! toast.
//!
//! # Ordering: redact first, then truncate
//!
//! Truncating before redacting risks slicing a secret in half at the
//! 8KB boundary, leaving a partial token exposed that no longer
//! matches the redaction patterns. Redacting against the full,
//! untruncated text first is the only order that can't leak a
//! fragment.

use std::sync::LazyLock;

use regex::Regex;

/// Hard cap on any git output string surfaced past this module —
/// applied in bytes (not chars) since it's a defense against pathological
/// output size, not a display concern.
pub const MAX_OUTPUT_BYTES: usize = 8 * 1024;

const REDACTED: &str = "[REDACTED]";

/// `scheme://user:pass@host` — HTTP basic-auth credentials embedded in
/// a URL (the classic "the origin remote has a token baked into its
/// URL" leak).
static URL_CREDENTIALS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"://[^\s/@]+:[^\s/@]+@").expect("valid regex"));

/// GitHub personal/OAuth/user-to-server/server-to-server tokens:
/// `ghp_`, `gho_`, `ghu_`, `ghs_` (and `ghr_` for refresh tokens)
/// followed by 20+ base62 characters.
static GITHUB_TOKEN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"gh[pousr]_[A-Za-z0-9]{20,}").expect("valid regex"));

/// Anthropic API keys (`sk-ant-...`).
static ANTHROPIC_KEY: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"sk-ant-[A-Za-z0-9_-]{10,}").expect("valid regex"));

/// Redacts every recognized secret pattern in `input`, replacing each
/// match with `[REDACTED]` (the URL-credentials pattern keeps the
/// `://` and trailing `@` so the redacted string still reads as a
/// URL shape, just without the embedded credentials).
pub fn redact(input: &str) -> String {
    let step1 = URL_CREDENTIALS.replace_all(input, "://[REDACTED]@");
    let step2 = GITHUB_TOKEN.replace_all(&step1, REDACTED);
    let step3 = ANTHROPIC_KEY.replace_all(&step2, REDACTED);
    step3.into_owned()
}

/// Truncates `input` to at most `max_bytes`, cutting on a UTF-8 char
/// boundary (never splitting a multi-byte character) and appending a
/// marker noting how many bytes were dropped. A no-op when `input` is
/// already within budget.
pub fn truncate(input: &str, max_bytes: usize) -> String {
    if input.len() <= max_bytes {
        return input.to_string();
    }
    let mut end = max_bytes;
    while end > 0 && !input.is_char_boundary(end) {
        end -= 1;
    }
    format!(
        "{}\n... [truncated {} bytes]",
        &input[..end],
        input.len() - end
    )
}

/// The full choke-point transform: redact secrets against the
/// complete text, then truncate to [`MAX_OUTPUT_BYTES`]. This is the
/// only ordering that can't leak half a token by cutting it at the
/// truncation boundary — see the module doc.
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
        assert!(out.contains("://[REDACTED]@github.com"));
    }

    #[test]
    fn test_redacts_github_token_shapes() {
        for prefix in ["ghp", "gho", "ghu", "ghs"] {
            let token = format!("{prefix}_{}", "a".repeat(36));
            let input = format!("remote: Invalid username or password. token={token}");
            let out = redact(&input);
            assert!(
                !out.contains(&token),
                "expected {prefix}_ token to be redacted, got: {out}"
            );
            assert!(out.contains(REDACTED));
        }
    }

    #[test]
    fn test_redacts_anthropic_key() {
        let key = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";
        let input = format!("some log line embedding {key} by accident");
        let out = redact(&input);
        assert!(!out.contains(key));
        assert!(out.contains(REDACTED));
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
    fn test_truncate_cuts_at_budget_and_marks_it() {
        let input = "x".repeat(MAX_OUTPUT_BYTES + 500);
        let out = truncate(&input, MAX_OUTPUT_BYTES);
        assert!(out.len() < input.len());
        assert!(out.contains("truncated 500 bytes"));
    }

    #[test]
    fn test_truncate_never_splits_a_multibyte_char() {
        // Every char is 3 bytes (e.g. "€"); pick a budget that would
        // land mid-character if truncation were byte-naive.
        let input = "€".repeat(4000); // 12000 bytes
        let out = truncate(&input, 10);
        // Must not panic (String slicing on a non-boundary panics),
        // and the result must still be valid UTF-8 (guaranteed by type).
        assert!(out.len() <= 10 + "\n... [truncated 11990 bytes]".len());
    }

    #[test]
    fn test_sanitize_redacts_before_truncating_so_a_split_token_cant_leak() {
        // A secret placed exactly at the truncation boundary: if
        // truncation ran first, the second half of the token would
        // survive in the (now-unmatchable) truncated text. Redacting
        // first removes the whole token before truncation ever runs.
        let key = format!("sk-ant-{}", "b".repeat(40));
        let padding = "x".repeat(MAX_OUTPUT_BYTES - 10);
        let input = format!("{padding}{key}");
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
