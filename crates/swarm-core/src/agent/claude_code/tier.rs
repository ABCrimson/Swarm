//! The `claude` CLI's spawn contract: the argv each trust tier maps to,
//! the probe's argv, the child's environment, and the capabilities the
//! adapter advertises. The `ClaudeCodeTrustTier` enum stays in the parent
//! module, where `src/lib/agent-events.contract.test.ts` reads it.

use std::collections::HashMap;

use uuid::Uuid;

#[cfg(doc)]
use super::ClaudeCodeAdapter;
#[cfg(doc)]
use crate::agent::adapter::{AgentAdapter, AgentSpawnSpec};

use super::{ClaudeCodeTrustTier, DISABLE_BACKGROUND_TASKS_ENV, MAX_TURNS_PER_TURN};
use crate::agent::adapter::{CancelGranularity, Capabilities};
use crate::error::AppError;

// ── Trust tiers ──────────────────────────────────────────────────────

/// Parses [`AgentSpawnSpec::permission_mode`] into a
/// [`ClaudeCodeTrustTier`]. `None` resolves to
/// [`ClaudeCodeTrustTier::Standard`]; any string outside the exact
/// three-token vocabulary is rejected rather than guessed at.
pub(super) fn parse_trust_tier(raw: Option<&str>) -> Result<ClaudeCodeTrustTier, AppError> {
    match raw {
        None | Some("standard") => Ok(ClaudeCodeTrustTier::Standard),
        Some("restricted") => Ok(ClaudeCodeTrustTier::Restricted),
        Some("write_enabled") => Ok(ClaudeCodeTrustTier::WriteEnabled),
        Some(other) => Err(AppError::PermissionDenied(format!(
            "Unrecognized Claude Code Trust Tier {other:?}; Refusing To Spawn Rather Than \
             Guess A Permission Mode (Never bypassPermissions)"
        ))),
    }
}

/// The `--permission-mode` value for `tier`. Every tier passes one, the
/// Standard tier included: without the flag a project's
/// `.claude/settings.json` `defaultMode` picks the mode (measured on
/// 2.1.281: `"defaultMode": "acceptEdits"` made `initialize` report
/// `acceptEdits`), while `--permission-mode manual` (the name the CLI
/// has accepted for its default mode since 2.1.200) overrides it.
pub(super) fn permission_mode_flag(tier: ClaudeCodeTrustTier) -> &'static str {
    match tier {
        ClaudeCodeTrustTier::Restricted => "dontAsk",
        ClaudeCodeTrustTier::Standard => "manual",
        ClaudeCodeTrustTier::WriteEnabled => "acceptEdits",
    }
}

/// The permission modes the `initialize` handshake may report for
/// `tier`. The CLI renamed `default` to "Manual" but still reports
/// `default` for `--permission-mode manual` (2.1.281); both are
/// accepted. Any other answer fails the spawn closed.
pub(super) fn accepted_permission_modes(tier: ClaudeCodeTrustTier) -> &'static [&'static str] {
    match tier {
        ClaudeCodeTrustTier::Restricted => &["dontAsk"],
        ClaudeCodeTrustTier::Standard => &["default", "manual"],
        ClaudeCodeTrustTier::WriteEnabled => &["acceptEdits"],
    }
}

/// `settings.json` `permissions.deny` entries for `tier`. A bare tool
/// name (`"Bash"`) removes the tool from the model's tool list; the
/// `Tool(pattern)` form denies only matching calls (measured on 2.1.232:
/// `Bash(echo*)` refused `echo hi` while `pwd` ran, and the refusal
/// appeared in `result.permission_denials`). Only `Bash(echo*)` was
/// exercised; the patterns below rely on the same glob grammar. Under
/// `--restricted` the Bash entry is redundant (the flag removes the
/// tool) and stays as a second fence.
pub(super) fn deny_list(tier: ClaudeCodeTrustTier) -> &'static [&'static str] {
    match tier {
        ClaudeCodeTrustTier::Restricted => &["Bash", "Write", "Edit", "NotebookEdit"],
        ClaudeCodeTrustTier::Standard | ClaudeCodeTrustTier::WriteEnabled => &[
            "Bash(rm -rf*)",
            "Bash(git push --force*)",
            "Bash(git push -f*)",
            "Bash(git reset --hard*)",
            "Bash(sudo*)",
        ],
    }
}

/// Condition A, inline: the JSON STRING passed verbatim to `--settings`.
/// Never a file: a settings file written into the worker's worktree would
/// be committed by the ship chain, keep the worktree dirty (so `git
/// worktree remove` refuses), and could clobber a human-committed
/// `.claude/settings.json`. `--settings` accepts inline JSON and
/// composes with `--setting-sources project`. `disableAllHooks` stops a
/// project's hooks: `-p` skips the workspace trust dialog, yet project
/// hooks still run (measured on 2.1.296: an untrusted repo's
/// `SessionStart` hook ran during the `initialize` handshake, and with
/// this key it did not).
pub(super) fn inline_settings_json(tier: ClaudeCodeTrustTier) -> String {
    serde_json::json!({
        "disableAllHooks": true,
        "permissions": { "deny": deny_list(tier) },
    })
    .to_string()
}

/// What this adapter can honestly promise — identical for every trust
/// tier: the tier changes what the CLI is ALLOWED to do, never what the
/// protocol can do.
pub(super) fn claude_code_capabilities() -> Capabilities {
    Capabilities {
        partial_deltas: true,
        resume: true,
        native_cost: true,
        // The values `AgentSpawnSpec::permission_mode` accepts
        // (`parse_trust_tier`), not the CLI's own mode names.
        permission_modes: ["restricted", "standard", "write_enabled"]
            .map(String::from)
            .into(),
        // The `interrupt` control request stops the turn and keeps the
        // process and the conversation.
        cancel_granularity: CancelGranularity::Graceful,
        // The CLI can fold a message into a running turn, but a session
        // rejects `send_turn` while busy and the scheduler serializes
        // turns, so SWARM never injects mid-turn.
        interrupt_midturn: false,
        worktree_aware: true,
        // `can_use_tool` over `--permission-prompt-tool stdio` blocks the
        // CLI until `respond_permission` answers it.
        interactive_permissions: true,
    }
}

/// Every argument the CLI gets for a session (the binary itself
/// excluded). `resume` selects `--resume <key>` (rehydration) over
/// `--session-id <worker_id>` (a fresh session keyed by the worker's own
/// UUID).
pub(super) fn build_claude_flags(
    worker_id: Uuid,
    model: &str,
    tier: ClaudeCodeTrustTier,
    resume: Option<&str>,
) -> Vec<String> {
    let mut argv: Vec<String> = [
        "-p",
        "--output-format",
        "stream-json",
        "--input-format",
        "stream-json",
        "--include-partial-messages",
        "--verbose",
        "--model",
        model,
        "--max-turns",
        MAX_TURNS_PER_TURN,
        // Condition A: no user or local settings, no MCP servers (claude.ai
        // connectors included). Project settings load with their hooks
        // disabled and the tier's deny list added by the inline settings
        // below.
        "--setting-sources",
        "project",
        "--strict-mcp-config",
        "--permission-prompt-tool",
        "stdio",
        "--permission-prompts",
        "host",
    ]
    .map(String::from)
    .into();
    argv.extend(["--settings".to_owned(), inline_settings_json(tier)]);
    argv.extend(["--permission-mode", permission_mode_flag(tier)].map(String::from));
    if tier == ClaudeCodeTrustTier::Restricted {
        argv.push("--restricted".to_owned());
    }
    match resume {
        Some(session_key) => argv.extend(["--resume".to_owned(), session_key.to_owned()]),
        None => argv.extend(["--session-id".to_owned(), worker_id.to_string()]),
    }
    argv
}

/// Arguments for [`ClaudeCodeAdapter::probe`]'s throwaway process: the
/// control protocol and nothing that could spend tokens or touch a
/// session on disk.
pub(super) fn probe_flags() -> Vec<String> {
    [
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--no-session-persistence",
        "--setting-sources",
        "project",
        "--settings",
        r#"{"disableAllHooks":true}"#,
        "--strict-mcp-config",
    ]
    .map(String::from)
    .into()
}

/// Environment additions for every `claude` child this adapter starts.
pub(super) fn child_env() -> HashMap<String, String> {
    HashMap::from([(DISABLE_BACKGROUND_TASKS_ENV.to_owned(), "1".to_owned())])
}
