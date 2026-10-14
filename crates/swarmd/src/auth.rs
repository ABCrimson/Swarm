//! Who may talk to the daemon: the bearer token, and the `Host`/`Origin`
//! allow-list every request passes before it reaches a route. There is no
//! unauthenticated mode and no flag that enables one.
//!
//! # The daemon token
//!
//! 256 bits from `getrandom`, hex-encoded (64 characters), persisted at
//! `<data_dir>/daemon-token` so a client's saved connect URL keeps working
//! across restarts.
//!
//! - **Created atomically, already private.** A fresh token is written to a
//!   temporary file (mode `0600` on Unix; on Windows its DACL is reduced to
//!   the current user's SID before it gets its real name), synced, and then
//!   linked into place with a no-clobber rename. No reader can ever observe
//!   a partial token or a world-readable one, and two racing first runs
//!   converge on whichever file landed first.
//! - **Validated on load.** Only exactly 64 hex characters are accepted. A
//!   malformed file is an error, never silently replaced: the operator
//!   deletes it to mint a new one.
//! - **Permissions re-applied on every load**, in case they were loosened
//!   out of band. The outcome is reported in [`LoadedToken::permissions`];
//!   `main` treats a failure as fatal when binding a non-loopback address
//!   and as a warning on loopback.
//! - **Non-loopback gate.** `--bind` to a non-loopback address is refused
//!   unless a valid token file ALREADY exists, so a fresh install can never
//!   be pointed at `0.0.0.0` blind: the operator first completes one
//!   loopback run, which mints the token and prints the connect URL.
//!   [`DaemonToken::load`] is a pure check and must be evaluated BEFORE
//!   [`DaemonToken::load_or_create`]; minting first would let a refused run
//!   create the very file that lets an identical second run through.
//! - **Constant-time comparison** (`subtle`), so response timing does not
//!   reveal how many leading bytes of a guess matched.
//!
//! # The `Host`/`Origin` allow-list
//!
//! WebSocket upgrades are exempt from CORS, and a DNS-rebinding page can
//! make a browser send requests to a loopback daemon under an attacker's
//! host name. [`HostPolicy::check`] therefore runs on EVERY request (the
//! static `--serve-ui` routes as well as `/ws`). A `Host` header (and an
//! `Origin`, when the client sends one) is accepted when it names:
//!
//! - the concrete local address the TCP connection arrived on, as an IP
//!   literal with the same port (this is what makes `--bind 0.0.0.0` usable:
//!   a LAN client's `Host: 192.168.1.5:8787` names the interface it reached);
//! - any loopback spelling (`localhost`, `127.0.0.0/8`, `::1`, IPv4-mapped
//!   forms) with the same port, when the connection arrived on loopback;
//! - an operator-supplied `--allow-host NAME[:PORT]` entry, for reverse
//!   proxies and MagicDNS names. An entry without a port matches any port.
//!
//! Anything else, including every DNS name that is not explicitly allowed,
//! is rejected with 403. Parsing goes through `http`'s own `Authority`/`Uri`
//! parsers (bracketed IPv6, default ports by scheme, case-insensitive
//! names), not hand-rolled string splitting.

use std::fmt;
use std::io::{self, Write};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::str::FromStr;

use axum::http::Uri;
use axum::http::uri::Authority;
use subtle::ConstantTimeEq;

const TOKEN_FILE: &str = "daemon-token";

/// Length of the hex-encoded token: 32 random bytes, two characters each.
pub const TOKEN_HEX_LEN: usize = 64;

/// The 256-bit daemon token, hex-encoded.
///
/// `Debug` is redacted: the token is equivalent to shell access as the user
/// running `swarmd` and must never reach a log line.
#[derive(Clone)]
pub struct DaemonToken(Box<str>);

impl fmt::Debug for DaemonToken {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("DaemonToken(<redacted>)")
    }
}

/// Result of [`DaemonToken::load_or_create`].
#[derive(Debug)]
pub struct LoadedToken {
    pub token: DaemonToken,
    /// `true` when this call created the token file.
    pub minted: bool,
    /// Outcome of restricting the token file to the current user (`0600` on
    /// Unix, a current-user-SID-only DACL on Windows). The caller decides
    /// how severe a failure is; the error explains what went wrong.
    pub permissions: io::Result<()>,
}

impl DaemonToken {
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// Constant-time equality: never short-circuits on the first mismatched
    /// byte. The length check up front leaks nothing useful, because the
    /// token length is fixed and public.
    pub fn matches(&self, candidate: &str) -> bool {
        self.0.len() == candidate.len() && bool::from(self.0.as_bytes().ct_eq(candidate.as_bytes()))
    }

    /// Reads the token at `<data_dir>/daemon-token` without ever creating
    /// or modifying it. `Ok(None)` means no token file exists yet.
    ///
    /// # Errors
    ///
    /// Any I/O error other than "not found", or a file that does not hold a
    /// valid token.
    pub fn load(data_dir: &Path) -> io::Result<Option<Self>> {
        read_token(&token_path(data_dir))
    }

    /// Loads the token at `<data_dir>/daemon-token`, or mints and persists a
    /// fresh one when no file exists.
    ///
    /// # Errors
    ///
    /// Any I/O error other than "not found" while reading, an existing file
    /// that does not hold a valid token (it is never overwritten), or a
    /// failure to create the file. A permissions failure is NOT an error
    /// here; it is reported in [`LoadedToken::permissions`].
    pub fn load_or_create(data_dir: &Path) -> io::Result<LoadedToken> {
        let path = token_path(data_dir);
        if let Some(token) = read_token(&path)? {
            return Ok(LoadedToken {
                token,
                minted: false,
                permissions: restrict_permissions(&path),
            });
        }
        mint(&path)
    }
}

fn token_path(data_dir: &Path) -> PathBuf {
    data_dir.join(TOKEN_FILE)
}

/// Reads and validates the token file. `Ok(None)` means the file does not
/// exist; a file that exists but does not hold exactly 64 hex characters
/// (surrounding whitespace ignored) is an `InvalidData` error.
fn read_token(path: &Path) -> io::Result<Option<DaemonToken>> {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e),
    };
    match std::str::from_utf8(bytes.trim_ascii()) {
        Ok(token)
            if token.len() == TOKEN_HEX_LEN && token.bytes().all(|b| b.is_ascii_hexdigit()) =>
        {
            Ok(Some(DaemonToken(token.into())))
        }
        _ => Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!(
                "{} Does Not Hold A Valid Daemon Token (Expected {TOKEN_HEX_LEN} Hex Characters). \
                 Delete It To Mint A New Token.",
                path.display()
            ),
        )),
    }
}

/// Mints a token into a private temporary file beside `path`, then links it
/// into place without clobbering. If another process won the race, its
/// token is loaded instead.
fn mint(path: &Path) -> io::Result<LoadedToken> {
    let mut bytes = [0u8; TOKEN_HEX_LEN / 2];
    getrandom::fill(&mut bytes).map_err(io::Error::other)?;
    let token = hex_encode(&bytes);

    let dir = path.parent().unwrap_or(Path::new("."));
    // `tempfile` creates the file with mode 0600 on Unix.
    let mut file = tempfile::Builder::new()
        .prefix(".daemon-token.")
        .tempfile_in(dir)?;
    file.write_all(token.as_bytes())?;
    file.as_file().sync_all()?;
    // Close the handle before touching the DACL on Windows, and before the rename.
    let temp_path = file.into_temp_path();
    let permissions = restrict_permissions(&temp_path);

    match temp_path.persist_noclobber(path) {
        Ok(()) => Ok(LoadedToken {
            token: DaemonToken(token.into()),
            minted: true,
            permissions,
        }),
        Err(e) if e.error.kind() == io::ErrorKind::AlreadyExists => {
            let token = read_token(path)?.ok_or(e.error)?;
            Ok(LoadedToken {
                token,
                minted: false,
                permissions: restrict_permissions(path),
            })
        }
        Err(e) => Err(e.error),
    }
}

fn hex_encode(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for &b in bytes {
        out.push(char::from(DIGITS[usize::from(b >> 4)]));
        out.push(char::from(DIGITS[usize::from(b & 0x0f)]));
    }
    out
}

#[cfg(unix)]
fn restrict_permissions(path: &Path) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
}

#[cfg(windows)]
fn restrict_permissions(path: &Path) -> io::Result<()> {
    windows_acl::restrict_to_current_user(path)
}

/// The SID in one line of `whoami /user /fo csv /nh` output, which
/// looks like `"DOMAIN\user","S-1-5-21-..."` followed by a line ending: the
/// last comma-separated field with its quotes removed, accepted only when it
/// is the `S-` prefix followed by digits and dashes. Platform-independent so
/// the parsing is tested everywhere, although only the Windows ACL path calls it.
#[cfg_attr(
    all(not(windows), not(test)),
    expect(
        dead_code,
        reason = "only the Windows ACL path calls it; the parser is tested on every platform"
    )
)]
fn sid_from_whoami_csv(stdout: &str) -> Option<&str> {
    let sid = stdout.trim().rsplit(',').next()?.trim_matches('"');
    let digits = sid.strip_prefix("S-")?;
    (!digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit() || b == b'-')).then_some(sid)
}

/// Reduces a file's DACL to a single full-control ACE for the current
/// user's SID. The workspace denies `unsafe`, so this drives the system's
/// own `whoami.exe` and `icacls.exe`, both resolved from `%SystemRoot%`
/// rather than a `PATH` search.
#[cfg(windows)]
mod windows_acl {
    use std::io;
    use std::path::{Path, PathBuf};
    use std::process::Command;

    pub(super) fn restrict_to_current_user(path: &Path) -> io::Result<()> {
        let system32 = system32()?;
        let sid = current_user_sid(&system32)?;
        let icacls = system32.join("icacls.exe");
        // `/reset` drops explicit ACEs a previous owner may have added (for
        // example `Everyone:(R)`); `/inheritance:r` then drops the inherited
        // ones, and `/grant:r` leaves exactly one ACE: this user, full control.
        run(Command::new(&icacls).arg(path).arg("/reset"))?;
        run(Command::new(&icacls)
            .arg(path)
            .args(["/inheritance:r", "/grant:r"])
            .arg(format!("*{sid}:F")))
    }

    fn system32() -> io::Result<PathBuf> {
        std::env::var_os("SystemRoot")
            .map(PathBuf::from)
            .filter(|root| root.is_absolute())
            .map(|root| root.join("System32"))
            .ok_or_else(|| io::Error::other("%SystemRoot% is not set to an absolute path"))
    }

    /// The current user's SID, from `whoami /user /fo csv /nh`, which prints
    /// one line: `"DOMAIN\user","S-1-5-21-..."`. A SID never contains a comma.
    fn current_user_sid(system32: &Path) -> io::Result<String> {
        let output = Command::new(system32.join("whoami.exe"))
            .args(["/user", "/fo", "csv", "/nh"])
            .output()?;
        if !output.status.success() {
            return Err(io::Error::other(format!(
                "whoami exited with {}",
                output.status
            )));
        }
        let stdout = String::from_utf8_lossy(&output.stdout);
        super::sid_from_whoami_csv(&stdout)
            .map(str::to_owned)
            .ok_or_else(|| io::Error::other(format!("unexpected whoami output: {stdout}")))
    }

    fn run(command: &mut Command) -> io::Result<()> {
        let output = command.output()?;
        if output.status.success() {
            Ok(())
        } else {
            Err(io::Error::other(format!(
                "icacls exited with {}: {}",
                output.status,
                String::from_utf8_lossy(&output.stderr).trim()
            )))
        }
    }
}

/// A host as it appears in a `Host` header, an `Origin`, or an
/// `--allow-host` entry.
#[derive(Clone, Debug, PartialEq, Eq)]
enum HostName {
    Ip(IpAddr),
    /// A DNS name, lowercased, without a trailing dot.
    Domain(Box<str>),
}

impl HostName {
    /// Parses the host part of an authority (`example.com`, `127.0.0.1`,
    /// `[::1]`). A bare, unbracketed IPv6 address is not a valid authority
    /// host and is rejected.
    fn parse(raw: &str) -> Option<Self> {
        if let Some(v6) = raw
            .strip_prefix('[')
            .and_then(|rest| rest.strip_suffix(']'))
        {
            return v6
                .parse::<Ipv6Addr>()
                .ok()
                .map(|ip| Self::Ip(IpAddr::V6(ip)));
        }
        if let Ok(v4) = raw.parse::<Ipv4Addr>() {
            return Some(Self::Ip(IpAddr::V4(v4)));
        }
        let name = raw.trim_suffix('.').to_ascii_lowercase();
        (!name.is_empty() && !name.contains(':')).then(|| Self::Domain(name.into()))
    }

    fn is_loopback(&self) -> bool {
        match self {
            Self::Ip(ip) => ip.to_canonical().is_loopback(),
            Self::Domain(name) => &**name == "localhost",
        }
    }
}

/// Splits a `Host`-header-shaped authority into its host and optional port.
/// Userinfo (`user@host`) is never valid here.
fn parse_authority(raw: &str) -> Option<(HostName, Option<u16>)> {
    if raw.contains('@') {
        return None;
    }
    let authority = raw.parse::<Authority>().ok()?;
    Some((HostName::parse(authority.host())?, authority.port_u16()))
}

/// Parses an `Origin` header into its host and effective port (the scheme's
/// default when none is given). Only `http`/`https` origins can belong to a
/// page the daemon served; `null` and every other scheme are rejected.
fn parse_origin(raw: &str) -> Option<(HostName, u16)> {
    let uri = raw.parse::<Uri>().ok()?;
    let default_port = match uri.scheme_str()? {
        "http" => 80,
        "https" => 443,
        _ => return None,
    };
    let authority = uri.authority()?;
    if authority.as_str().contains('@') {
        return None;
    }
    Some((
        HostName::parse(authority.host())?,
        authority.port_u16().unwrap_or(default_port),
    ))
}

/// One `--allow-host NAME[:PORT]` entry: a DNS name or IP address clients
/// may use to reach the daemon (for example a reverse proxy's public name).
/// Without a port it matches any port.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AllowedHost {
    host: HostName,
    port: Option<u16>,
}

/// Error for a malformed [`AllowedHost`].
#[derive(Debug, thiserror::Error)]
#[error("Invalid Host \"{0}\": Expected NAME, NAME:PORT, IP, Or [IPv6]:PORT")]
pub struct InvalidAllowedHost(String);

impl FromStr for AllowedHost {
    type Err = InvalidAllowedHost;

    fn from_str(raw: &str) -> Result<Self, Self::Err> {
        parse_authority(raw.trim())
            .map(|(host, port)| Self { host, port })
            .ok_or_else(|| InvalidAllowedHost(raw.to_owned()))
    }
}

/// Why [`HostPolicy::check`] refused a request. `Display` is the Title Case
/// message sent back in the 403 body.
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
pub enum Rejection {
    #[error("Missing Host Header.")]
    MissingHost,
    #[error("Malformed Host Header.")]
    MalformedHost,
    #[error("Host Header Does Not Name This Daemon.")]
    HostNotAllowed,
    #[error("Origin Not Allowed.")]
    OriginNotAllowed,
}

/// The `Host`/`Origin` allow-list (see the module doc).
#[derive(Clone, Debug, Default)]
pub struct HostPolicy {
    extra: Vec<AllowedHost>,
}

impl HostPolicy {
    /// A policy that accepts the connection's own local address (plus its
    /// loopback aliases) and every `extra` entry.
    pub fn new(extra: impl IntoIterator<Item = AllowedHost>) -> Self {
        Self {
            extra: extra.into_iter().collect(),
        }
    }

    /// Checks one request. `local` is the local address the TCP connection
    /// arrived on (`None` if the OS could not report it, in which case only
    /// explicit `--allow-host` entries can match). `host` defaults to port
    /// 80 when it has none, because the daemon itself only speaks plain
    /// HTTP; `origin` uses its scheme's default port.
    ///
    /// # Errors
    ///
    /// The [`Rejection`] naming the first header that failed.
    pub fn check(
        &self,
        local: Option<SocketAddr>,
        host: Option<&str>,
        origin: Option<&str>,
    ) -> Result<(), Rejection> {
        let (name, port) =
            parse_authority(host.ok_or(Rejection::MissingHost)?).ok_or(Rejection::MalformedHost)?;
        if !self.allows(&name, port.unwrap_or(80), local) {
            return Err(Rejection::HostNotAllowed);
        }
        if let Some(origin) = origin {
            let (name, port) = parse_origin(origin).ok_or(Rejection::OriginNotAllowed)?;
            if !self.allows(&name, port, local) {
                return Err(Rejection::OriginNotAllowed);
            }
        }
        Ok(())
    }

    fn allows(&self, host: &HostName, port: u16, local: Option<SocketAddr>) -> bool {
        let names_this_connection = local.is_some_and(|local| {
            let own_ip = local.ip().to_canonical();
            port == local.port()
                && match host {
                    HostName::Ip(ip) => {
                        let ip = ip.to_canonical();
                        ip == own_ip || (ip.is_loopback() && own_ip.is_loopback())
                    }
                    HostName::Domain(_) => host.is_loopback() && own_ip.is_loopback(),
                }
        });
        names_this_connection
            || self
                .extra
                .iter()
                .any(|allowed| allowed.host == *host && allowed.port.is_none_or(|p| p == port))
    }
}

#[cfg(test)]
mod whoami_tests {
    use super::sid_from_whoami_csv;

    /// The exact line a GitHub windows-2025 runner printed on 2026-10-14; the
    /// first parser rejected every real SID because its leading S is neither
    /// a digit nor a dash.
    #[test]
    fn parses_the_runner_output() {
        let line =
            "\"runnervmfi6oq\\runneradmin\",\"S-1-5-21-1643835476-1616584234-1346609752-500\"\r\n";
        assert_eq!(
            sid_from_whoami_csv(line),
            Some("S-1-5-21-1643835476-1616584234-1346609752-500")
        );
    }

    #[test]
    fn rejects_anything_that_is_not_a_sid() {
        for bad in [
            "",
            "\"a\",\"b\"",
            "\"x\",\"S-\"",
            "S-1-5-xyz",
            "\"u\",\"S-1-5-21-1,2\"",
        ] {
            assert_eq!(sid_from_whoami_csv(bad), None, "{bad:?}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    fn loopback(port: u16) -> Option<SocketAddr> {
        Some(SocketAddr::from(([127, 0, 0, 1], port)))
    }

    fn policy(extra: &[&str]) -> HostPolicy {
        HostPolicy::new(extra.iter().map(|e| e.parse::<AllowedHost>().unwrap()))
    }

    #[test]
    fn test_token_is_minted_once_and_stable_across_loads() {
        let dir = temp_dir();
        assert!(
            !matches!(DaemonToken::load(dir.path()), Ok(Some(_))),
            "fresh dir has no token"
        );

        let first = DaemonToken::load_or_create(dir.path()).unwrap();
        assert!(first.minted);
        first.permissions.unwrap();
        assert_eq!(first.token.as_str().len(), TOKEN_HEX_LEN);
        assert!(first.token.matches(first.token.as_str()));
        assert!(matches!(DaemonToken::load(dir.path()), Ok(Some(_))));

        let second = DaemonToken::load_or_create(dir.path()).unwrap();
        assert!(!second.minted, "second load finds the persisted token");
        second.permissions.unwrap();
        assert_eq!(first.token.as_str(), second.token.as_str());

        // No temporary file is left behind.
        let names: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(names, [TOKEN_FILE]);
    }

    #[cfg(unix)]
    #[test]
    fn test_minted_token_file_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = temp_dir();
        DaemonToken::load_or_create(dir.path()).unwrap();
        let mode = std::fs::metadata(token_path(dir.path()))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    /// Losing the mint race: when another process linked its token into
    /// place between our read and our rename, `mint` keeps that file
    /// byte-for-byte and returns its token. Overwriting it would invalidate
    /// the winner's saved connect URL.
    #[test]
    fn test_mint_never_clobbers_a_token_that_landed_first() {
        let dir = temp_dir();
        let path = token_path(dir.path());
        let winner = "0123456789abcdef".repeat(TOKEN_HEX_LEN / 16);
        std::fs::write(&path, &winner).unwrap();

        let loaded = mint(&path).unwrap();
        assert!(!loaded.minted, "the existing token is loaded, not minted");
        assert_eq!(loaded.token.as_str(), winner);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), winner);
        let names: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(names, [TOKEN_FILE], "the losing temporary file is removed");
    }

    /// Racing first runs converge on one token, and nobody reads a partial
    /// file along the way (that would be an `InvalidData` error).
    #[test]
    fn test_racing_first_runs_agree_on_one_token() {
        const RACERS: usize = 8;
        let dir = temp_dir();
        let barrier = std::sync::Barrier::new(RACERS);
        let results: Vec<LoadedToken> = std::thread::scope(|scope| {
            let racers: Vec<_> = (0..RACERS)
                .map(|_| {
                    scope.spawn(|| {
                        barrier.wait();
                        DaemonToken::load_or_create(dir.path()).unwrap()
                    })
                })
                .collect();
            racers
                .into_iter()
                .map(|racer| racer.join().unwrap())
                .collect()
        });
        let on_disk = DaemonToken::load(dir.path()).unwrap().unwrap();
        assert!(
            results
                .iter()
                .all(|loaded| loaded.token.as_str() == on_disk.as_str()),
            "every racer returns the token on disk"
        );
        assert_eq!(
            results.iter().filter(|loaded| loaded.minted).count(),
            1,
            "exactly one racer mints"
        );
    }

    #[cfg(unix)]
    #[test]
    fn test_loosened_permissions_are_restored_on_load() {
        use std::os::unix::fs::PermissionsExt;
        let dir = temp_dir();
        DaemonToken::load_or_create(dir.path()).unwrap();
        let path = token_path(dir.path());
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        DaemonToken::load_or_create(dir.path())
            .unwrap()
            .permissions
            .unwrap();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    /// `load()` is the non-loopback gate's only input and must never mint.
    #[test]
    fn test_load_never_creates_a_token_file() {
        let dir = temp_dir();
        for _ in 0..3 {
            assert!(!matches!(DaemonToken::load(dir.path()), Ok(Some(_))));
        }
        assert!(!token_path(dir.path()).exists());
    }

    /// A malformed token file is neither accepted as a credential nor
    /// silently replaced, and it does not satisfy the non-loopback gate.
    #[test]
    fn test_invalid_token_file_is_rejected_and_left_in_place() {
        for contents in ["", "   \n", "short", &"g".repeat(TOKEN_HEX_LEN)] {
            let dir = temp_dir();
            let path = token_path(dir.path());
            std::fs::write(&path, contents).unwrap();
            assert!(
                !matches!(DaemonToken::load(dir.path()), Ok(Some(_))),
                "{contents:?} is not a token"
            );
            let err = DaemonToken::load_or_create(dir.path()).unwrap_err();
            assert_eq!(err.kind(), io::ErrorKind::InvalidData, "{contents:?}");
            assert_eq!(std::fs::read_to_string(&path).unwrap(), contents);
        }
    }

    #[test]
    fn test_token_file_whitespace_is_tolerated() {
        let dir = temp_dir();
        let hex = "ab".repeat(TOKEN_HEX_LEN / 2);
        std::fs::write(token_path(dir.path()), format!("{hex}\n")).unwrap();
        let loaded = DaemonToken::load_or_create(dir.path()).unwrap();
        assert!(!loaded.minted);
        assert_eq!(loaded.token.as_str(), hex);
    }

    #[test]
    fn test_matches_rejects_wrong_length_without_panicking() {
        let dir = temp_dir();
        let token = DaemonToken::load_or_create(dir.path()).unwrap().token;
        assert!(!token.matches(""));
        assert!(!token.matches("wrong"));
        assert!(!token.matches(&format!("{}extra", token.as_str())));
    }

    #[test]
    fn test_debug_never_prints_the_token() {
        let dir = temp_dir();
        let token = DaemonToken::load_or_create(dir.path()).unwrap().token;
        assert!(!format!("{token:?}").contains(token.as_str()));
    }

    #[test]
    fn test_hex_encode() {
        assert_eq!(hex_encode(&[0x00, 0x0f, 0xa5, 0xff]), "000fa5ff");
    }

    #[test]
    fn test_allowed_host_parsing() {
        for ok in [
            "example.com",
            "Example.COM.",
            "example.com:8443",
            "100.64.0.7",
            "[::1]",
            "[fd7a::1]:8787",
        ] {
            assert!(ok.parse::<AllowedHost>().is_ok(), "{ok}");
        }
        for bad in ["", "::1", "user@example.com", "http://example.com", "a:b:c"] {
            assert!(bad.parse::<AllowedHost>().is_err(), "{bad}");
        }
    }

    #[test]
    fn test_missing_or_malformed_host_is_rejected() {
        let p = HostPolicy::default();
        assert_eq!(
            p.check(loopback(8787), None, None),
            Err(Rejection::MissingHost)
        );
        assert_eq!(
            p.check(loopback(8787), Some("::1"), None),
            Err(Rejection::MalformedHost)
        );
    }

    #[test]
    fn test_loopback_spellings_are_interchangeable_on_a_loopback_connection() {
        let p = HostPolicy::default();
        for host in [
            "127.0.0.1:8787",
            "localhost:8787",
            "LOCALHOST.:8787",
            "127.1.2.3:8787",
            "[::1]:8787",
            "[::ffff:127.0.0.1]:8787",
        ] {
            assert_eq!(p.check(loopback(8787), Some(host), None), Ok(()), "{host}");
        }
        let v6 = Some(SocketAddr::from((Ipv6Addr::LOCALHOST, 8787)));
        assert_eq!(p.check(v6, Some("127.0.0.1:8787"), None), Ok(()));
    }

    #[test]
    fn test_host_port_must_match_the_connection() {
        let p = HostPolicy::default();
        assert_eq!(
            p.check(loopback(8787), Some("127.0.0.1:9999"), None),
            Err(Rejection::HostNotAllowed)
        );
        // A portless Host means port 80, the daemon's scheme default.
        assert_eq!(p.check(loopback(80), Some("127.0.0.1"), None), Ok(()));
        assert_eq!(
            p.check(loopback(8787), Some("127.0.0.1"), None),
            Err(Rejection::HostNotAllowed)
        );
    }

    /// DNS rebinding: a page on evil.com whose name resolves to the daemon's
    /// address still sends `Host: evil.com`, which must be refused.
    #[test]
    fn test_unlisted_dns_names_are_rejected() {
        let p = HostPolicy::default();
        assert_eq!(
            p.check(loopback(8787), Some("evil.com:8787"), None),
            Err(Rejection::HostNotAllowed)
        );
        let lan = Some(SocketAddr::from(([192, 168, 1, 5], 8787)));
        assert_eq!(
            p.check(lan, Some("localhost:8787"), None),
            Err(Rejection::HostNotAllowed),
            "localhost is only an alias on a loopback connection"
        );
    }

    /// A wildcard bind accepts the concrete interface address each
    /// connection arrived on, which is what a LAN or Tailscale client sends.
    #[test]
    fn test_wildcard_bind_accepts_the_interface_address_the_client_used() {
        let p = HostPolicy::default();
        let lan = Some(SocketAddr::from(([192, 168, 1, 5], 8787)));
        assert_eq!(p.check(lan, Some("192.168.1.5:8787"), None), Ok(()));
        assert_eq!(
            p.check(
                lan,
                Some("192.168.1.5:8787"),
                Some("http://192.168.1.5:8787")
            ),
            Ok(())
        );
        assert_eq!(
            p.check(lan, Some("192.168.1.6:8787"), None),
            Err(Rejection::HostNotAllowed)
        );
        // Dual-stack `[::]` bind: IPv4 clients arrive on a mapped address.
        let mapped = Some(SocketAddr::from((
            Ipv4Addr::new(192, 168, 1, 5).to_ipv6_mapped(),
            8787,
        )));
        assert_eq!(p.check(mapped, Some("192.168.1.5:8787"), None), Ok(()));
    }

    #[test]
    fn test_origin_must_name_an_allowed_authority() {
        let p = HostPolicy::default();
        let ok = |origin| p.check(loopback(8787), Some("127.0.0.1:8787"), Some(origin));
        assert_eq!(ok("http://127.0.0.1:8787"), Ok(()));
        assert_eq!(ok("http://localhost:8787"), Ok(()));
        assert_eq!(ok("http://[::1]:8787"), Ok(()));
        for bad in [
            "https://attacker.example.com",
            "http://127.0.0.1:9999",
            "http://127.0.0.1",
            "null",
            "file://",
            "tauri://localhost",
        ] {
            assert_eq!(ok(bad), Err(Rejection::OriginNotAllowed), "{bad}");
        }
    }

    /// The documented reverse-proxy setup: TLS terminates at a proxy that
    /// forwards to the loopback daemon, either rewriting `Host` to the
    /// upstream address (nginx) or preserving the public name (Caddy).
    #[test]
    fn test_allow_host_admits_a_reverse_proxy_name() {
        let p = policy(&["swarm.example.com"]);
        let origin = Some("https://swarm.example.com");
        assert_eq!(
            p.check(loopback(8787), Some("127.0.0.1:8787"), origin),
            Ok(())
        );
        assert_eq!(
            p.check(loopback(8787), Some("swarm.example.com"), origin),
            Ok(())
        );
        assert_eq!(
            p.check(loopback(8787), Some("Swarm.Example.Com"), origin),
            Ok(())
        );
        assert_eq!(
            HostPolicy::default().check(loopback(8787), Some("127.0.0.1:8787"), origin),
            Err(Rejection::OriginNotAllowed)
        );

        let pinned = policy(&["box.tailnet.ts.net:8787"]);
        assert_eq!(
            pinned.check(None, Some("box.tailnet.ts.net:8787"), None),
            Ok(())
        );
        assert_eq!(
            pinned.check(None, Some("box.tailnet.ts.net:8788"), None),
            Err(Rejection::HostNotAllowed)
        );
    }
}
