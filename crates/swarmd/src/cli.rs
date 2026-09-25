//! The `swarmd` command line: argument parsing, the default data
//! directory, and the connect URL. Lives in the library so it is unit
//! tested without spawning a process.

use std::ffi::{OsStr, OsString};
use std::io;
use std::net::{Ipv4Addr, Ipv6Addr, SocketAddr, SocketAddrV4};
use std::path::PathBuf;

use crate::auth::{AllowedHost, DaemonToken};

/// `--bind`'s default: loopback only.
pub const DEFAULT_BIND: SocketAddr = SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 8787));

/// The desktop app's bundle identifier (`tauri.conf.json`), which names
/// its data directory. `swarmd` must resolve the same directory: the
/// single-instance lock only stops two engines sharing ONE directory, so
/// resolving a different one would silently split the event log.
pub const IDENTIFIER: &str = "dev.crimson.swarm-orchestrator";

/// `swarmd --help`.
pub const USAGE: &str = "\
Usage: swarmd [OPTIONS]
       swarmd connect-url [--bind ADDR] [--data-dir PATH]

Runs the headless SWARM Orchestrator daemon: the desktop app's runtime,
served over an authenticated WebSocket.

Options:
  --bind ADDR               Listen Address [Default: 127.0.0.1:8787]. A
                            Non-Loopback Address Needs A Token Minted By An
                            Earlier Loopback Run.
  --data-dir PATH           Data Directory [Default: The Desktop App's]
  --serve-ui DIR            Serve The `pnpm build:web` Bundle In DIR At /
  --allow-host NAME[:PORT]  Also Accept This Host In Host/Origin Headers
                            (Reverse Proxy, MagicDNS Name). Repeatable.
  --log-file PATH           Append Logs To PATH Instead Of Stderr
  -h, --help                Print This Help
  -V, --version             Print The Version

Commands:
  connect-url               Print The Connect URL (It Carries The Token)
";

/// What the command line asks for.
#[derive(Debug)]
pub enum Command {
    /// Run the daemon.
    Serve(ServeArgs),
    /// Print the tokenized connect URL and exit.
    ConnectUrl(ConnectUrlArgs),
    Help,
    Version,
}

/// Options of the daemon itself.
#[derive(Debug)]
pub struct ServeArgs {
    pub bind: SocketAddr,
    pub data_dir: Option<PathBuf>,
    pub serve_ui: Option<PathBuf>,
    pub allow_hosts: Vec<AllowedHost>,
    pub log_file: Option<PathBuf>,
}

impl Default for ServeArgs {
    fn default() -> Self {
        Self {
            bind: DEFAULT_BIND,
            data_dir: None,
            serve_ui: None,
            allow_hosts: Vec::new(),
            log_file: None,
        }
    }
}

/// Options of `swarmd connect-url`.
#[derive(Debug)]
pub struct ConnectUrlArgs {
    pub bind: SocketAddr,
    pub data_dir: Option<PathBuf>,
}

/// A command line that cannot be parsed. `Display` is the message printed
/// before exiting with status 2.
#[derive(Debug, PartialEq, Eq, thiserror::Error)]
pub enum CliError {
    #[error("Unrecognized Argument: \"{0}\".")]
    Unrecognized(String),
    #[error("{0} Requires A Value.")]
    MissingValue(&'static str),
    #[error("Invalid {flag} Value \"{value}\": {reason}")]
    Invalid {
        flag: &'static str,
        value: String,
        reason: String,
    },
}

/// Parses the arguments after the program name. Flags take their value as
/// the next argument or inline (`--bind=ADDR`); path values may be any OS
/// string in the separate-argument form.
///
/// # Errors
///
/// An unknown argument, a flag without its value, or a value that does not
/// parse.
pub fn parse(args: impl IntoIterator<Item = OsString>) -> Result<Command, CliError> {
    let mut args = args.into_iter().peekable();
    let connect_url = args.next_if(|arg| arg == "connect-url").is_some();
    let mut serve = ServeArgs::default();

    while let Some(arg) = args.next() {
        let (flag, inline) = split_flag(&arg)?;
        let mut value = |flag: &'static str| {
            inline
                .clone()
                .or_else(|| args.next())
                .filter(|value| !value.is_empty())
                .ok_or(CliError::MissingValue(flag))
        };
        match (flag, connect_url) {
            ("-h" | "--help", _) => return Ok(Command::Help),
            ("-V" | "--version", false) => return Ok(Command::Version),
            ("--bind", _) => serve.bind = parse_value("--bind", &value("--bind")?)?,
            ("--data-dir", _) => serve.data_dir = Some(value("--data-dir")?.into()),
            ("--serve-ui", false) => serve.serve_ui = Some(value("--serve-ui")?.into()),
            ("--allow-host", false) => serve
                .allow_hosts
                .push(parse_value("--allow-host", &value("--allow-host")?)?),
            ("--log-file", false) => serve.log_file = Some(value("--log-file")?.into()),
            _ => return Err(CliError::Unrecognized(arg.to_string_lossy().into_owned())),
        }
    }

    Ok(if connect_url {
        Command::ConnectUrl(ConnectUrlArgs {
            bind: serve.bind,
            data_dir: serve.data_dir,
        })
    } else {
        Command::Serve(serve)
    })
}

/// Splits `--flag=value` into its flag and inline value. An argument that
/// is not UTF-8 cannot be a flag.
fn split_flag(arg: &OsStr) -> Result<(&str, Option<OsString>), CliError> {
    let text = arg
        .to_str()
        .ok_or_else(|| CliError::Unrecognized(arg.to_string_lossy().into_owned()))?;
    Ok(match text.split_once('=') {
        Some((flag, value)) if flag.starts_with("--") => (flag, Some(value.into())),
        _ => (text, None),
    })
}

fn parse_value<T>(flag: &'static str, value: &OsStr) -> Result<T, CliError>
where
    T: std::str::FromStr,
    T::Err: std::fmt::Display,
{
    let invalid = |reason: String| CliError::Invalid {
        flag,
        value: value.to_string_lossy().into_owned(),
        reason,
    };
    value
        .to_str()
        .ok_or_else(|| invalid("Not Valid UTF-8".to_owned()))?
        .parse()
        .map_err(|error: T::Err| invalid(error.to_string()))
}

/// The platforms whose data-directory conventions differ.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Platform {
    Windows,
    MacOs,
    /// Linux and the other Unixes (XDG).
    Xdg,
}

impl Platform {
    /// The platform this binary was built for.
    pub const CURRENT: Self = if cfg!(windows) {
        Self::Windows
    } else if cfg!(target_os = "macos") {
        Self::MacOs
    } else {
        Self::Xdg
    };
}

/// The desktop app's data directory, which `swarmd` shares (see
/// [`IDENTIFIER`]): `%APPDATA%\<id>` on Windows, `~/Library/Application
/// Support/<id>` on macOS, `$XDG_DATA_HOME/<id>` or `~/.local/share/<id>`
/// elsewhere.
///
/// # Errors
///
/// The base directory cannot be resolved.
pub fn default_data_dir() -> io::Result<PathBuf> {
    data_dir_for(
        Platform::CURRENT,
        |key| std::env::var_os(key),
        std::env::home_dir,
    )
}

/// [`default_data_dir`] with its inputs injected. Like the `dirs` crate
/// Tauri resolves the desktop directory with, an environment variable that
/// is empty or not absolute is ignored.
pub fn data_dir_for(
    platform: Platform,
    var: impl Fn(&str) -> Option<OsString>,
    home_dir: impl FnOnce() -> Option<PathBuf>,
) -> io::Result<PathBuf> {
    let absolute_var = |key: &str| {
        var(key)
            .map(PathBuf::from)
            .filter(|path| path.is_absolute())
    };
    let home = || {
        home_dir()
            .filter(|home| home.is_absolute())
            .ok_or_else(|| io::Error::other("Could Not Resolve The Home Directory"))
    };
    let base = match platform {
        Platform::Windows => absolute_var("APPDATA")
            .ok_or_else(|| io::Error::other("%APPDATA% Is Not Set To An Absolute Path"))?,
        Platform::MacOs => home()?.join("Library").join("Application Support"),
        Platform::Xdg => match absolute_var("XDG_DATA_HOME") {
            Some(data_home) => data_home,
            None => home()?.join(".local").join("share"),
        },
    };
    Ok(base.join(IDENTIFIER))
}

/// `http://ADDR/` for a listen address, with a wildcard address replaced by
/// the loopback address of the same family (what a browser on this machine
/// can open).
pub fn base_url(bind: SocketAddr) -> String {
    let ip = match bind {
        SocketAddr::V4(v4) if v4.ip().is_unspecified() => Ipv4Addr::LOCALHOST.into(),
        SocketAddr::V6(v6) if v6.ip().is_unspecified() => Ipv6Addr::LOCALHOST.into(),
        _ => bind.ip(),
    };
    format!("http://{}/", SocketAddr::new(ip, bind.port()))
}

/// The connect URL: [`base_url`] plus the token in the fragment, which the
/// browser never sends to any server.
pub fn connect_url(bind: SocketAddr, token: &DaemonToken) -> String {
    format!("{}#t={}", base_url(bind), token.as_str())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse_strs(args: &[&str]) -> Result<Command, CliError> {
        parse(args.iter().map(OsString::from))
    }

    fn serve(args: &[&str]) -> ServeArgs {
        match parse_strs(args).unwrap() {
            Command::Serve(serve) => serve,
            other => panic!("expected Serve, got {other:?}"),
        }
    }

    #[test]
    fn test_defaults() {
        let args = serve(&[]);
        assert_eq!(args.bind, DEFAULT_BIND);
        assert!(args.data_dir.is_none() && args.serve_ui.is_none() && args.log_file.is_none());
        assert!(args.allow_hosts.is_empty());
    }

    #[test]
    fn test_flags_take_separate_or_inline_values() {
        let args = serve(&[
            "--bind",
            "0.0.0.0:9000",
            "--data-dir=/data",
            "--serve-ui",
            "dist-web",
            "--allow-host",
            "swarm.example.com",
            "--allow-host=box.ts.net:8787",
            "--log-file",
            "/var/log/swarmd.log",
        ]);
        assert_eq!(args.bind, "0.0.0.0:9000".parse().unwrap());
        assert_eq!(args.data_dir, Some(PathBuf::from("/data")));
        assert_eq!(args.serve_ui, Some(PathBuf::from("dist-web")));
        assert_eq!(args.allow_hosts.len(), 2);
        assert_eq!(args.log_file, Some(PathBuf::from("/var/log/swarmd.log")));
    }

    #[test]
    fn test_missing_values_are_errors_not_defaults() {
        for flag in [
            "--bind",
            "--data-dir",
            "--serve-ui",
            "--allow-host",
            "--log-file",
        ] {
            assert!(
                matches!(parse_strs(&[flag]), Err(CliError::MissingValue(f)) if f == flag),
                "{flag}"
            );
        }
        assert_eq!(
            parse_strs(&["--data-dir="]).unwrap_err(),
            CliError::MissingValue("--data-dir")
        );
    }

    #[test]
    fn test_invalid_and_unknown_arguments() {
        assert!(matches!(
            parse_strs(&["--bind", "localhost"]),
            Err(CliError::Invalid { flag: "--bind", .. })
        ));
        assert!(matches!(
            parse_strs(&["--allow-host", "http://x"]),
            Err(CliError::Invalid {
                flag: "--allow-host",
                ..
            })
        ));
        assert_eq!(
            parse_strs(&["--nope"]).unwrap_err(),
            CliError::Unrecognized("--nope".to_owned())
        );
        assert_eq!(
            parse_strs(&["serve"]).unwrap_err(),
            CliError::Unrecognized("serve".to_owned())
        );
    }

    #[test]
    fn test_help_and_version() {
        assert!(matches!(parse_strs(&["--help"]), Ok(Command::Help)));
        assert!(parse_strs(&["--bind", "x", "-h"]).is_err());
        assert!(matches!(
            parse_strs(&["-h", "--bind", "x"]),
            Ok(Command::Help)
        ));
        assert!(matches!(parse_strs(&["-V"]), Ok(Command::Version)));
        assert!(matches!(
            parse_strs(&["connect-url", "--help"]),
            Ok(Command::Help)
        ));
    }

    #[test]
    fn test_connect_url_accepts_only_its_own_flags() {
        match parse_strs(&["connect-url", "--bind", "127.0.0.1:9", "--data-dir", "/d"]).unwrap() {
            Command::ConnectUrl(args) => {
                assert_eq!(args.bind, "127.0.0.1:9".parse().unwrap());
                assert_eq!(args.data_dir, Some(PathBuf::from("/d")));
            }
            other => panic!("expected ConnectUrl, got {other:?}"),
        }
        assert!(parse_strs(&["connect-url", "--serve-ui", "x"]).is_err());
        assert!(parse_strs(&["--bind", "127.0.0.1:9", "connect-url"]).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn test_non_utf8_paths_are_accepted() {
        use std::os::unix::ffi::OsStringExt;
        let raw = OsString::from_vec(b"/data/\xff".to_vec());
        let parsed = parse([OsString::from("--data-dir"), raw.clone()]).unwrap();
        assert!(
            matches!(parsed, Command::Serve(ServeArgs { data_dir: Some(dir), .. }) if dir == raw)
        );
    }

    fn vars(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<OsString> {
        let pairs: Vec<(String, OsString)> = pairs
            .iter()
            .map(|(key, value)| ((*key).to_owned(), OsString::from(value)))
            .collect();
        move |key| {
            pairs
                .iter()
                .find(|(name, _)| name == key)
                .map(|(_, value)| value.clone())
        }
    }

    fn home() -> Option<PathBuf> {
        Some(std::env::temp_dir().join("home"))
    }

    #[test]
    fn test_xdg_data_home_is_used_only_when_absolute() {
        let absolute = std::env::temp_dir().join("xdg");
        let absolute_str = absolute.to_str().unwrap();
        assert_eq!(
            data_dir_for(
                Platform::Xdg,
                vars(&[("XDG_DATA_HOME", absolute_str)]),
                home
            )
            .unwrap(),
            absolute.join(IDENTIFIER)
        );
        let fallback = home()
            .unwrap()
            .join(".local")
            .join("share")
            .join(IDENTIFIER);
        for ignored in ["", "relative/dir"] {
            assert_eq!(
                data_dir_for(Platform::Xdg, vars(&[("XDG_DATA_HOME", ignored)]), home).unwrap(),
                fallback,
                "{ignored:?}"
            );
        }
        assert!(data_dir_for(Platform::Xdg, vars(&[]), || None).is_err());
    }

    #[test]
    fn test_windows_and_macos_data_dirs() {
        let appdata = std::env::temp_dir().join("Roaming");
        assert_eq!(
            data_dir_for(
                Platform::Windows,
                vars(&[("APPDATA", appdata.to_str().unwrap())]),
                home
            )
            .unwrap(),
            appdata.join(IDENTIFIER)
        );
        assert!(data_dir_for(Platform::Windows, vars(&[("APPDATA", "")]), home).is_err());
        assert_eq!(
            data_dir_for(Platform::MacOs, vars(&[]), home).unwrap(),
            home()
                .unwrap()
                .join("Library")
                .join("Application Support")
                .join(IDENTIFIER)
        );
    }

    #[test]
    fn test_base_url_replaces_wildcards_with_loopback() {
        assert_eq!(
            base_url("0.0.0.0:8787".parse().unwrap()),
            "http://127.0.0.1:8787/"
        );
        assert_eq!(base_url("[::]:8787".parse().unwrap()), "http://[::1]:8787/");
        assert_eq!(
            base_url("192.168.1.5:80".parse().unwrap()),
            "http://192.168.1.5:80/"
        );
    }
}
