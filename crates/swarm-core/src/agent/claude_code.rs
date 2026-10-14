//! `ClaudeCodeAdapter`: the [`AgentAdapter`]/[`AgentSession`] pair that
//! drives the `claude` CLI's `stream-json` protocol over piped stdio
//! ([`crate::worker::proc::spawn_piped`]).
//!
//! Verified against `claude` 2.1.280 and 2.1.281 (live traces) and
//! `@anthropic-ai/claude-agent-sdk` 0.3.280's protocol types; the oldest
//! CLI it drives is `MIN_CLI_VERSION`. The wire types live in `wire`;
//! the trust-tier mapping, argv, child environment and capabilities in `tier`;
//! the child process and handshake in `process`; the shared session
//! state in `state`; teardown in `teardown`; and the reader task's frame
//! handlers in `reader`. This file holds the constants, the adapter and
//! the session. The unit tests
//! drive a fake CLI (`tests/fixtures/claude_code/fake_claude_cli.mjs`)
//! that plays one scenario module per test with the real CLI's ordering.
//!
//! ## One process per session
//!
//! A single `claude -p --input-format stream-json` process serves every
//! turn of a session: each user message written to its stdin runs as one
//! turn, with its own `system/init` and exactly one terminal `result`
//! line, while `session_id` and the conversation carry over.
//! [`ClaudeCodeSession::send_turn`] therefore writes to the same stdin
//! every time; `--resume` only rehydrates a session whose process is
//! gone.
//!
//! ## Handshake
//!
//! The CLI writes nothing to stdout until it receives input — not even
//! `system/init`, which it emits per turn, after that turn's user
//! message. [`ClaudeCodeAdapter::spawn`] therefore opens every session
//! with the `initialize` control request and waits (bounded by
//! `HANDSHAKE_TIMEOUT`) for its `control_response`, which costs no API
//! call and reports the resolved models, the account, and the active
//! permission mode. A CLI that fails to start (a `--resume` of an
//! unknown session, an unknown flag) answers with a `result` line or
//! exits instead; both fail the spawn and the child is reaped.
//! [`ClaudeCodeAdapter::probe`] runs the same handshake plus
//! `get_binary_version` in a throwaway process, in a fresh private
//! directory it removes afterwards.
//!
//! ## Turn ownership
//!
//! The CLI can run turns SWARM never asked for: a background task's
//! completion notice, a scheduled wake-up, a resumed session's unfinished
//! work. Their frames must not be pinned on a SWARM turn. Every prompt is
//! therefore written with the SWARM turn id as its `uuid`, which the CLI
//! echoes back (`command_lifecycle.command_uuid`, and `user_message_uuid`
//! on the turn's first stream event, first assistant message and
//! `result`). A turn is *queued* from `send_turn` until the CLI starts
//! it (`command_lifecycle` `started`, or an echoing frame; on a CLI
//! without `msg_lifecycle_v1`, its `system/init`), and only a started
//! turn receives deltas, blocks, tool calls and permission requests. A
//! `result` settles the in-flight turn when it echoes that turn's id, or
//! when it echoes nothing while the turn is running (a zeroed crash
//! result); anything else belongs to work SWARM did not start and is
//! dropped. Background tasks are switched off for the child
//! (`DISABLE_BACKGROUND_TASKS_ENV`) so subagents run inside the turn
//! that launched them; their frames carry a `parent_tool_use_id` and are
//! kept out of the top-level transcript.
//!
//! ## Permissions: trust tier at spawn, human in the loop mid-turn
//!
//! A session loads no settings file (`--setting-sources ""`): its only
//! settings are inline, and a repo's `.claude/settings.json` contributes
//! nothing but its `permissions.deny` strings, appended to the tier's
//! deny list. A spawn refuses a working directory that is not an
//! absolute, existing directory, and starts the `claude` executable
//! found in an absolute `PATH` entry, cached from the last probe.
//! A [`ClaudeCodeTrustTier`] fixes the permission mode, the settings deny
//! list, and (Restricted only) `--restricted` at spawn. Everything the
//! tier neither allows nor denies is asked of the host:
//! `--permission-prompt-tool stdio` makes the CLI send a `can_use_tool`
//! control request and block until it is answered. The session surfaces
//! each one as a pending `agent_permission_request` (no suggested
//! decision) and answers it from [`AgentSession::respond_permission`];
//! an ask nobody answers is denied after `PERMISSION_DECISION_TIMEOUT`.
//! An ask flagged `requires_user_interaction` (the tool's approval card
//! is where the user answers, e.g. `AskUserQuestion`) is denied at once
//! and reported as a denial: a one-tap Allow would pass it through
//! unanswered.
//! Denials the CLI decides on its own (the deny list, `dontAsk`, the
//! redirection guard) are reported with `suggested_decision: Deny` from
//! `system/permission_denied`, reconciled against the authoritative
//! `result.permission_denials`. Permission gating never rests on
//! `allowedTools`, which widens what runs unasked rather than narrowing
//! it (Condition C, [`PermissionDecision`]).
//!
//! ## Cancel and teardown
//!
//! [`AgentSession::cancel`] sends the `interrupt` control request; the
//! CLI aborts the turn and writes its `result` (`terminal_reason:
//! "aborted_streaming"`), which settles the turn as "Turn Cancelled",
//! and the session stays usable. Only when the CLI does not accept the
//! interrupt within `INTERRUPT_ACK_TIMEOUT`, or writes no receipt within
//! `INTERRUPT_GRACE` after accepting it, is the process killed. Teardown
//! runs exactly once, in its own task: an idle session closes stdin and
//! lets the CLI exit (it saves the session's totals on the way out), a
//! busy one is killed, and a turn still in flight gets a synthesized
//! settlement (Condition B, [`AgentSession::shutdown`]).

mod process;
mod reader;
mod state;
mod teardown;
mod tier;
mod wire;

#[cfg(test)]
mod tests;

use std::collections::HashMap;
use std::ffi::OsString;
use std::mem::DropGuard;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::sync::{Notify, oneshot, watch};
use uuid::Uuid;

use self::process::{HandshakeError, Process, handshake, resolve_program};
use self::reader::{run_reader, watch_framer_errors};
use self::state::{Inner, Shared, Status, Stop, TurnState};
use self::teardown::teardown;
use self::tier::{
    accepted_permission_modes, build_claude_flags, cap_repo_deny, claude_code_capabilities,
    parse_trust_tier, probe_flags, repo_deny_entries,
};
use self::wire::{ControlResponse, SignIn};
use crate::agent::adapter::{
    AgentAdapter, AgentSession, AgentSpawnSpec, BoxFuture, Capabilities, ExitSummary,
    PermissionDecision, PermissionId, ProbeReport, ProviderId, SessionKey, TurnId, TurnInput,
};
use crate::error::AppError;
use crate::events::{AgentSessionStartedPayload, EventSink, SwarmEvent};

// ── Constants ────────────────────────────────────────────────────────

/// Oldest `claude` release this adapter drives: `--permission-prompts`
/// (2.1.259) is the newest flag it passes (`--restricted` arrived in
/// 2.1.248). [`ClaudeCodeAdapter::probe`] reports anything older as
/// unavailable.
const MIN_CLI_VERSION: (u32, u32, u32) = (2, 1, 259);

/// Bound on the `initialize` handshake that opens every session.
#[cfg(not(test))]
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(30);
#[cfg(test)]
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);

/// Bound on the whole probe, cold CLI start included (about 1s warm on
/// the 2.1.281 reference machine).
const PROBE_TIMEOUT: Duration = Duration::from_secs(15);

/// How long [`AgentSession::cancel`] waits for the CLI to acknowledge an
/// `interrupt` control request before killing the process.
#[cfg(not(test))]
const INTERRUPT_ACK_TIMEOUT: Duration = Duration::from_secs(5);
#[cfg(test)]
const INTERRUPT_ACK_TIMEOUT: Duration = Duration::from_secs(2);

/// How long an acknowledged interrupt may take to produce the turn's
/// `result` before [`AgentSession::cancel`] falls back to a kill.
#[cfg(not(test))]
const INTERRUPT_GRACE: Duration = Duration::from_secs(10);
#[cfg(test)]
const INTERRUPT_GRACE: Duration = Duration::from_secs(1);

/// How long an idle CLI gets to exit on its own after stdin closes
/// (2.1.281 exits in about 0.6s) before teardown kills it.
const SHUTDOWN_GRACE: Duration = Duration::from_secs(3);

/// Poll interval while waiting out [`SHUTDOWN_GRACE`] with non-blocking
/// `try_wait` calls.
const EXIT_POLL_INTERVAL: Duration = Duration::from_millis(20);

/// How long a `can_use_tool` ask may wait for a human before the session
/// denies it: bounded, so a turn never blocks forever on a dialog nobody
/// is looking at while it holds a scheduler slot.
#[cfg(not(test))]
const PERMISSION_DECISION_TIMEOUT: Duration = Duration::from_mins(10);
#[cfg(test)]
const PERMISSION_DECISION_TIMEOUT: Duration = Duration::from_secs(2);

/// Default `--model` alias when [`AgentSpawnSpec::model`] is `None`.
const DEFAULT_MODEL_ALIAS: &str = "sonnet";

/// `--max-turns`: a ceiling on the CLI's internal tool-use loop within
/// ONE SWARM turn (not on how many SWARM turns a session runs). Accepted
/// by the CLI but not listed in `--help`.
const MAX_TURNS_PER_TURN: &str = "50";

/// Switches off background tasks (async subagents, background shells)
/// for the child. With them on, an `Agent` call returns at once, the turn
/// ends, and the subagent's report arrives later as a turn SWARM never
/// started; with them off the subagent runs inside the turn that
/// launched it.
const DISABLE_BACKGROUND_TASKS_ENV: &str = "CLAUDE_CODE_DISABLE_BACKGROUND_TASKS";

/// Prefix of the synthesized settlement error for every ungraceful exit
/// (child killed, crashed, or an NDJSON framer failure) — Condition B. In
/// parentheses it is followed by the cause SWARM knows (a framer error), else
/// `crate::agent::stderr_snippet` of the child's stderr tail (`Stderr: …` or
/// `No Stderr Output`).
const PROCESS_EXITED_WITHOUT_RECEIPT: &str = "Process Exited Without A Receipt";

/// Settlement error for a turn [`AgentSession::cancel`] interrupted.
const TURN_CANCELLED: &str = "Turn Cancelled";

/// Settlement error for a turn the CLI closed without a `result` line.
const TURN_ENDED_WITHOUT_RESULT: &str = "Turn Ended Without A Result";

/// Deny message sent to the CLI for a human "Deny".
const DENIED_BY_USER: &str = "Denied By The User";

/// Deny message for an ask nobody answered in time.
const PERMISSION_TIMED_OUT: &str = "No Decision Arrived In Time; Denied Automatically";

/// Deny message for an ask raised outside any SWARM turn (by a turn the
/// CLI started on its own).
const NO_SWARM_TURN: &str = "No SWARM Turn Is Waiting On This Session; Denied Automatically";

/// Error answer to control requests this host does not implement
/// (`request_user_dialog`, `elicitation`, ...), and the deny message for
/// a `can_use_tool` ask that only the CLI's own dialog can answer.
const UNSUPPORTED_REQUEST: &str = "Not Supported By The SWARM Host";

/// Error text for `send_turn` on a session that is shutting down.
const SESSION_CLOSED: &str = "Claude Code Session Is Shut Down";

/// SWARM's closed vocabulary for Claude Code's spawn-time trust dial.
///
/// Deliberately NOT the provider's raw `--permission-mode` strings.
/// [`AgentSpawnSpec::permission_mode`] is parsed through
/// `parse_trust_tier`, which recognizes ONLY the three wire tokens
/// below and fails closed on anything else — including a raw provider
/// mode (`"acceptEdits"`, `"dontAsk"`) and, above all,
/// `"bypassPermissions"`. No variant maps to `bypassPermissions`, so the
/// flag value is unconstructible by this adapter (see
/// `tests::bypass_permissions_is_unconstructible`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ClaudeCodeTrustTier {
    /// Read-only exploration: `--restricted` (no command-running tools,
    /// no `WebFetch`, file tools confined to the working directory),
    /// `--permission-mode dontAsk` (anything not pre-approved is denied
    /// without asking), and a deny list for the tools that write
    /// (`Write`, `Edit`, `NotebookEdit`, the worktree tools,
    /// `DesignSync`) or send data out (`WebSearch`, `PushNotification`).
    Restricted,
    /// `--permission-mode manual`, the CLI's default mode, pinned by the
    /// flag: reads run, anything that needs approval (commands with side
    /// effects, file edits) is asked of the human, the worktree tools are
    /// denied, and the destructive Bash patterns in `deny_list` are
    /// denied as a convenience fence (other spellings reach the human).
    Standard,
    /// `--permission-mode acceptEdits`: file edits and the filesystem
    /// commands `mkdir`/`touch`/`rm`/`rmdir`/`mv`/`cp`/`sed` in the
    /// working directory run without asking; other commands are asked of
    /// the human, and the same deny list as Standard applies.
    WriteEnabled,
}

/// Display name of a third-party `apiProvider` value (the Agent SDK's
/// `AccountInfo.apiProvider` union).
fn provider_label(provider: &str) -> &str {
    match provider {
        "bedrock" => "Amazon Bedrock",
        "vertex" => "Google Vertex AI",
        "foundry" => "Microsoft Foundry",
        "anthropicAws" => "Anthropic On AWS",
        "anthropicGoogleCloud" => "Anthropic On Google Cloud",
        "mantle" => "Mantle",
        "gateway" => "Enterprise Gateway",
        other => other,
    }
}

/// `"2.1.281"` or `"2.1.281 (Claude Code)"` -> `(2, 1, 281)`.
fn parse_version(raw: &str) -> Option<(u32, u32, u32)> {
    let mut parts = raw
        .split_whitespace()
        .next()?
        .split('.')
        .map(|part| part.parse::<u32>().ok());
    Some((parts.next()??, parts.next()??, parts.next()??))
}

// ── AgentAdapter / AgentSession ──────────────────────────────────────

/// The `claude` CLI adapter. One instance drives every Claude Code
/// worker; each [`ClaudeCodeSession`] it spawns owns one child process.
pub struct ClaudeCodeAdapter {
    sink: EventSink,
    binary: String,
    /// Test-only argv prefix (empty in production), set by
    /// `ClaudeCodeAdapter::with_test_binary`.
    prefix_args: Vec<String>,
    /// The executable `binary` resolved to (`resolve_program`): set by
    /// every probe, reused by every spawn that follows, and resolved by
    /// the first spawn when no probe ran.
    resolved: parking_lot::RwLock<Option<PathBuf>>,
    /// Where each probe's private directory is created: the temp dir,
    /// except in tests, which give each adapter a root of its own.
    probe_root: PathBuf,
}

/// Name of a probe's private working directory under the probe root: the
/// prefix, then a fresh UUID.
const PROBE_DIR_PREFIX: &str = "swarm-claude-probe-";

/// Most bytes of a repo's `.claude/settings.json` SWARM reads for its
/// deny entries; a longer file (by its size, and by what a read yields)
/// contributes none. What it contributes is capped again by
/// [`tier::cap_repo_deny`].
const REPO_SETTINGS_MAX_BYTES: u64 = 1024 * 1024;

/// Creates a fresh directory for one probe under `root`, owner-only
/// (`0700`) on Unix. Creation is not recursive, so it fails when the path
/// already exists rather than reuse a directory someone else made.
async fn private_probe_dir(root: &Path) -> std::io::Result<PathBuf> {
    let dir = root.join(format!("{PROBE_DIR_PREFIX}{}", Uuid::new_v4()));
    #[cfg(unix)]
    let builder = {
        let mut builder = tokio::fs::DirBuilder::new();
        builder.mode(0o700);
        builder
    };
    #[cfg(not(unix))]
    let builder = tokio::fs::DirBuilder::new();
    builder.create(&dir).await?;
    Ok(dir)
}

/// How often `remove_probe_dir` retries a removal that fails.
const PROBE_DIR_REMOVE_ATTEMPTS: u32 = 50;
/// The wait between those retries.
const PROBE_DIR_REMOVE_RETRY: Duration = Duration::from_millis(100);

/// The probe directory's drop action: removes it on the blocking pool (a
/// Tokio worker must not wait on the filesystem inside `Drop`), inline
/// when the dropping thread has no runtime.
///
/// A dropped probe future also drops its `Process`, whose guard kills and
/// reaps the child on the blocking pool. That runs concurrently with this
/// removal, and Windows refuses to remove a directory that is a live
/// process's working directory, so the removal retries until the child is
/// gone. On Unix the first attempt usually succeeds (a child still writing can make `remove_dir_all` fail with ENOTEMPTY).
fn remove_probe_dir_detached(dir: PathBuf) {
    match tokio::runtime::Handle::try_current() {
        Ok(runtime) => drop(runtime.spawn_blocking(move || remove_probe_dir(&dir))),
        Err(_) => remove_probe_dir(&dir),
    }
}

/// Removes `dir`, retrying while a dying child may still hold it, and
/// warns when it cannot. An already-missing directory counts as removed.
fn remove_probe_dir(dir: &Path) {
    for attempt in 1..=PROBE_DIR_REMOVE_ATTEMPTS {
        match std::fs::remove_dir_all(dir) {
            Ok(()) => return,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return,
            Err(error) if attempt == PROBE_DIR_REMOVE_ATTEMPTS => {
                tracing::warn!(path = %dir.display(), %error, "claude code: the probe directory could not be removed");
            }
            Err(_) => std::thread::sleep(PROBE_DIR_REMOVE_RETRY),
        }
    }
}

/// Reads at most `max` bytes of `reader`: `None` when it holds more (the
/// read stops one byte past `max`, so even an endless source leaves the
/// buffer holding at most `max + 1` bytes of content).
async fn read_capped<R: tokio::io::AsyncRead + Unpin>(
    reader: R,
    max: u64,
) -> std::io::Result<Option<Vec<u8>>> {
    use tokio::io::AsyncReadExt;
    let mut bytes = Vec::new();
    reader
        .take(max.saturating_add(1))
        .read_to_end(&mut bytes)
        .await?;
    Ok(u64::try_from(bytes.len())
        .is_ok_and(|len| len <= max)
        .then_some(bytes))
}

/// The `permissions.deny` entries of `<cwd>/.claude/settings.json`
/// ([`tier::repo_deny_entries`], then [`tier::cap_repo_deny`]), or none
/// when the file is missing, not a regular file, unreadable, not UTF-8,
/// not a JSON object, or longer than [`REPO_SETTINGS_MAX_BYTES`]. Each
/// of those but a missing file is logged. Nothing else in the file is
/// used.
///
/// The metadata check keeps FIFOs and devices from being opened, but it
/// cannot bound the read: a symlink to `/proc/self/pagemap` reports a
/// regular file of length 0 and then yields zeros without end. So the
/// read itself stops one byte past the cap.
async fn read_repo_deny(cwd: &Path) -> Vec<String> {
    let file = cwd.join(".claude").join("settings.json");
    match tokio::fs::metadata(&file).await {
        Ok(meta) if meta.is_file() && meta.len() <= REPO_SETTINGS_MAX_BYTES => {}
        Ok(_) => {
            tracing::warn!(path = %file.display(), "claude code: repo settings are not a regular file within the size cap; ignoring their deny list");
            return Vec::new();
        }
        Err(_) => return Vec::new(),
    }
    match tokio::fs::File::open(&file).await {
        Ok(opened) => deny_from_reader(&file, opened).await,
        Err(error) => {
            tracing::warn!(path = %file.display(), %error, "claude code: repo settings are unreadable; ignoring their deny list");
            Vec::new()
        }
    }
}

/// The deny entries in the content of `reader` (the opened settings file at
/// `file`, named in the warnings): at most [`REPO_SETTINGS_MAX_BYTES`] of it
/// is read, through [`read_capped`]. Anything unusable yields none and is
/// logged.
async fn deny_from_reader<R: tokio::io::AsyncRead + Unpin>(file: &Path, reader: R) -> Vec<String> {
    let bytes = match read_capped(reader, REPO_SETTINGS_MAX_BYTES).await {
        Ok(Some(bytes)) => bytes,
        Ok(None) => {
            tracing::warn!(path = %file.display(), "claude code: repo settings are larger than the size cap; ignoring their deny list");
            return Vec::new();
        }
        Err(error) => {
            tracing::warn!(path = %file.display(), %error, "claude code: repo settings are unreadable; ignoring their deny list");
            return Vec::new();
        }
    };
    let Ok(text) = String::from_utf8(bytes) else {
        tracing::warn!(path = %file.display(), "claude code: repo settings are not UTF-8; ignoring their deny list");
        return Vec::new();
    };
    let Some(entries) = repo_deny_entries(&text) else {
        tracing::warn!(path = %file.display(), "claude code: repo settings are not a JSON object; ignoring their deny list");
        return Vec::new();
    };
    let (kept, dropped) = cap_repo_deny(entries);
    if dropped > 0 {
        tracing::warn!(path = %file.display(), dropped, "claude code: repo settings list more deny entries than fit; the rest are dropped");
    }
    kept
}

impl ClaudeCodeAdapter {
    /// Drives the `claude` binary found in an absolute `PATH` entry.
    pub fn new(sink: EventSink) -> Self {
        Self {
            sink,
            binary: "claude".to_owned(),
            prefix_args: Vec::new(),
            resolved: parking_lot::RwLock::new(None),
            probe_root: std::env::temp_dir(),
        }
    }

    /// Drives a stand-in child instead of the real CLI: `binary` plus
    /// `prefix_args` (e.g. `("node", [fake_claude_cli.mjs, scenario])`)
    /// go in front of the flags [`build_claude_flags`]/[`probe_flags`]
    /// build.
    #[cfg(test)]
    pub fn with_test_binary(
        sink: EventSink,
        binary: impl Into<String>,
        prefix_args: Vec<String>,
    ) -> Self {
        Self {
            sink,
            binary: binary.into(),
            prefix_args,
            resolved: parking_lot::RwLock::new(None),
            probe_root: std::env::temp_dir(),
        }
    }

    /// Creates probe directories under `root` instead of the temp dir, so
    /// a test sees only its own.
    #[cfg(test)]
    pub fn with_probe_root(mut self, root: PathBuf) -> Self {
        self.probe_root = root;
        self
    }

    /// The executable to start: the cached resolution unless `refresh` or
    /// none is cached, else a fresh [`resolve_program`] over `PATH`.
    async fn program(&self, refresh: bool) -> Option<PathBuf> {
        self.program_on(refresh, std::env::var_os("PATH")).await
    }

    /// [`Self::program`] over the given `PATH` value.
    async fn program_on(&self, refresh: bool, path: Option<OsString>) -> Option<PathBuf> {
        if !refresh && let Some(cached) = self.resolved.read().clone() {
            return Some(cached);
        }
        let binary = self.binary.clone();
        let found = tokio::task::spawn_blocking(move || {
            resolve_program(&binary, path.as_deref(), cfg!(windows))
        })
        .await
        .ok()
        .flatten();
        self.resolved.write().clone_from(&found);
        found
    }

    /// Runs the probe in a fresh private directory (`private_probe_dir`)
    /// and removes it on every return path, including a dropped future.
    async fn run_probe(&self) -> ProbeReport {
        let cwd = match private_probe_dir(&self.probe_root).await {
            Ok(cwd) => cwd,
            Err(error) => {
                return ProbeReport {
                    available: false,
                    version: None,
                    detail: Some(format!(
                        "Claude Code Probe Directory Could Not Be Created: {error}"
                    )),
                };
            }
        };
        // A dropped probe future must not leave the directory behind. The
        // guard is dismissed on the normal path so `probe()` returns with
        // the directory already gone.
        let remove_if_dropped =
            DropGuard::new(cwd.clone(), remove_probe_dir_detached as fn(PathBuf));
        let report = self.run_probe_in(&cwd).await;
        DropGuard::dismiss(remove_if_dropped);
        if let Err(error) = tokio::fs::remove_dir_all(&cwd).await {
            tracing::warn!(path = %cwd.display(), %error, "claude code: the probe directory could not be removed");
        }
        report
    }

    async fn run_probe_in(&self, cwd: &Path) -> ProbeReport {
        let unavailable = |version: Option<String>, detail: String| ProbeReport {
            available: false,
            version,
            detail: Some(detail),
        };
        let Some(program) = self.program(true).await else {
            return unavailable(
                None,
                format!(
                    "Claude Code CLI Not Found On PATH: No Absolute PATH Entry Holds {:?}",
                    self.binary
                ),
            );
        };
        let mut argv = self.prefix_args.clone();
        argv.extend(probe_flags());
        let mut process =
            match Process::start(&program.to_string_lossy(), &argv, &cwd.to_string_lossy()).await {
                Ok(process) => process,
                Err(error) => {
                    let not_found = error.chain().any(|cause| {
                        cause
                            .downcast_ref::<std::io::Error>()
                            .is_some_and(|io| io.kind() == std::io::ErrorKind::NotFound)
                    });
                    let detail = if not_found {
                        format!("Claude Code CLI Not Found On PATH: {error:#}")
                    } else {
                        format!("Claude Code CLI Could Not Be Started: {error:#}")
                    };
                    return unavailable(None, detail);
                }
            };
        let answer = tokio::time::timeout(PROBE_TIMEOUT, handshake(&mut process, true)).await;
        let stderr = process.finish(true).await;
        let (init, version) = match answer {
            Ok(Ok(answer)) => answer,
            Ok(Err(HandshakeError::Rejected(error))) => {
                return unavailable(None, format!("Claude Code CLI Rejected The Probe: {error}"));
            }
            Ok(Err(HandshakeError::StartupFailure(error))) => {
                return unavailable(None, format!("Claude Code CLI Failed To Start: {error}"));
            }
            Ok(Err(HandshakeError::Exited)) => {
                return unavailable(
                    None,
                    format!("Claude Code CLI Exited During The Probe ({stderr})"),
                );
            }
            Err(_elapsed) => {
                return unavailable(None, "Claude Code CLI Probe Timed Out".to_owned());
            }
        };
        if let Some(found) = version.as_deref().and_then(parse_version)
            && found < MIN_CLI_VERSION
        {
            let (major, minor, patch) = MIN_CLI_VERSION;
            return unavailable(
                version,
                format!("Claude Code {major}.{minor}.{patch} Or Newer Required"),
            );
        }
        let detail = match init.account.unwrap_or_default().sign_in() {
            SignIn::SignedOut => {
                return unavailable(version, "Claude Code CLI Not Signed In".to_owned());
            }
            SignIn::Account { plan: Some(plan) } => format!("Signed In ({plan})"),
            SignIn::Account { plan: None } => "Signed In".to_owned(),
            SignIn::ApiKey { source } => format!("Using An API Key ({source})"),
            SignIn::Token { source } => format!("Signed In With A Token ({source})"),
            SignIn::Provider { name } => format!("Signed In Via {}", provider_label(&name)),
        };
        ProbeReport {
            available: true,
            version,
            detail: Some(detail),
        }
    }

    async fn spawn_session(&self, spec: AgentSpawnSpec) -> Result<ClaudeCodeSession, AppError> {
        // An empty working directory would make the child inherit SWARM's
        // own (`/` for a macOS app opened from the Finder), and the
        // CLI's working-directory limits would then cover the whole disk.
        let cwd = Path::new(&spec.cwd);
        let cwd_ok = cwd.is_absolute()
            && tokio::fs::metadata(cwd)
                .await
                .is_ok_and(|meta| meta.is_dir());
        if !cwd_ok {
            return Err(AppError::Ai(format!(
                "Agent Session Needs An Absolute, Existing Working Directory (Got {:?})",
                spec.cwd
            )));
        }
        let tier = parse_trust_tier(spec.permission_mode.as_deref())?;
        let requested_model = spec
            .model
            .clone()
            .unwrap_or_else(|| DEFAULT_MODEL_ALIAS.to_owned());
        let repo_deny = read_repo_deny(cwd).await;
        let mut argv = self.prefix_args.clone();
        argv.extend(build_claude_flags(
            spec.worker_id,
            &requested_model,
            tier,
            spec.resume.as_deref(),
            &repo_deny,
        ));

        let program = self.program(false).await.ok_or_else(|| {
            AppError::Ai(format!(
                "Failed To Start Claude Code: No Absolute PATH Entry Holds {:?}",
                self.binary
            ))
        })?;
        let mut process = Process::start(&program.to_string_lossy(), &argv, &spec.cwd)
            .await
            .map_err(|error| AppError::Ai(format!("Failed To Start Claude Code: {error:#}")))?;

        let init = match tokio::time::timeout(HANDSHAKE_TIMEOUT, handshake(&mut process, false))
            .await
        {
            Ok(Ok((init, _))) => init,
            failed => {
                let stderr = process.finish(false).await;
                return Err(AppError::Ai(match failed {
                    Ok(Err(HandshakeError::Rejected(error))) => {
                        format!("Claude Code Rejected The Session Handshake: {error}")
                    }
                    Ok(Err(HandshakeError::StartupFailure(error))) => {
                        format!("Claude Code Could Not Start The Session: {error}")
                    }
                    Ok(Err(HandshakeError::Exited)) => {
                        format!("Claude Code Exited During The Session Handshake ({stderr})")
                    }
                    _ => format!(
                        "Claude Code Did Not Answer The Session Handshake Within {}s ({stderr})",
                        HANDSHAKE_TIMEOUT.as_secs()
                    ),
                }));
            }
        };

        // A second fence behind the pinned `--permission-mode`, for
        // anything that overrides the flag. The field is not in
        // the SDK's public types, so a CLI that stops reporting it runs
        // on the pinned flag alone.
        if let Some(mode) = init.current_permission_mode.as_deref()
            && !accepted_permission_modes(tier).contains(&mode)
        {
            process.finish(false).await;
            return Err(AppError::PermissionDenied(format!(
                "Claude Code Reports Permission Mode {mode:?} For The {tier:?} Trust Tier; \
                 Refusing To Run It"
            )));
        }
        if let Some(pid) = init.pid {
            tracing::debug!(worker_id = %spec.worker_id, pid, "claude code: session handshake complete");
        }

        let Process {
            child,
            stdin,
            lines,
            framer_errors,
            stderr_tail,
        } = process;
        // Nothing below awaits before the child is owned by `Shared`, so
        // dismissing the guard here leaves no window in which a dropped
        // future could leak it.
        let child = DropGuard::dismiss(child);
        let fresh = spec.resume.is_none();
        let session_key = spec
            .resume
            .clone()
            .unwrap_or_else(|| spec.worker_id.to_string());
        let shared = Arc::new(Shared {
            worker_id: spec.worker_id,
            sink: self.sink.clone(),
            session_key: session_key.clone(),
            state: parking_lot::Mutex::new(Inner {
                turn: None,
                lifecycle: None,
                cost_baseline: fresh.then_some(0.0),
                asks: HashMap::new(),
                control_waiters: HashMap::new(),
                child: Some(child),
                closing: false,
            }),
            stdin,
            status: watch::Sender::new(Status::default()),
            teardown_started: AtomicBool::new(false),
            stderr_tail,
            teardown_cause: parking_lot::Mutex::new(None),
        });

        let drain_signal = Arc::new(Notify::new());
        tokio::spawn(run_reader(shared.clone(), lines, drain_signal.clone()));
        tokio::spawn(watch_framer_errors(
            shared.clone(),
            framer_errors,
            drain_signal,
        ));

        self.sink.emit(SwarmEvent::AgentSessionStarted(
            AgentSessionStartedPayload {
                worker_id: spec.worker_id,
                provider: ProviderId::ClaudeCode,
                session_key,
                model: init.resolve_model(&requested_model),
                cwd: spec.cwd,
                capabilities: claude_code_capabilities(),
            },
        ));

        Ok(ClaudeCodeSession { shared })
    }
}

impl AgentAdapter for ClaudeCodeAdapter {
    fn provider(&self) -> ProviderId {
        ProviderId::ClaudeCode
    }

    fn capabilities(&self) -> Capabilities {
        claude_code_capabilities()
    }

    /// Starts the CLI with the control protocol only, asks `initialize`
    /// (account and models) and `get_binary_version`, and stops it: no
    /// API call, no session on disk. `available` is `false` when the CLI
    /// is missing, older than `MIN_CLI_VERSION`, or signed out; the
    /// account's email is never kept.
    fn probe(&self) -> BoxFuture<'_, Result<ProbeReport, AppError>> {
        Box::pin(async move { Ok(self.run_probe().await) })
    }

    fn spawn(
        &self,
        spec: AgentSpawnSpec,
    ) -> BoxFuture<'_, Result<Box<dyn AgentSession>, AppError>> {
        Box::pin(async move {
            let session: Box<dyn AgentSession> = Box::new(self.spawn_session(spec).await?);
            Ok(session)
        })
    }
}

/// Per-worker handle to one live `claude` process. Dropping the last
/// handle without [`AgentSession::shutdown`] kills the process.
pub struct ClaudeCodeSession {
    shared: Arc<Shared>,
}

impl ClaudeCodeSession {
    async fn cancel_turn(&self, turn: TurnId) {
        let shared = &self.shared;
        let (asks, acknowledged, request_id) = {
            let mut guard = shared.state.lock();
            let inner = &mut *guard;
            let Some(current) = inner
                .turn
                .as_mut()
                .filter(|current| current.id == turn && !current.cancelling)
            else {
                // Stale, already settled, or already being cancelled.
                return;
            };
            current.cancelling = true;
            let asks = inner
                .asks
                .extract_if(|_, ask| ask.turn_id == turn)
                .collect::<Vec<_>>();
            let request_id = format!("swarm-interrupt-{}", Uuid::new_v4());
            let (waiter, acknowledged) = oneshot::channel();
            inner.control_waiters.insert(request_id.clone(), waiter);
            (asks, acknowledged, request_id)
        };
        for (ask_id, ask) in asks {
            shared.stdin.send(wire::permission_deny(
                &ask_id,
                &ask.tool_use_id,
                TURN_CANCELLED,
                true,
            ));
        }
        let accepted = shared.stdin.send(wire::interrupt_request(&request_id))
            && matches!(
                tokio::time::timeout(INTERRUPT_ACK_TIMEOUT, acknowledged).await,
                Ok(Ok(ControlResponse::Success { .. }))
            );
        if accepted
            && tokio::time::timeout(INTERRUPT_GRACE, shared.settled(&turn))
                .await
                .is_ok()
        {
            return;
        }
        shared.state.lock().control_waiters.remove(&request_id);
        tracing::warn!(worker_id = %shared.worker_id, %turn, accepted, "claude code: interrupt did not settle the turn; killing the process");
        teardown(shared, Stop::Kill).await;
    }
}

impl AgentSession for ClaudeCodeSession {
    fn session_key(&self) -> &SessionKey {
        &self.shared.session_key
    }

    fn send_turn(&self, turn: TurnInput) -> BoxFuture<'_, Result<TurnId, AppError>> {
        Box::pin(async move {
            let shared = &self.shared;
            let turn_id: TurnId = Uuid::new_v4().to_string();
            {
                let mut inner = shared.state.lock();
                if inner.closing {
                    return Err(AppError::Ipc(SESSION_CLOSED.to_owned()));
                }
                if inner.turn.is_some() {
                    return Err(AppError::AgentSessionBusy);
                }
                let running = inner.lifecycle == Some(false);
                let state = TurnState::new(turn_id.clone(), running);
                shared.publish_in_flight(Some(&state));
                inner.turn = Some(state);
            }
            match shared
                .stdin
                .write(wire::user_turn(&turn.prompt, &turn_id))
                .await
            {
                Ok(()) => Ok(turn_id),
                Err(error) => {
                    let mut inner = shared.state.lock();
                    if inner.turn.as_ref().is_some_and(|turn| turn.id == turn_id) {
                        inner.turn = None;
                        shared.publish_in_flight(None);
                        Err(AppError::Ipc(format!(
                            "Failed To Send The Turn To Claude Code: {error}"
                        )))
                    } else {
                        // Teardown claimed the turn first and already
                        // synthesized its one settlement: hand back the id
                        // that settlement carries.
                        Ok(turn_id)
                    }
                }
            }
        })
    }

    fn await_turn_completion(&self, turn: TurnId) -> BoxFuture<'_, Result<(), AppError>> {
        Box::pin(async move {
            self.shared.settled(&turn).await;
            Ok(())
        })
    }

    /// Interrupts `turn` in-band (the session stays alive), falling back
    /// to a kill when the CLI does not acknowledge the interrupt or write
    /// the turn's receipt in time. A cancel for a turn that is not in
    /// flight is a no-op.
    fn cancel(&self, turn: TurnId) -> BoxFuture<'_, Result<(), AppError>> {
        Box::pin(async move {
            self.cancel_turn(turn).await;
            Ok(())
        })
    }

    /// Answers a pending `can_use_tool` ask. An id with no open ask — a
    /// report-only denial, an ask already answered, withdrawn by the CLI,
    /// or timed out — is a no-op, so a double click cannot fail.
    fn respond_permission(
        &self,
        req: PermissionId,
        decision: PermissionDecision,
    ) -> BoxFuture<'_, Result<(), AppError>> {
        Box::pin(async move {
            let ask = self.shared.state.lock().asks.remove(&req);
            let Some(ask) = ask else {
                return Ok(());
            };
            let answer = match decision {
                PermissionDecision::Allow => {
                    wire::permission_allow(&req, &ask.tool_use_id, &ask.input)
                }
                PermissionDecision::Deny => {
                    wire::permission_deny(&req, &ask.tool_use_id, DENIED_BY_USER, false)
                }
            };
            self.shared.stdin.write(answer).await.map_err(|error| {
                AppError::Ipc(format!(
                    "Failed To Send The Permission Decision To Claude Code: {error}"
                ))
            })
        })
    }

    fn shutdown(&self) -> BoxFuture<'_, Result<ExitSummary, AppError>> {
        Box::pin(async move { Ok(teardown(&self.shared, Stop::Graceful).await) })
    }
}

impl Drop for ClaudeCodeSession {
    fn drop(&mut self) {
        if self.shared.teardown_started.load(Ordering::Acquire) {
            return;
        }
        // Killing is a non-blocking syscall; the reader task sees stdout
        // close and runs the real teardown, which reaps the child.
        if let Some(child) = self.shared.state.lock().child.as_mut() {
            child.kill().ok();
        }
    }
}
