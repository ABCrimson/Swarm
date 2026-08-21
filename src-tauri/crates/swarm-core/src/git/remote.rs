//! Remote URL parsing (`https`/`ssh`/GHES) and GitHub-style compare
//! URL construction.
//!
//! `git remote get-url origin` can return any of several shapes for
//! the same logical remote:
//!
//! - `https://github.com/owner/repo.git`
//! - `https://github.com/owner/repo` (no `.git` suffix)
//! - `https://user@github.com/owner/repo.git` (username, no password —
//!   a bare username is not a credential leak the way `user:pass@` is,
//!   so this is not something [`super::redact`] strips)
//! - `git@github.com:owner/repo.git` (SSH "scp-like" syntax)
//! - `ssh://git@github.com/owner/repo.git` (SSH URL syntax)
//! - Any of the above with a GitHub Enterprise Server host instead of
//!   `github.com` — [`parse`] does not special-case the host, so GHES
//!   falls out for free.
//!
//! [`parse`] normalizes all of these into a [`ParsedRemote`]; anything
//! else (a non-`github`-shaped host is still parsed structurally, but
//! [`compare_url`]'s caller — `git_ship_preflight`/`ship_compare_url` —
//! decides whether the host is one a GitHub-style compare URL makes
//! sense for).

use std::sync::LazyLock;

use regex::Regex;

/// A remote URL broken into the three components a compare URL needs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedRemote {
    pub host: String,
    pub owner: String,
    pub repo: String,
}

/// `scheme://[user[:pass]@]host[:port]/owner/repo[.git]` — covers
/// both `https://` and `ssh://` URL-form remotes. Credentials (if any)
/// are matched but discarded; [`super::redact`] is the module
/// responsible for never letting a `user:pass@` shape reach a log or
/// event in the first place, so this parser doesn't need to repeat
/// that concern.
static URL_FORM: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^[a-zA-Z][a-zA-Z0-9+.-]*://(?:[^@/]+@)?([^/:]+)(?::\d+)?/([^/]+)/(.+?)$")
        .expect("valid regex")
});

/// `[user@]host:owner/repo[.git]` — SSH "scp-like" syntax (no `ssh://`
/// scheme, a bare `:` before the path instead of `/`).
static SCP_FORM: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(?:[^@/:]+@)?([^/:]+):([^/]+)/(.+?)$").expect("valid regex"));

/// Strips a trailing `.git` suffix, if present.
fn strip_dot_git(s: &str) -> &str {
    s.strip_suffix(".git").unwrap_or(s)
}

/// Parses a `git remote get-url` value into its host/owner/repo parts.
/// Returns `None` for a shape this parser doesn't recognize (e.g. a
/// local filesystem path remote) rather than guessing.
pub fn parse(url: &str) -> Option<ParsedRemote> {
    let url = url.trim();

    if let Some(caps) = URL_FORM.captures(url) {
        let host = caps.get(1)?.as_str().to_string();
        let owner = caps.get(2)?.as_str().to_string();
        let repo = strip_dot_git(caps.get(3)?.as_str()).to_string();
        if owner.is_empty() || repo.is_empty() {
            return None;
        }
        return Some(ParsedRemote { host, owner, repo });
    }

    if let Some(caps) = SCP_FORM.captures(url) {
        let host = caps.get(1)?.as_str().to_string();
        let owner = caps.get(2)?.as_str().to_string();
        let repo = strip_dot_git(caps.get(3)?.as_str()).to_string();
        if owner.is_empty() || repo.is_empty() {
            return None;
        }
        return Some(ParsedRemote { host, owner, repo });
    }

    None
}

/// Whether `host` is one [`compare_url`] can build a meaningful
/// GitHub-style compare URL for. `github.com` always qualifies; any
/// other host is treated as a possible GitHub Enterprise Server
/// instance — SWARM has no registry of GHES hostnames to check
/// against, so this is intentionally permissive rather than an
/// allowlist that would reject every real GHES customer. The one
/// thing it rejects outright is a host that is obviously not GitHub
/// at all by name (`gitlab.com`, `bitbucket.org`) — see
/// [`is_known_non_github_host`].
pub fn looks_like_github_host(host: &str) -> bool {
    !is_known_non_github_host(host)
}

/// Hosts known to not be GitHub/GHES — used only to reject the clearly
/// wrong case, never to affirmatively confirm a host IS GitHub (GHES
/// hostnames are arbitrary and unknowable in advance).
fn is_known_non_github_host(host: &str) -> bool {
    let lower = host.to_ascii_lowercase();
    matches!(
        lower.as_str(),
        "gitlab.com" | "bitbucket.org" | "dev.azure.com" | "sourceforge.net"
    ) || lower.ends_with(".gitlab.com")
        || lower.ends_with(".visualstudio.com")
}

/// Percent-encodes `s` for a URL path segment, per RFC 3986's
/// unreserved set (`A-Za-z0-9-_.~`) plus `/` — branch names routinely
/// (and meaningfully) contain `/` (`swarm/<slug>-<id8>`), and GitHub's
/// own compare URLs accept a literal, unencoded `/` in that position,
/// so encoding it would produce a URL that still works but no longer
/// matches what a user would type by hand.
fn percent_encode_path_segment(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for byte in s.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => {
                out.push(byte as char);
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// Percent-encodes `s` for a URL query-parameter value — the
/// unreserved set only (no `/` exception; a `/` inside a title/body
/// query value is not a path separator and must be encoded like any
/// other reserved character).
fn percent_encode_query_value(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for byte in s.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char);
            }
            b' ' => out.push('+'),
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// Hard cap on the final compare URL's length. GitHub itself tolerates
/// much longer URLs, but browsers/OS "open URL" APIs have practical
/// limits well under 8K; 6000 leaves headroom. When the full
/// `title`+`body` would exceed it, the body (never the title, and
/// never the branch/compare path) is truncated with a visible marker
/// — see [`compare_url`].
pub const MAX_COMPARE_URL_LEN: usize = 6000;

/// Binary-searches the largest char-prefix of `text` for which
/// `fits(prefix)` holds (`fits` must be monotonic: a shorter prefix
/// never makes the built URL longer), returning that prefix. Operates
/// on `char`s, never bytes, so a multi-byte UTF-8 sequence is never
/// split. Returns `""` if even an empty prefix doesn't satisfy `fits`.
fn largest_fitting_prefix(text: &str, fits: impl Fn(&str) -> bool) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut lo = 0usize;
    let mut hi = chars.len();
    while lo < hi {
        let mid = lo + (hi - lo).div_ceil(2);
        let candidate: String = chars[..mid].iter().collect();
        if fits(&candidate) {
            lo = mid;
        } else {
            hi = mid - 1;
        }
    }
    chars[..lo].iter().collect()
}

/// Builds a GitHub-style compare URL prefilled with a PR title/body
/// via the `quick_pull=1` query parameters, capped at
/// [`MAX_COMPARE_URL_LEN`] total characters.
///
/// If the untruncated URL would exceed the cap, `body` is shortened
/// first (with a visible truncation marker appended) until the
/// encoded result fits. If even an *empty* body (just the marker)
/// still doesn't fit — the base URL + title alone already exceed the
/// cap — `title` is clamped too, as the last resort: **only** the
/// compare path itself (host/owner/repo/base/branch) is never
/// truncated, since a corrupted ref there would silently build a URL
/// pointing at the wrong compare, a worse failure than a clipped
/// title.
pub fn compare_url(
    remote: &ParsedRemote,
    base_branch: &str,
    branch: &str,
    title: &str,
    body: &str,
) -> String {
    let base = format!(
        "https://{}/{}/{}/compare/{}...{}",
        remote.host,
        percent_encode_path_segment(&remote.owner),
        percent_encode_path_segment(&remote.repo),
        percent_encode_path_segment(base_branch),
        percent_encode_path_segment(branch),
    );

    let build = |title_text: &str, body_text: &str| -> String {
        format!(
            "{base}?quick_pull=1&title={}&body={}",
            percent_encode_query_value(title_text),
            percent_encode_query_value(body_text)
        )
    };

    let full = build(title, body);
    if full.len() <= MAX_COMPARE_URL_LEN {
        return full;
    }

    let marker = "\n\n[Truncated — Full Body Not Shown]";
    let body_with_marker_fits =
        |b: &str| build(title, &format!("{b}{marker}")).len() <= MAX_COMPARE_URL_LEN;
    if body_with_marker_fits("") {
        let shrunk_body = largest_fitting_prefix(body, body_with_marker_fits);
        return build(title, &format!("{shrunk_body}{marker}"));
    }

    // Even an empty body (just the marker) doesn't fit — clamp the
    // title too. Re-check with a genuinely empty body first: if that
    // alone still doesn't fit, the base URL/title are what's too long,
    // not the marker.
    let empty_body = build(title, "");
    if empty_body.len() <= MAX_COMPARE_URL_LEN {
        return empty_body;
    }
    let title_fits = |t: &str| build(t, "").len() <= MAX_COMPARE_URL_LEN;
    let shrunk_title = largest_fitting_prefix(title, title_fits);
    build(&shrunk_title, "")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_https_with_dot_git() {
        let r = parse("https://github.com/anthropics/swarm.git").unwrap();
        assert_eq!(r.host, "github.com");
        assert_eq!(r.owner, "anthropics");
        assert_eq!(r.repo, "swarm");
    }

    #[test]
    fn test_parse_https_without_dot_git() {
        let r = parse("https://github.com/anthropics/swarm").unwrap();
        assert_eq!(r.repo, "swarm");
    }

    #[test]
    fn test_parse_https_with_username() {
        let r = parse("https://x-access-token@github.com/anthropics/swarm.git").unwrap();
        assert_eq!(r.host, "github.com");
        assert_eq!(r.owner, "anthropics");
        assert_eq!(r.repo, "swarm");
    }

    #[test]
    fn test_parse_ssh_scp_syntax() {
        let r = parse("git@github.com:anthropics/swarm.git").unwrap();
        assert_eq!(r.host, "github.com");
        assert_eq!(r.owner, "anthropics");
        assert_eq!(r.repo, "swarm");
    }

    #[test]
    fn test_parse_ssh_url_syntax() {
        let r = parse("ssh://git@github.com/anthropics/swarm.git").unwrap();
        assert_eq!(r.host, "github.com");
        assert_eq!(r.owner, "anthropics");
        assert_eq!(r.repo, "swarm");
    }

    #[test]
    fn test_parse_ghes_host() {
        let r = parse("https://github.mycompany.internal/team/repo.git").unwrap();
        assert_eq!(r.host, "github.mycompany.internal");
        assert_eq!(r.owner, "team");
        assert_eq!(r.repo, "repo");
    }

    #[test]
    fn test_parse_ghes_ssh_scp_host() {
        let r = parse("git@github.mycompany.internal:team/repo.git").unwrap();
        assert_eq!(r.host, "github.mycompany.internal");
    }

    #[test]
    fn test_parse_rejects_unrecognized_shape() {
        assert!(parse("/local/path/to/repo").is_none());
        assert!(parse("not a url at all").is_none());
    }

    #[test]
    fn test_looks_like_github_host_accepts_github_and_unknown_ghes() {
        assert!(looks_like_github_host("github.com"));
        assert!(looks_like_github_host("github.mycompany.internal"));
        assert!(looks_like_github_host("git.acmecorp.example"));
    }

    #[test]
    fn test_looks_like_github_host_rejects_known_non_github_hosts() {
        assert!(!looks_like_github_host("gitlab.com"));
        assert!(!looks_like_github_host("bitbucket.org"));
        assert!(!looks_like_github_host("dev.azure.com"));
    }

    #[test]
    fn test_compare_url_basic_shape() {
        let remote = ParsedRemote {
            host: "github.com".to_string(),
            owner: "anthropics".to_string(),
            repo: "swarm".to_string(),
        };
        let url = compare_url(
            &remote,
            "main",
            "swarm/agent-abcd1234",
            "Fix Thing",
            "Body text.",
        );
        assert!(url.starts_with(
            "https://github.com/anthropics/swarm/compare/main...swarm/agent-abcd1234?quick_pull=1"
        ));
        assert!(url.contains("title=Fix+Thing"));
        assert!(url.contains("body=Body+text."));
    }

    #[test]
    fn test_compare_url_branch_slash_not_percent_encoded() {
        let remote = ParsedRemote {
            host: "github.com".to_string(),
            owner: "o".to_string(),
            repo: "r".to_string(),
        };
        let url = compare_url(&remote, "main", "swarm/agent-abcd1234", "t", "b");
        assert!(url.contains("/compare/main...swarm/agent-abcd1234?"));
        assert!(!url.contains("%2F"));
    }

    #[test]
    fn test_compare_url_caps_total_length_and_marks_truncation() {
        let remote = ParsedRemote {
            host: "github.com".to_string(),
            owner: "o".to_string(),
            repo: "r".to_string(),
        };
        let huge_body = "x".repeat(20_000);
        let url = compare_url(&remote, "main", "swarm/agent-abcd1234", "Title", &huge_body);
        assert!(
            url.len() <= MAX_COMPARE_URL_LEN,
            "expected url.len() <= {MAX_COMPARE_URL_LEN}, got {}",
            url.len()
        );
        assert!(url.contains("Truncated"));
        // Title must survive intact even though the body was cut.
        assert!(url.contains("title=Title"));
    }

    #[test]
    fn test_compare_url_short_body_never_truncated() {
        let remote = ParsedRemote {
            host: "github.com".to_string(),
            owner: "o".to_string(),
            repo: "r".to_string(),
        };
        let url = compare_url(&remote, "main", "b", "t", "short body");
        assert!(!url.contains("Truncated"));
    }

    /// DIRECTIVE (nit): re-check the cap when the body-shrink binary
    /// search bottoms out at `lo == 0` (even an empty body + marker
    /// doesn't fit) — the title itself must then be clamped too, and
    /// the *result* must actually respect the cap, not just "the
    /// empty-body attempt was the best we found".
    #[test]
    fn test_compare_url_clamps_title_when_even_an_empty_body_does_not_fit() {
        let remote = ParsedRemote {
            host: "github.com".to_string(),
            owner: "o".to_string(),
            repo: "r".to_string(),
        };
        let huge_title = "T".repeat(7000);
        let url = compare_url(
            &remote,
            "main",
            "swarm/agent-abcd1234",
            &huge_title,
            "any body",
        );
        assert!(
            url.len() <= MAX_COMPARE_URL_LEN,
            "expected url.len() <= {MAX_COMPARE_URL_LEN}, got {}",
            url.len()
        );
        // The compare path itself must survive untouched even though
        // the title was clamped.
        assert!(url.starts_with(
            "https://github.com/o/r/compare/main...swarm/agent-abcd1234?quick_pull=1"
        ));
    }
}
