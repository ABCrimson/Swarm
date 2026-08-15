//! Authentication: the daemon token, and Origin/Host validation for the
//! WS upgrade. Headless-daemon plan Phase 2 item 8: "never
//! unauthenticated, no flag to make it so."
//!
//! - **Token**: 256 bits from `getrandom`, hex-encoded, persisted at
//!   `<data_dir>/daemon-token` so it survives restarts (a client's
//!   saved fragment URL keeps working) — 0600 on Unix, a current-user-only
//!   DACL via `icacls` on Windows (simplest correct, per the plan's own
//!   note; the `windows` crate is the documented alternative if `icacls`
//!   ever proves insufficient). Restrictive permissions are re-applied
//!   on every load, not just at mint time, in case they were loosened
//!   out-of-band; an `icacls` failure escalates to a hard startup error
//!   when binding non-loopback (see [`DaemonToken::load_or_create`]'s
//!   doc) rather than a silent warning.
//! - **Non-loopback gate**: `--bind` to a non-loopback address is
//!   refused unless a token file ALREADY existed BEFORE this run — the
//!   operator must have completed at least one loopback-bound run
//!   first (where the token is minted and the connect URL is printed),
//!   so a fresh install can never be pointed at `0.0.0.0` blind.
//!   **security-review BLOCK-2**: the existence check
//!   ([`DaemonToken::exists`]) must run, and the gate must be evaluated,
//!   BEFORE [`DaemonToken::load_or_create`] is ever called — the two
//!   are deliberately separate functions so a refused run cannot mint
//!   the very token file that would let a SECOND identical invocation
//!   slip through the gate it just failed. `swarmd::main` is the
//!   caller that orders these correctly; this module only supplies the
//!   two operations.
//! - **Compare**: constant-time (`subtle`), so response timing cannot
//!   leak how many leading bytes of a guessed token matched.
//! - **Origin/Host**: WebSocket upgrades are exempt from CORS — without
//!   this check, any web page the user's browser visits could open a
//!   WS connection to a localhost daemon (and DNS rebinding could reach
//!   it from off-box). `Host` must match the daemon's own bind
//!   host:port; `Origin`, when present, must match `Host`'s host:port
//!   too. Host/port splitting is bracket-aware (`[::1]:8787`) and
//!   handles bare (portless) IPv6 addresses — see [`split_host_port`]
//!   (security-review FIX-6; a naive `str::split(':')` mangles every
//!   IPv6 form, silently treating `::1` as never-loopback).

use std::path::{Path, PathBuf};

use subtle::ConstantTimeEq;

const TOKEN_FILE: &str = "daemon-token";

/// The 256-bit daemon token, hex-encoded (64 chars).
#[derive(Clone)]
pub struct DaemonToken(String);

impl DaemonToken {
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// Constant-time equality — never short-circuits on the first
    /// mismatched byte.
    pub fn matches(&self, candidate: &str) -> bool {
        // Constant-time comparators require equal-length inputs; a
        // length mismatch is itself not a useful timing oracle (token
        // length is fixed/public — 64 hex chars), so comparing lengths
        // up front and returning false is fine.
        self.0.len() == candidate.len() && bool::from(self.0.as_bytes().ct_eq(candidate.as_bytes()))
    }

    /// `true` if a token file already exists at `<data_dir>/daemon-token`
    /// — a PURE existence check with no side effects (does not create,
    /// read, or touch the file). This is the non-loopback gate's ONLY
    /// legitimate input; calling [`Self::load_or_create`] first and
    /// inspecting its `pre_existing` flag is the exact bug
    /// security-review BLOCK-2 closed (that flag is `true` on a SECOND
    /// call precisely because the first call minted the file, even when
    /// the first call's caller went on to refuse and exit).
    pub fn exists(data_dir: &Path) -> bool {
        token_path(data_dir).is_file()
    }

    /// Loads the existing token at `<data_dir>/daemon-token`, or mints
    /// and persists a fresh one. Returns `(token, pre_existing,
    /// perms_restricted)`:
    ///
    /// - `pre_existing` — `false` only when this call minted a brand
    ///   new token. Informational only; the non-loopback bind gate must
    ///   use [`Self::exists`] BEFORE calling this, never this flag (see
    ///   the module doc's BLOCK-2 note) — this method mints
    ///   unconditionally on a missing/empty file regardless of caller
    ///   intent, so by the time it returns, the gate decision must
    ///   already have been made.
    /// - `perms_restricted` — `true` if the restrictive-permissions
    ///   step (0600 on Unix, an `icacls` current-user-only DACL on
    ///   Windows) succeeded, re-applied on EVERY load (not just at mint
    ///   time, in case permissions were loosened out-of-band). `false`
    ///   is not itself fatal here — the caller (`swarmd::main`) escalates
    ///   it to a hard startup error specifically when binding
    ///   non-loopback, where an unrestricted token file is a real
    ///   credential-exposure risk to other local accounts.
    pub fn load_or_create(data_dir: &Path) -> std::io::Result<(Self, bool, bool)> {
        let path = token_path(data_dir);
        if let Ok(existing) = std::fs::read_to_string(&path) {
            let trimmed = existing.trim();
            if !trimmed.is_empty() {
                let perms_restricted = restrict_permissions(&path).is_ok();
                if !perms_restricted {
                    tracing::warn!(
                        path = %path.display(),
                        "failed to re-apply restrictive permissions to the existing daemon-token file"
                    );
                }
                return Ok((Self(trimmed.to_string()), true, perms_restricted));
            }
        }

        let token = generate_token()?;
        std::fs::write(&path, &token)?;
        let perms_restricted = restrict_permissions(&path).is_ok();
        if !perms_restricted {
            tracing::warn!(
                path = %path.display(),
                "failed to restrict permissions on the newly minted daemon-token file"
            );
        }
        Ok((Self(token), false, perms_restricted))
    }
}

fn token_path(data_dir: &Path) -> PathBuf {
    data_dir.join(TOKEN_FILE)
}

fn generate_token() -> std::io::Result<String> {
    let mut buf = [0u8; 32]; // 256 bits
    getrandom::fill(&mut buf).map_err(|e| std::io::Error::other(e.to_string()))?;
    Ok(hex_encode(&buf))
}

fn hex_encode(bytes: &[u8]) -> String {
    use std::fmt::Write;
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        let _ = write!(s, "{b:02x}");
    }
    s
}

#[cfg(unix)]
fn restrict_permissions(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
}

#[cfg(windows)]
fn restrict_permissions(path: &Path) -> std::io::Result<()> {
    // Simplest-correct per the plan's own note: shell out to `icacls`
    // rather than hand-rolling Win32 ACL construction. A genuine
    // `Err` now propagates (security-review NIT — this used to always
    // return `Ok(())` even when `icacls` itself failed, silently
    // leaving the token file at whatever default ACL the filesystem
    // gave it); the caller decides severity — `swarmd::main` escalates
    // to a hard startup error only when binding non-loopback.
    let user = std::env::var("USERNAME")
        .map_err(|_| std::io::Error::other("USERNAME environment variable is not set"))?;
    let path_str = path.to_string_lossy().to_string();
    let output = std::process::Command::new("icacls")
        .arg(&path_str)
        .args(["/inheritance:r", "/grant:r", &format!("{user}:F")])
        .output()?;
    if output.status.success() {
        Ok(())
    } else {
        Err(std::io::Error::other(format!(
            "icacls exited with {}: {}",
            output.status,
            String::from_utf8_lossy(&output.stderr)
        )))
    }
}

/// `true` if `host` (bare, or `host:port`/`[ipv6]:port`-shaped) names a
/// loopback address (`127.0.0.1`, `::1`, or `localhost`).
pub fn is_loopback_host(host: &str) -> bool {
    let (host_only, _) = split_host_port(host);
    host_only == "127.0.0.1" || host_only == "localhost" || host_only == "::1"
}

/// Strips a `scheme://` prefix and any trailing path, leaving just
/// `host:port` (or `host`), for comparing an `Origin` header (which
/// carries a scheme) against a `Host` header (which does not).
fn strip_scheme_and_path(value: &str) -> &str {
    let without_scheme = match value.find("://") {
        Some(idx) => &value[idx + 3..],
        None => value,
    };
    without_scheme.split('/').next().unwrap_or(without_scheme)
}

/// Splits a `host:port`-shaped string into `(host, port)` —
/// bracket-aware for IPv6 (`[::1]:8787` -> `("::1", "8787")`,
/// `[::1]` -> `("::1", "")`) and correct for a BARE (portless) IPv6
/// address (`::1` -> `("::1", "")`, not the `("", "")`-shaped garbage a
/// naive `split(':').next()` or a plain `rsplit_once(':')` produces —
/// security-review FIX-6). IPv4/hostname forms with at most one colon
/// still split on the last colon as before.
fn split_host_port(input: &str) -> (&str, &str) {
    if let Some(rest) = input.strip_prefix('[') {
        // Bracketed IPv6, optionally with a port: [::1] or [::1]:8787
        return match rest.find(']') {
            Some(end) => {
                let host = &rest[..end];
                let after = &rest[end + 1..];
                let port = after.strip_prefix(':').unwrap_or("");
                (host, port)
            }
            None => (input, ""), // malformed (unterminated bracket) — treat as opaque host
        };
    }
    // 2+ colons with no brackets is unambiguously a bare IPv6 address —
    // `SocketAddr::to_string()` always brackets IPv6 when a port is
    // present, so an unbracketed multi-colon string can only be a raw
    // address a caller passed directly (e.g. `is_loopback_host("::1")`).
    if input.matches(':').count() >= 2 {
        return (input, "");
    }
    // IPv4 or hostname, optionally with a single :port.
    match input.rsplit_once(':') {
        Some((h, p)) => (h, p),
        None => (input, ""),
    }
}

/// Validates the `Host` and (if present) `Origin` headers of a WS
/// upgrade request against the daemon's own `bind_host_port`
/// (`"127.0.0.1:8787"`-shaped, no scheme).
///
/// # Errors
///
/// A human-readable, Title Case refusal reason.
pub fn validate_upgrade_headers(
    host_header: Option<&str>,
    origin_header: Option<&str>,
    bind_host_port: &str,
) -> Result<(), &'static str> {
    let host = host_header.ok_or("Missing Host Header.")?;
    let host = strip_scheme_and_path(host);
    if !hosts_equivalent(host, bind_host_port) {
        return Err("Host Header Does Not Match The Daemon's Bind Address.");
    }

    if let Some(origin) = origin_header {
        let origin_host = strip_scheme_and_path(origin);
        if !hosts_equivalent(origin_host, bind_host_port) {
            return Err("Origin Not Allowed.");
        }
    }

    Ok(())
}

/// Compares two `host:port` strings, treating `127.0.0.1`/`localhost`/
/// `::1` as interchangeable (all name a loopback listener) — a browser
/// client attaching to a `swarmd --serve-ui` page served from
/// `http://localhost:8787` must be able to open `ws://127.0.0.1:8787/ws`
/// (or vice versa) without tripping the Host/Origin guard.
fn hosts_equivalent(a: &str, b: &str) -> bool {
    if a == b {
        return true;
    }
    let (a_host, a_port) = split_host_port(a);
    let (b_host, b_port) = split_host_port(b);
    a_port == b_port && is_loopback_host(a_host) && is_loopback_host(b_host)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_token_roundtrip_and_matches() {
        let dir = std::env::temp_dir().join(format!("swarmd-auth-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(
            !DaemonToken::exists(&dir),
            "fresh dir must report no token file yet"
        );

        let (token, pre_existing, perms_ok) = DaemonToken::load_or_create(&dir).unwrap();
        assert!(!pre_existing, "first run must report no pre-existing token");
        assert!(
            perms_ok,
            "restricting permissions on a freshly minted token should succeed"
        );
        assert_eq!(token.as_str().len(), 64, "256 bits hex-encoded is 64 chars");
        assert!(token.matches(token.as_str()));
        assert!(!token.matches("wrong"));
        assert!(DaemonToken::exists(&dir), "token file must now exist");

        let (token2, pre_existing2, perms_ok2) = DaemonToken::load_or_create(&dir).unwrap();
        assert!(pre_existing2, "second call must find the persisted token");
        assert!(
            perms_ok2,
            "re-restricting permissions on load should also succeed"
        );
        assert_eq!(
            token.as_str(),
            token2.as_str(),
            "token must be stable across restarts"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// DIRECTIVE (security-review BLOCK-2): `exists()` never mints.
    /// Calling it any number of times against a directory with no token
    /// file must never create one — this is the whole property the
    /// non-loopback gate depends on.
    #[test]
    fn test_exists_never_creates_a_token_file() {
        let dir = std::env::temp_dir().join(format!("swarmd-auth-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(!DaemonToken::exists(&dir));
        assert!(!DaemonToken::exists(&dir));
        assert!(!DaemonToken::exists(&dir));
        assert!(
            !token_path(&dir).exists(),
            "repeated exists() calls must never create the token file"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_matches_rejects_wrong_length_without_panicking() {
        let dir = std::env::temp_dir().join(format!("swarmd-auth-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let (token, _, _) = DaemonToken::load_or_create(&dir).unwrap();
        assert!(!token.matches(""));
        assert!(!token.matches(&format!("{}extra", token.as_str())));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_is_loopback_host() {
        assert!(is_loopback_host("127.0.0.1:8787"));
        assert!(is_loopback_host("localhost:8787"));
        assert!(is_loopback_host("127.0.0.1"));
        assert!(!is_loopback_host("0.0.0.0:8787"));
        assert!(!is_loopback_host("evil.example.com:8787"));
    }

    /// DIRECTIVE (security-review FIX-6): every IPv6 loopback SHAPE a
    /// caller could plausibly pass — bare, bracketed with a port,
    /// bracketed without one.
    #[test]
    fn test_is_loopback_host_ipv6_forms() {
        assert!(is_loopback_host("::1"), "bare IPv6 loopback");
        assert!(is_loopback_host("[::1]:8787"), "bracketed IPv6 with a port");
        assert!(is_loopback_host("[::1]"), "bracketed IPv6, no port");
        assert!(
            !is_loopback_host("::2"),
            "a non-loopback IPv6 address must not match"
        );
        assert!(
            !is_loopback_host("[2001:db8::1]:8787"),
            "a non-loopback bracketed IPv6 address must not match"
        );
    }

    #[test]
    fn test_validate_upgrade_headers_rejects_missing_host() {
        let result = validate_upgrade_headers(None, None, "127.0.0.1:8787");
        assert!(result.is_err());
    }

    #[test]
    fn test_validate_upgrade_headers_rejects_dns_rebinding_style_host() {
        // A browser page served from evil.com whose DNS resolves to
        // 127.0.0.1 still sends Host: evil.com:8787 — this must be
        // rejected even though the TCP connection is genuinely local.
        let result = validate_upgrade_headers(Some("evil.com:8787"), None, "127.0.0.1:8787");
        assert!(result.is_err());
    }

    #[test]
    fn test_validate_upgrade_headers_accepts_matching_host_no_origin() {
        // A native client (wscat, tokio-tungstenite) sends no Origin at all.
        let result = validate_upgrade_headers(Some("127.0.0.1:8787"), None, "127.0.0.1:8787");
        assert!(result.is_ok());
    }

    #[test]
    fn test_validate_upgrade_headers_accepts_localhost_alias_for_127_0_0_1() {
        let result = validate_upgrade_headers(
            Some("localhost:8787"),
            Some("http://localhost:8787"),
            "127.0.0.1:8787",
        );
        assert!(result.is_ok());
    }

    /// DIRECTIVE (security-review FIX-6): an IPv6-loopback-bound daemon
    /// (`bind_host_port` itself bracketed) must accept a matching
    /// bracketed Host/Origin pair.
    #[test]
    fn test_validate_upgrade_headers_accepts_bracketed_ipv6_loopback() {
        let result =
            validate_upgrade_headers(Some("[::1]:8787"), Some("http://[::1]:8787"), "[::1]:8787");
        assert!(result.is_ok());
    }

    /// A browser resolving `localhost` to `::1` must still pass against
    /// a daemon whose `bind_host_port` is the IPv4 form (or vice versa)
    /// — both name the same loopback listener.
    #[test]
    fn test_validate_upgrade_headers_ipv6_and_ipv4_loopback_are_equivalent() {
        let result = validate_upgrade_headers(Some("[::1]:8787"), None, "127.0.0.1:8787");
        assert!(result.is_ok());
    }

    #[test]
    fn test_validate_upgrade_headers_rejects_cross_origin_browser_page() {
        // Origin present but naming a different host:port than our own
        // bind address — a random web page's script trying to reach
        // this localhost daemon.
        let result = validate_upgrade_headers(
            Some("127.0.0.1:8787"),
            Some("https://attacker.example.com"),
            "127.0.0.1:8787",
        );
        assert!(result.is_err());
    }

    #[test]
    fn test_validate_upgrade_headers_accepts_matching_same_origin_page() {
        let result = validate_upgrade_headers(
            Some("127.0.0.1:8787"),
            Some("http://127.0.0.1:8787"),
            "127.0.0.1:8787",
        );
        assert!(result.is_ok());
    }
}
