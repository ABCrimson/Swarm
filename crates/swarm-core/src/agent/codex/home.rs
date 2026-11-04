//! Each Codex worker's private `CODEX_HOME`.
//!
//! Codex loads its configuration, MCP servers, plugins, skills and login
//! from `CODEX_HOME` (default `~/.codex`). A worker that inherits the
//! operator's home can call every MCP server that home exposes, including
//! servers that Codex plugins add and that are not keys of `mcp_servers`. A `-c
//! 'mcp_servers={}'` override merges an empty table into the loaded one and
//! removes nothing. So every worker runs with its own home under
//! `<data dir>/codex-home/<worker id>`, holding a Swarm-written
//! `config.toml` that sets nothing and, when the operator is signed in
//! through a file, a copy of the operator's `auth.json`.
//!
//! The home outlives the session: Codex keeps the worker's threads there,
//! and `thread/resume` finds them only in the home that started them.

use std::fs;
use std::io::{self, ErrorKind};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use uuid::Uuid;

/// The variable Codex reads its home directory from.
pub(super) const CODEX_HOME_ENV: &str = "CODEX_HOME";

/// The directory under the data directory that holds every worker's home.
const HOMES_DIR: &str = "codex-home";
/// Codex's configuration file in a home.
const CONFIG_FILE: &str = "config.toml";
/// Codex's file-based login in a home.
const AUTH_FILE: &str = "auth.json";
/// Where a fresh `auth.json` copy is written before it replaces the old one.
const AUTH_STAGING_FILE: &str = "auth.json.swarm-staging";

/// The whole `config.toml` of a private home, rewritten at every spawn.
/// It sets no key: no `[mcp_servers]` table and no plugins, so the worker
/// loads none of the operator's servers, and Codex's defaults apply.
const SWARM_CONFIG: &str = "\
# Written by Swarm Orchestrator at every spawn of this Codex worker; edits are overwritten.
# It sets nothing on purpose: no [mcp_servers] table and no plugins, so this worker
# loads none of the operator's MCP servers (docs/adr/0038-agent-provider-trust-model.md).
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
        let home = self.root.join(worker_id.to_string());
        let mut dir = fs::DirBuilder::new();
        dir.recursive(true);
        #[cfg(unix)]
        std::os::unix::fs::DirBuilderExt::mode(&mut dir, 0o700);
        dir.create(&home)?;
        fs::write(home.join(CONFIG_FILE), SWARM_CONFIG)?;
        self.sync_auth(&home)?;
        Ok(home)
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
