//! Regression tests for the service install scripts in `service/`.
//!
//! On Linux, `install.sh` and `uninstall.sh` run for real against a
//! temporary `$HOME`, with `systemctl` (and, for the macOS branch, `uname`
//! and `launchctl`) replaced by shims on `PATH` that log their arguments.
//! The PowerShell scripts cannot run here, so their load-bearing lines are
//! checked statically.

use std::path::{Path, PathBuf};

/// The `service/` directory of this crate.
fn service_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("service")
}

fn read_script(name: &str) -> String {
    std::fs::read_to_string(service_dir().join(name)).unwrap()
}

/// The byte offset of `needle` in `text`, which must contain it exactly once.
fn position(text: &str, needle: &str) -> usize {
    assert_eq!(
        text.matches(needle).count(),
        1,
        "expected exactly one {needle:?}"
    );
    text.find(needle).unwrap()
}

// ── Windows (static) ────────────────────────────────────────────────────

/// Windows PowerShell 5.1 reads a BOM-less script in the ANSI code page, so
/// any non-ASCII byte turns into garbage (a stray quote can break parsing).
#[test]
fn test_powershell_scripts_are_ascii_only() {
    for name in ["install.ps1", "uninstall.ps1"] {
        let bytes = std::fs::read(service_dir().join(name)).unwrap();
        let offender = bytes.iter().position(|byte| !byte.is_ascii());
        assert_eq!(offender, None, "{name} has a non-ASCII byte");
    }
}

/// The Scheduled Task has no execution time limit. The default (72 hours)
/// would stop the daemon after three days, and a stopped task is not restarted.
/// install.ps1 also reads the setting back and fails if it did not stick.
#[test]
fn test_scheduled_task_has_no_execution_time_limit() {
    let install = read_script("install.ps1");
    position(&install, "-ExecutionTimeLimit ([TimeSpan]::Zero)");
    // The read-back guard throws from inside the if body, so a limit that
    // did not stick fails the install.
    position(
        &install,
        "if ($registered.ExecutionTimeLimit -ne 'PT0S') {
    throw \"The task's ExecutionTimeLimit is",
    );
    // Normal priority: the default (7) is below normal, and every worker
    // the daemon spawns inherits it.
    position(&install, "-Priority 5 -MultipleInstances IgnoreNew");
    // Never elevated: swarmd runs agents as the user.
    position(&install, "-LogonType Interactive -RunLevel Limited");
}

/// An upgrade stops the running daemon, then copies the new binary beside
/// the old one and moves it into place: Windows cannot overwrite a running
/// .exe, and a half-copied binary must never sit at the destination.
#[test]
fn test_windows_upgrade_stops_the_daemon_then_stages_the_binary() {
    let install = read_script("install.ps1");
    let defined = position(&install, "function Stop-InstalledDaemon");
    let stop = install[defined + 1..]
        .find("Stop-InstalledDaemon\n")
        .map(|offset| defined + 1 + offset)
        .expect("install.ps1 calls Stop-InstalledDaemon");
    let staged = position(&install, "$staged = \"$BinDest.new\"");
    let copy = position(
        &install,
        "Copy-Item -LiteralPath $src -Destination $staged -Force",
    );
    let swap = position(
        &install,
        "Move-Item -LiteralPath $staged -Destination $BinDest -Force",
    );
    assert!(
        stop < staged && staged < copy && copy < swap,
        "stop ({stop}), stage ({staged}), copy ({copy}), then move ({swap})"
    );
    // The daemon started from the installed path is what gets stopped.
    position(&install, "Where-Object { $_.Path -eq $BinDest }");

    let uninstall = read_script("uninstall.ps1");
    let unregister = position(&uninstall, "Unregister-ScheduledTask");
    let kill = position(&uninstall, "$_ | Stop-Process -Force");
    let remove = position(&uninstall, "Remove-Item -LiteralPath $BinDest -Force");
    assert!(
        unregister < kill && kill < remove,
        "uninstall.ps1 stops the running daemon before deleting its binary"
    );
}

// ── Service units (static) ──────────────────────────────────────────────

/// launchd's default `ExitTimeOut` (20 s) is shorter than swarmd's graceful
/// shutdown can take; the plist matches the systemd unit's TimeoutStopSec.
#[test]
fn test_service_units_wait_for_a_graceful_shutdown() {
    let plist = read_script("dev.crimson.swarmd.plist");
    position(&plist, "<key>ExitTimeOut</key>\n    <integer>60</integer>");
    let unit = read_script("swarmd.service");
    position(&unit, "\nTimeoutStopSec=60\n");
}

// ── Linux and macOS (executed) ──────────────────────────────────────────

#[cfg(target_os = "linux")]
mod executed {
    use std::os::unix::fs::PermissionsExt;
    use std::path::{Path, PathBuf};
    use std::process::Command;

    use super::service_dir;

    /// A directory name with every character the scripts must escape: a
    /// space, `%` (a systemd specifier), `&`, `<`, `>` (XML) and `|` (the
    /// installer's sed delimiter).
    const AWKWARD: &str = "odd 100% & <dir> |x|";

    /// A temporary `$HOME` and a shim directory that goes first on `PATH`.
    struct Sandbox {
        root: tempfile::TempDir,
        shims: PathBuf,
        /// Where `SWARMD_BIN_DEST` points.
        dest: PathBuf,
        /// What `SWARMD_BIN` points at.
        source: PathBuf,
        /// Every shimmed command invocation, one line each.
        log: PathBuf,
    }

    impl Sandbox {
        /// `os` is what the `uname -s` shim prints, or `None` for the real
        /// `uname`.
        fn new(os: Option<&str>) -> Self {
            let root = tempfile::tempdir().unwrap();
            let shims = root.path().join(AWKWARD).join("shims");
            std::fs::create_dir_all(&shims).unwrap();
            let log = root.path().join("calls.log");
            for command in ["systemctl", "launchctl"] {
                shim(
                    &shims,
                    command,
                    &format!("printf '{command} %s\\n' \"$*\" >> \"$SHIM_LOG\""),
                );
            }
            if let Some(os) = os {
                shim(
                    &shims,
                    "uname",
                    &format!("case \"$1\" in -m) echo arm64 ;; *) echo {os} ;; esac"),
                );
            }
            let source = root.path().join("swarmd-build");
            let dest = root.path().join(AWKWARD).join("bin").join("swarmd");
            let home = root.path().join("home");
            std::fs::create_dir(&home).unwrap();
            Self {
                root,
                shims,
                dest,
                source,
                log,
            }
        }

        fn home(&self) -> PathBuf {
            self.root.path().join("home")
        }

        fn config(&self) -> PathBuf {
            self.root.path().join("config")
        }

        fn path_var(&self) -> String {
            format!("{}:/usr/local/bin:/usr/bin:/bin", self.shims.display())
        }

        /// `sh <script> <args>` under the sandbox's isolated environment, not yet run.
        fn command(&self, script: &str, args: &[&str]) -> Command {
            let mut command = Command::new("sh");
            command
                .arg(service_dir().join(script))
                .args(args)
                .env_clear()
                .env("HOME", self.home())
                .env("XDG_CONFIG_HOME", self.config())
                .env("PATH", self.path_var())
                .env("USER", "tester")
                .env("SWARMD_BIN", &self.source)
                .env("SWARMD_BIN_DEST", &self.dest)
                .env("SHIM_LOG", &self.log);
            command
        }

        /// Runs `script` with `args` and asserts it succeeds.
        fn run(&self, script: &str, args: &[&str]) -> String {
            let output = self.command(script, args).output().unwrap();
            let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
            assert!(
                output.status.success(),
                "{script} {args:?} failed: {stdout}{}",
                String::from_utf8_lossy(&output.stderr)
            );
            stdout
        }

        fn calls(&self) -> Vec<String> {
            std::fs::read_to_string(&self.log)
                .unwrap_or_default()
                .lines()
                .map(str::to_owned)
                .collect()
        }
    }

    fn shim(dir: &Path, name: &str, body: &str) {
        let path = dir.join(name);
        std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    fn mode(path: &Path) -> u32 {
        std::fs::metadata(path).unwrap().permissions().mode() & 0o777
    }

    fn count(calls: &[String], call: &str) -> usize {
        calls.iter().filter(|line| *line == call).count()
    }

    /// install.sh installs to `$SWARMD_BIN_DEST`, points the unit at that
    /// binary and passes the installing shell's PATH (agent CLIs are not
    /// found without it), both escaped for systemd, and restarts the service
    /// on every run so an upgrade takes effect (`enable --now` would leave a
    /// running daemon on the old binary).
    /// uninstall.sh --purge-binary then removes all of it.
    #[test]
    fn test_systemd_install_upgrade_and_uninstall() {
        let sandbox = Sandbox::new(None);
        std::fs::write(&sandbox.source, "v1").unwrap();
        sandbox.run("install.sh", &[]);
        std::fs::write(&sandbox.source, "v2").unwrap();
        sandbox.run("install.sh", &[]);

        assert_eq!(std::fs::read_to_string(&sandbox.dest).unwrap(), "v2");
        assert_eq!(mode(&sandbox.dest), 0o755);
        let staged = std::fs::read_dir(sandbox.dest.parent().unwrap())
            .unwrap()
            .count();
        assert_eq!(staged, 1, "no staged copy is left behind");

        let unit_dir = sandbox.config().join("systemd/user");
        let unit = unit_dir.join("swarmd.service");
        assert_eq!(mode(&unit), 0o644);
        let dropin =
            std::fs::read_to_string(unit_dir.join("swarmd.service.d/install.conf")).unwrap();
        let systemd = |value: &str| value.replace('%', "%%");
        let expected = format!(
            "[Service]\nExecStart=\nExecStart=\"{}\"\nEnvironment=\"PATH={}\"\n",
            systemd(sandbox.dest.to_str().unwrap()),
            systemd(&sandbox.path_var()),
        );
        assert!(dropin.ends_with(&expected), "{dropin}");
        assert!(dropin.contains("odd 100%% & <dir>"), "{dropin}");

        let calls = sandbox.calls();
        for call in [
            "systemctl --user daemon-reload",
            "systemctl --user enable swarmd.service",
            "systemctl --user restart swarmd.service",
        ] {
            assert_eq!(count(&calls, call), 2, "{call}: {calls:?}");
        }
        assert!(
            !calls.iter().any(|call| call.contains("--now")),
            "{calls:?}"
        );

        let stdout = sandbox.run("uninstall.sh", &["--purge-binary"]);
        assert!(stdout.contains("Removed binary"), "{stdout}");
        assert!(!unit.exists());
        assert!(!unit_dir.join("swarmd.service.d").exists());
        assert!(!sandbox.dest.exists());
        assert_eq!(
            sandbox.calls().last().map(String::as_str),
            Some("systemctl --user daemon-reload")
        );
        assert!(
            sandbox
                .calls()
                .contains(&"systemctl --user disable --now swarmd.service".to_owned())
        );
    }

    /// Without --purge-binary, uninstall.sh keeps the binary.
    #[test]
    fn test_uninstall_keeps_the_binary_by_default() {
        let sandbox = Sandbox::new(None);
        std::fs::write(&sandbox.source, "v1").unwrap();
        sandbox.run("install.sh", &[]);
        sandbox.run("uninstall.sh", &[]);
        assert!(sandbox.dest.exists());
    }

    /// uninstall.sh stops when systemctl cannot stop the daemon for any
    /// reason other than a missing unit, and removes nothing, so a unit and
    /// binary are never deleted under a daemon that keeps running. A unit
    /// that does not exist is the benign case: the removal proceeds.
    #[test]
    fn test_uninstall_stops_when_systemctl_cannot_stop_the_daemon() {
        let sandbox = Sandbox::new(None);
        std::fs::write(&sandbox.source, "v1").unwrap();
        sandbox.run("install.sh", &[]);
        let unit = sandbox.config().join("systemd/user/swarmd.service");

        shim(
            &sandbox.shims,
            "systemctl",
            "echo 'Failed to connect to user scope bus' >&2; exit 1",
        );
        let output = sandbox
            .command("uninstall.sh", &["--purge-binary"])
            .output()
            .unwrap();
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(!output.status.success(), "{stderr}");
        assert!(stderr.contains("nothing was removed"), "{stderr}");
        assert!(unit.exists());
        assert!(sandbox.dest.exists());

        shim(
            &sandbox.shims,
            "systemctl",
            "echo 'Failed to disable unit: Unit swarmd.service does not exist' >&2; exit 1",
        );
        sandbox.run("uninstall.sh", &["--purge-binary"]);
        assert!(!unit.exists());
        assert!(!sandbox.dest.exists());
    }

    /// The macOS branch writes a plist with the installed binary, the log
    /// directory and the installing shell's PATH filled in and XML-escaped
    /// (launchd's own PATH lacks every agent CLI), then reloads the agent
    /// so an upgrade takes effect.
    #[test]
    fn test_launchd_install_fills_in_and_escapes_the_plist() {
        let sandbox = Sandbox::new(Some("Darwin"));
        std::fs::write(&sandbox.source, "v1").unwrap();
        sandbox.run("install.sh", &[]);

        let agents = sandbox.home().join("Library/LaunchAgents");
        let plist_path = agents.join("dev.crimson.swarmd.plist");
        let plist = std::fs::read_to_string(&plist_path).unwrap();
        let xml = |value: &str| {
            value
                .replace('&', "&amp;")
                .replace('<', "&lt;")
                .replace('>', "&gt;")
        };
        let log_dir = sandbox.home().join("Library/Logs/swarmd");
        for expected in [
            format!(
                "<array>\n        <string>{}</string>\n    </array>",
                xml(sandbox.dest.to_str().unwrap())
            ),
            format!(
                "<key>PATH</key>\n        <string>{}</string>",
                xml(&sandbox.path_var())
            ),
            format!("<string>{}/swarmd.log</string>", log_dir.display()),
        ] {
            assert!(plist.contains(&expected), "missing {expected}\n{plist}");
        }
        assert!(plist.contains("odd 100% &amp; &lt;dir&gt; |x|"), "{plist}");
        assert!(!plist.contains('@'), "an unfilled placeholder: {plist}");
        assert_eq!(mode(&log_dir), 0o700);
        assert_eq!(std::fs::read_to_string(&sandbox.dest).unwrap(), "v1");

        let uid = String::from_utf8(Command::new("id").arg("-u").output().unwrap().stdout).unwrap();
        let domain = format!("gui/{}", uid.trim());
        assert_eq!(
            sandbox.calls(),
            [
                format!("launchctl bootout {domain}/dev.crimson.swarmd"),
                format!("launchctl bootstrap {domain} {}", plist_path.display()),
            ]
        );

        sandbox.run("uninstall.sh", &[]);
        assert!(!plist_path.exists());
    }
}
