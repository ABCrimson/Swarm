//! Remote URL parsing (`https`/`ssh`/GHES) and GitHub-style compare
//! URL construction.
//!
//! `git remote get-url origin` can return any of several shapes for
//! the same logical remote:
//!
//! - `https://github.com/owner/repo.git`
//! - `https://github.com/owner/repo` (no `.git` suffix, or a trailing `/`)
//! - `https://<userinfo>@github.com/owner/repo.git` — a `user:pass` pair
//!   or a bare token used as the username (GitHub accepts both). Either
//!   is a credential: [`parse`] discards it, and [`super::redact`] strips
//!   it from any URL that is surfaced.
//! - `git@github.com:owner/repo.git` (SSH "scp-like" syntax)
//! - `ssh://git@github.com/owner/repo.git` (SSH URL syntax)
//! - Any of the above with a GitHub Enterprise Server host instead of
//!   `github.com` — [`parse`] does not special-case the host, so GHES
//!   falls out for free.
//!
//! [`parse`] normalizes all of these into a [`ParsedRemote`]. It parses
//! any host structurally; whether that host can have a GitHub-style
//! compare URL is [`looks_like_github_host`]'s call, which the ship
//! chain (`ship::preflight` and `ship::compare_url`) makes before
//! building one with [`compare_url`].

use std::sync::LazyLock;

use regex::Regex;

/// A remote URL broken into the three components a compare URL needs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedRemote {
    /// The host, without port or userinfo.
    pub host: String,
    /// The owner (user or organization) path segment.
    pub owner: String,
    /// The repository name, without `.git`.
    pub repo: String,
}

/// `scheme://[userinfo@]host[:port]/owner/repo[.git]` — covers both
/// `https://` and `ssh://` URL-form remotes. Userinfo (if any) is
/// matched but discarded; keeping credentials out of logs and events is
/// [`super::redact`]'s job.
static URL_FORM: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^[a-zA-Z][a-zA-Z0-9+.-]*://(?:[^@/]+@)?([^/:]+)(?::\d+)?/([^/]+)/(.+?)$")
        .expect("valid regex")
});

/// `[user@]host:owner/repo[.git]` — SSH "scp-like" syntax (no `ssh://`
/// scheme, a bare `:` before the path instead of `/`).
static SCP_FORM: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(?:[^@/:]+@)?([^/:]+):([^/]+)/(.+?)$").expect("valid regex"));

/// The repository name: trailing `/` and then `.git` removed.
fn repo_name(raw: &str) -> &str {
    raw.trim_end_matches('/').trim_suffix(".git")
}

/// Parses a `git remote get-url` value into its host/owner/repo parts.
/// Returns `None` for a shape this parser doesn't recognize (e.g. a
/// local filesystem path remote) rather than guessing.
#[must_use = "parsing has no side effects"]
pub fn parse(url: &str) -> Option<ParsedRemote> {
    let url = url.trim();
    let caps = URL_FORM.captures(url).or_else(|| SCP_FORM.captures(url))?;
    let owner = caps.get(2)?.as_str();
    let repo = repo_name(caps.get(3)?.as_str());
    if owner.is_empty() || repo.is_empty() {
        return None;
    }
    Some(ParsedRemote {
        host: caps.get(1)?.as_str().to_owned(),
        owner: owner.to_owned(),
        repo: repo.to_owned(),
    })
}

/// Whether `host` is one [`compare_url`] can build a meaningful
/// GitHub-style compare URL for. `github.com` always qualifies; any
/// other host is treated as a possible GitHub Enterprise Server
/// instance — SWARM has no registry of GHES hostnames to check
/// against, so this is intentionally permissive rather than an
/// allowlist that would reject every real GHES customer. The one
/// thing it rejects outright is a host that is obviously not GitHub
/// by name — see [`NON_GITHUB_DOMAINS`].
#[must_use = "the check is the only result"]
pub fn looks_like_github_host(host: &str) -> bool {
    !is_known_non_github_host(host)
}

/// Forges that are known not to be GitHub. Each matches the domain and
/// every subdomain (`ssh.dev.azure.com`, `altssh.bitbucket.org`,
/// `git.sr.ht`). Used only to reject the clearly wrong case, never to
/// confirm a host IS GitHub (GHES hostnames are arbitrary).
pub const NON_GITHUB_DOMAINS: &[&str] = &[
    "gitlab.com",
    "bitbucket.org",
    "dev.azure.com",
    "visualstudio.com",
    "sourceforge.net",
    "codeberg.org",
    "gitea.com",
    "sr.ht",
];

fn is_known_non_github_host(host: &str) -> bool {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    NON_GITHUB_DOMAINS.iter().any(|domain| {
        host == *domain
            || host
                .strip_suffix(domain)
                .is_some_and(|prefix| prefix.ends_with('.'))
    })
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
                out.push(char::from(byte));
            }
            _ => push_percent_encoded(&mut out, byte),
        }
    }
    out
}

fn push_percent_encoded(out: &mut String, byte: u8) {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    out.push('%');
    out.push(char::from(HEX[usize::from(byte >> 4)]));
    out.push(char::from(HEX[usize::from(byte & 0x0F)]));
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
                out.push(char::from(byte));
            }
            b' ' => out.push('+'),
            _ => push_percent_encoded(&mut out, byte),
        }
    }
    out
}

/// Hard cap on the final compare URL's length. GitHub itself tolerates
/// much longer URLs, but browsers/OS "open URL" APIs have practical
/// limits well under 8K; 6000 leaves headroom. When the full
/// `title`+`body` would exceed it, the body is truncated first with a
/// visible marker; the title is clamped only as a last resort, and the
/// compare path (host/owner/repo/base/branch) is never truncated — see
/// [`compare_url`].
pub const MAX_COMPARE_URL_LEN: usize = 6000;

/// Binary-searches the longest prefix of `text` for which `fits(prefix)`
/// holds (`fits` must be monotonic: a shorter prefix never makes the
/// built URL longer). Cuts only on char boundaries, so a multi-byte
/// UTF-8 sequence is never split. Returns `""` if even an empty prefix
/// doesn't satisfy `fits`.
fn largest_fitting_prefix(text: &str, fits: impl Fn(&str) -> bool) -> &str {
    let boundaries: Vec<usize> = text
        .char_indices()
        .map(|(index, _)| index)
        .chain([text.len()])
        .collect();
    // `boundaries[n]` is the byte length of the first `n` chars, and
    // `boundaries[0] == 0` is the empty prefix, so the search runs over
    // the non-empty prefixes: `n` of them fit.
    let n = boundaries[1..].partition_point(|&end| fits(&text[..end]));
    &text[..boundaries[n]]
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
#[must_use = "building the URL has no side effects"]
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
    build(largest_fitting_prefix(title, title_fits), "")
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
    fn test_parse_trailing_slash() {
        assert_eq!(parse("https://github.com/o/r.git/").unwrap().repo, "r");
        assert_eq!(parse("https://github.com/o/r/").unwrap().repo, "r");
    }

    #[test]
    fn test_parse_discards_credentials_in_userinfo() {
        let token = format!("github_pat_{}", "A1".repeat(20));
        let r = parse(&format!("https://{token}@github.com/o/r.git")).unwrap();
        assert_eq!((r.host.as_str(), r.owner.as_str()), ("github.com", "o"));
        let r = parse("https://alice:hunter2@ghes.example.com:8443/team/repo").unwrap();
        assert_eq!(r.host, "ghes.example.com");
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
        for host in [
            "gitlab.com",
            "GitLab.com",
            "bitbucket.org",
            "altssh.bitbucket.org",
            "dev.azure.com",
            "ssh.dev.azure.com",
            "myorg.visualstudio.com",
            "codeberg.org",
            "gitea.com",
            "git.sr.ht",
            "gitlab.com.",
        ] {
            assert!(!looks_like_github_host(host), "{host}");
        }
        // A suffix match needs a label boundary.
        assert!(looks_like_github_host("notgitlab.com"));
    }

    /// Azure DevOps SSH remotes parse structurally; the host check is
    /// what keeps them from getting a bogus GitHub compare URL.
    #[test]
    fn test_azure_ssh_remote_is_not_github() {
        let r = parse("git@ssh.dev.azure.com:v3/org/proj/repo").unwrap();
        assert!(!looks_like_github_host(&r.host));
    }

    #[test]
    fn test_largest_fitting_prefix_respects_char_boundaries() {
        let text = "a\u{e9}\u{20ac}b";
        assert_eq!(largest_fitting_prefix(text, |p| p.len() <= 3), "a\u{e9}");
        assert_eq!(largest_fitting_prefix(text, |p| p.len() <= 100), text);
        assert_eq!(largest_fitting_prefix(text, |_| false), "");
        assert_eq!(largest_fitting_prefix("", |_| true), "");
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
        // Every 'x' encodes to one byte, so the largest fitting body
        // prefix fills the cap exactly.
        assert_eq!(url.len(), MAX_COMPARE_URL_LEN);
        assert!(url.contains("&body=xxxxxxxxxx"), "{url}");
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

    #[test]
    fn test_compare_url_percent_encodes_reserved_and_non_ascii_query_bytes() {
        let remote = ParsedRemote {
            host: "github.com".to_string(),
            owner: "o".to_string(),
            repo: "r".to_string(),
        };
        let url = compare_url(&remote, "main", "b", "a&b#c%d/e+f", "l1\nl2 \u{e9}");
        assert_eq!(
            url,
            "https://github.com/o/r/compare/main...b?quick_pull=1&title=a%26b%23c%25d%2Fe%2Bf&body=l1%0Al2+%C3%A9"
        );
    }

    /// When even an empty body plus the truncation marker does not fit,
    /// the title itself is clamped too, and the *result* respects the
    /// cap, not just "the empty-body attempt was the best we found".
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
        // Every 'T' encodes to one byte, so the largest fitting title
        // prefix fills the cap exactly, and the body is dropped.
        assert_eq!(url.len(), MAX_COMPARE_URL_LEN);
        assert!(url.contains("&title=TTTTTTTTTT"), "{url}");
        assert!(url.ends_with("&body="), "{url}");
    }
}
