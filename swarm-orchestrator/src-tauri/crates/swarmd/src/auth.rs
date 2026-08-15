//! Authentication: the daemon token, and Origin/Host validation for the
//! WS upgrade. Headless-daemon plan Phase 2 item 8: "never
//! unauthenticated, no flag to make it so."
//!
//! - **Token**: 256 bits from `getrandom`, hex-encoded, persisted at
//!   `<data_dir>/daemon-token` so it survives restarts (a client's
//!   saved fragment URL keeps working) — 0600 on Unix, a current-user-only
//!   DACL via `icacls` on Windows (simplest correct, per the plan's own
//!   note; the `windows` crate is the documented alternative if `icacls`
//!   ever proves insufficient).
//! - **Non-loopback gate**: `--bind` to a non-loopback address is
//!   refused unless a token file ALREADY existed before this run — the
//!   operator must have completed at least one loopback-bound run
//!   first (where the token is minted and the connect URL is printed),
//!   so a fresh install can never be pointed at `0.0.0.0` blind.
//! - **Compare**: constant-time (`subtle`), so response timing cannot
//!   leak how many leading bytes of a guessed token matched.
//! - **Origin/Host**: WebSocket upgrades are exempt from CORS — without
//!   this check, any web page the user's browser visits could open a
//!   WS connection to a localhost daemon (and DNS rebinding could reach
//!   it from off-box). `Host` must match the daemon's own bind
//!   host:port; `Origin`, when present, must match `Host`'s host:port
//!   too.

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

    /// Loads the existing token at `<data_dir>/daemon-token`, or mints
    /// and persists a fresh one. Returns `(token, pre_existing)` —
    /// `pre_existing` is `false` only on the very first run against a
    /// fresh data dir, which [`crate::main`]'s non-loopback gate uses.
    pub fn load_or_create(data_dir: &Path) -> std::io::Result<(Self, bool)> {
        let path = token_path(data_dir);
        if let Ok(existing) = std::fs::read_to_string(&path) {
            let trimmed = existing.trim();
            if !trimmed.is_empty() {
                return Ok((Self(trimmed.to_string()), true));
            }
        }

        let token = generate_token()?;
        write_token_file(&path, &token)?;
        Ok((Self(token), false))
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

fn write_token_file(path: &Path, token: &str) -> std::io::Result<()> {
    std::fs::write(path, token)?;
    restrict_permissions(path)
}

#[cfg(unix)]
fn restrict_permissions(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
}

#[cfg(windows)]
fn restrict_permissions(path: &Path) -> std::io::Result<()> {
    // Simplest-correct per the plan's own note: shell out to `icacls`
    // rather than hand-rolling Win32 ACL construction. Best-effort —
    // logged, not fatal, since the OS-level file-open exclusivity the
    // single-instance lock already relies on is independent of this,
    // and a failure here should not prevent the daemon from starting
    // (the token file still exists; it's merely not hardened).
    let user = std::env::var("USERNAME").unwrap_or_default();
    if user.is_empty() {
        tracing::warn!("could not resolve USERNAME; leaving daemon-token ACL at OS default");
        return Ok(());
    }
    let path_str = path.to_string_lossy().to_string();
    let output = std::process::Command::new("icacls")
        .arg(&path_str)
        .args(["/inheritance:r", "/grant:r", &format!("{user}:F")])
        .output();
    match output {
        Ok(o) if o.status.success() => Ok(()),
        Ok(o) => {
            tracing::warn!(
                stderr = %String::from_utf8_lossy(&o.stderr),
                "icacls failed to restrict daemon-token permissions"
            );
            Ok(())
        }
        Err(e) => {
            tracing::warn!(error = %e, "failed to invoke icacls to restrict daemon-token permissions");
            Ok(())
        }
    }
}

/// `true` if `host` (the address:port portion, no scheme) names a
/// loopback address (`127.0.0.1`, `::1`, or `localhost`).
pub fn is_loopback_host(host: &str) -> bool {
    let host_only = host.split(':').next().unwrap_or(host);
    host_only == "127.0.0.1"
        || host_only == "localhost"
        || host_only == "::1"
        || host_only == "[::1]"
}

/// Strips a `scheme://` prefix and any trailing path, leaving just
/// `host:port` (or `host`), for comparing an `Origin` header (which
/// carries a scheme) against a `Host` header (which does not).
fn host_port_only(value: &str) -> &str {
    let without_scheme = match value.find("://") {
        Some(idx) => &value[idx + 3..],
        None => value,
    };
    without_scheme.split('/').next().unwrap_or(without_scheme)
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
    let host = host_port_only(host);
    if !hosts_equivalent(host, bind_host_port) {
        return Err("Host Header Does Not Match The Daemon's Bind Address.");
    }

    if let Some(origin) = origin_header {
        let origin_host = host_port_only(origin);
        if !hosts_equivalent(origin_host, bind_host_port) {
            return Err("Origin Not Allowed.");
        }
    }

    Ok(())
}

/// Compares two `host:port` strings, treating `127.0.0.1`/`localhost`
/// as interchangeable (both name the same loopback listener) — a
/// browser client attaching to a `swarmd --serve-ui` page served from
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

fn split_host_port(hp: &str) -> (&str, &str) {
    match hp.rsplit_once(':') {
        Some((h, p)) => (h, p),
        None => (hp, ""),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_token_roundtrip_and_matches() {
        let dir = std::env::temp_dir().join(format!("swarmd-auth-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let (token, pre_existing) = DaemonToken::load_or_create(&dir).unwrap();
        assert!(!pre_existing, "first run must report no pre-existing token");
        assert_eq!(token.as_str().len(), 64, "256 bits hex-encoded is 64 chars");
        assert!(token.matches(token.as_str()));
        assert!(!token.matches("wrong"));

        let (token2, pre_existing2) = DaemonToken::load_or_create(&dir).unwrap();
        assert!(pre_existing2, "second call must find the persisted token");
        assert_eq!(
            token.as_str(),
            token2.as_str(),
            "token must be stable across restarts"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_matches_rejects_wrong_length_without_panicking() {
        let dir = std::env::temp_dir().join(format!("swarmd-auth-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let (token, _) = DaemonToken::load_or_create(&dir).unwrap();
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
