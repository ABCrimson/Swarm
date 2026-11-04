//! Each Codex worker's private `CODEX_HOME`.
//!
//! Codex loads its configuration, MCP servers, plugins and login from
//! `CODEX_HOME` (default `~/.codex`). A worker that inherits the
//! operator's home can call every MCP server that home exposes, including
//! servers that Codex plugins add and that are not keys of `mcp_servers`. A `-c
//! 'mcp_servers={}'` override merges an empty table into the loaded one and
//! removes nothing. So every worker runs with its own home under
//! `<data dir>/codex-home/<worker id>`, holding a Swarm-written
//! `config.toml` (no `[mcp_servers]`, no plugins, and Codex's built-in
//! apps, remote plugins, computer use, browser use and skill
//! MCP-dependency installs turned off; see [`SWARM_CONFIG`]) and, when the
//! operator is signed in through a file, a copy of the operator's
//! `auth.json`.
//!
//! Two limits were measured on codex-cli 0.168.0-alpha.1 (2026-11-04).
//! User skills under `~/.agents/skills` are outside `CODEX_HOME` and still
//! load: with a fresh home, `skills/list` returned the operator's user
//! skills. And the empty `mcpServerStatus/list` of a private home was
//! measured without an `auth.json` in it.
//!
//! The home outlives the session: Codex keeps the worker's threads there,
//! and `thread/resume` finds them only in the home that started them.
//! [`PrivateHomes::remove`] deletes it, the `auth.json` copy included, once
//! the worker is gone.

use std::fs;
use std::io::{self, ErrorKind};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use uuid::Uuid;

/// The variable Codex reads its home directory from.
pub(super) const CODEX_HOME_ENV: &str = "CODEX_HOME";

/// The directory under the data directory that holds every worker's home.
pub(crate) const HOMES_DIR: &str = "codex-home";
/// Codex's configuration file in a home.
const CONFIG_FILE: &str = "config.toml";
/// Codex's file-based login in a home.
const AUTH_FILE: &str = "auth.json";
/// Where a fresh `auth.json` copy is written before it replaces the old one.
const AUTH_STAGING_FILE: &str = "auth.json.swarm-staging";

/// The whole `config.toml` of a private home, rewritten at every spawn.
/// It has no `[mcp_servers]` table and no plugins, and its `[features]`
/// table turns off five features codex-cli 0.168.0-alpha.1 enables by
/// default that hand a worker tools beyond its sandbox: `apps` (the
/// built-in `codex_apps` connectors), `remote_plugin`, `computer_use`
/// (`cua_repl`), `browser_use` and `skill_mcp_dependency_install`. With
/// `CODEX_HOME` at an empty directory, `codex features list` reads all
/// five `true`; at a home holding only this file it reads all five
/// `false` (measured 2026-11-04). Every other key keeps Codex's default.
const SWARM_CONFIG: &str = "\
# Written by Swarm Orchestrator at every spawn of this Codex worker; edits are overwritten.
# No MCP server table and no plugins, and the features below off, so this worker gets
# none of the operator's MCP servers and none of Codex's built-in app, remote-plugin,
# computer-use or browser tools (docs/adr/0038-agent-provider-trust-model.md).
[features]
apps = false
remote_plugin = false
computer_use = false
browser_use = false
skill_mcp_dependency_install = false
";

/// Where the private homes live and where their `auth.json` comes from.
#[derive(Debug, Clone)]
pub(super) struct PrivateHomes {
    /// `<data dir>/codex-home`.
    root: PathBuf,
    /// The operator's Codex home, the source of `auth.json`; `None` copies
    /// no login.
    operator: Option<PathBuf>,
}

impl PrivateHomes {
    pub(super) fn new(data_dir: &Path, operator: Option<PathBuf>) -> Self {
        Self {
            root: data_dir.join(HOMES_DIR),
            operator,
        }
    }

    /// The same homes with no operator login to copy.
    #[cfg(test)]
    pub(super) fn without_login(self) -> Self {
        Self {
            operator: None,
            ..self
        }
    }

    /// The operator's Codex home as Codex itself resolves it: a non-empty
    /// `CODEX_HOME`, else `~/.codex`.
    pub(super) fn operator_home() -> Option<PathBuf> {
        std::env::var_os(CODEX_HOME_ENV)
            .filter(|home| !home.is_empty())
            .map(PathBuf::from)
            .or_else(|| {
                crate::paths::home_dir()
                    .ok()
                    .map(|home| home.join(".codex"))
            })
    }

    /// Creates (or reuses) `worker_id`'s home, rewrites its `config.toml`
    /// and brings its `auth.json` in line with the operator's: copied when
    /// missing or older than the source, kept when newer (Codex refreshed
    /// the token inside the private home), removed when the operator has
    /// none. Everything Codex wrote there itself is left alone. Blocking
    /// file I/O: call it off the async worker threads.
    pub(super) fn prepare(&self, worker_id: Uuid) -> io::Result<PathBuf> {
        let home = self.home(worker_id);
        let mut dir = fs::DirBuilder::new();
        dir.recursive(true);
        #[cfg(unix)]
        std::os::unix::fs::DirBuilderExt::mode(&mut dir, 0o700);
        dir.create(&home)?;
        fs::write(home.join(CONFIG_FILE), SWARM_CONFIG)?;
        self.sync_auth(&home)?;
        Ok(home)
    }

    /// Deletes `worker_id`'s home with everything in it, the `auth.json`
    /// copy and Codex's threads included; a home that does not exist counts
    /// as removed. Call it once the worker's session has ended (a running
    /// child holds files there) and off the async worker threads: it is
    /// blocking file I/O.
    pub(crate) fn remove(&self, worker_id: Uuid) -> io::Result<()> {
        match fs::remove_dir_all(self.home(worker_id)) {
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
            result => result,
        }
    }

    fn home(&self, worker_id: Uuid) -> PathBuf {
        self.root.join(worker_id.to_string())
    }

    fn sync_auth(&self, home: &Path) -> io::Result<()> {
        let copy = home.join(AUTH_FILE);
        let source = self.operator.as_deref().map(|dir| dir.join(AUTH_FILE));
        let source_modified = match &source {
            Some(source) => modified(source)?,
            None => None,
        };
        let (Some(source), Some(source_modified)) = (source, source_modified) else {
            return match fs::remove_file(&copy) {
                Err(error) if error.kind() != ErrorKind::NotFound => Err(error),
                _ => Ok(()),
            };
        };
        if modified(&copy)?.is_some_and(|at| at >= source_modified) {
            return Ok(());
        }
        // Copy beside the target, then rename over it, so Codex never
        // reads a half-written login. The copy keeps the source's
        // permission bits.
        let staging = home.join(AUTH_STAGING_FILE);
        fs::copy(&source, &staging)?;
        fs::rename(&staging, &copy)
    }
}

/// `path`'s modification time, or `None` when it does not exist.
fn modified(path: &Path) -> io::Result<Option<SystemTime>> {
    match fs::metadata(path) {
        Ok(meta) => meta.modified().map(Some),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}
