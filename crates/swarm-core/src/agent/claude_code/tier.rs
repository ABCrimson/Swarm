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
/// Standard tier included, so the mode never comes from a settings file:
/// sessions load no project settings (`--setting-sources ""`), and the
/// flag also overrides a settings `defaultMode` (measured on 2.1.281
/// with project settings loaded: `"defaultMode": "acceptEdits"` made
/// `initialize` report `acceptEdits`, and `--permission-mode manual`,
/// the name the CLI has accepted for its default mode since 2.1.200,
/// overrode it).
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
/// appeared in `result.permission_denials`).
///
/// Every tier denies `EnterWorktree` and `ExitWorktree`: the CLI allows
/// `EnterWorktree` without a `path` unasked in every mode (`dontAsk`
/// only turns an "ask" into a deny), and it creates a branch plus a
/// checkout under `<cwd>/.claude/worktrees/` and moves the session
/// there (2.1.296). The Agent tool's `isolation: "worktree"` creates a
/// worktree too; no rule short of denying `Agent` blocks it.
///
/// Restricted adds the tools that write or reach out: under
/// `--restricted` the `Bash` and `PowerShell` entries are redundant (the
/// flag removes both) and stay as a second fence; `Write`, `Edit` and
/// `NotebookEdit` are not removed by the flag; `DesignSync` writes to
/// claude.ai design projects, and `WebSearch` and `PushNotification`
/// send data out.
///
/// For Standard/WriteEnabled these patterns are a convenience fence, not
/// a boundary: shell spellings are unbounded (`rm -r -f`, `rm -fr`, `git
/// push origin +main`) and PowerShell is not covered. The gate is the
/// permission mode plus the human: in `manual` every call the CLI does
/// not auto-approve becomes a `can_use_tool` ask; `acceptEdits`
/// additionally auto-approves file edits and
/// `mkdir`/`touch`/`rm`/`rmdir`/`mv`/`cp`/`sed` inside the working
/// directories (2.1.296).
pub(super) fn deny_list(tier: ClaudeCodeTrustTier) -> &'static [&'static str] {
    match tier {
        ClaudeCodeTrustTier::Restricted => &[
            "Bash",
            "PowerShell",
            "Write",
            "Edit",
            "NotebookEdit",
            "EnterWorktree",
            "ExitWorktree",
            "DesignSync",
            "WebSearch",
            "PushNotification",
        ],
        ClaudeCodeTrustTier::Standard | ClaudeCodeTrustTier::WriteEnabled => &[
            "EnterWorktree",
            "ExitWorktree",
            "Bash(rm -rf*)",
            "Bash(git push --force*)",
            "Bash(git push -f*)",
            "Bash(git reset --hard*)",
            "Bash(sudo*)",
        ],
    }
}

/// Condition A, inline: the JSON STRING passed verbatim to `--settings`,
/// the only settings a session loads (`--setting-sources ""`). Never a
/// file: a settings file written into the worker's worktree would be
/// committed by the ship chain, keep the worktree dirty (so `git
/// worktree remove` refuses), and could clobber a human-committed
/// `.claude/settings.json`.
///
/// The deny list is the tier's [`deny_list`] followed by `repo_deny`, the
/// `permissions.deny` strings of the repo's own `.claude/settings.json`
/// ([`repo_deny_entries`]): a repo can only narrow what a session may
/// do. `disableAllHooks` stays as a second fence behind the empty
/// setting sources (measured on 2.1.296: with `--setting-sources
/// project` an untrusted repo's `SessionStart` hook ran during the
/// `initialize` handshake, and with this key it did not).
/// `disableBypassPermissionsMode` and `disableAutoMode` refuse the two
/// modes that skip the human (measured on 2.1.296: with them,
/// `--permission-mode auto` came back as `default`).
pub(super) fn inline_settings_json(tier: ClaudeCodeTrustTier, repo_deny: &[String]) -> String {
    let deny: Vec<&str> = deny_list(tier)
        .iter()
        .copied()
        .chain(repo_deny.iter().map(String::as_str))
        .collect();
    serde_json::json!({
        "disableAllHooks": true,
        "permissions": {
            "deny": deny,
            "disableBypassPermissionsMode": "disable",
            "disableAutoMode": "disable",
        },
    })
    .to_string()
}

/// The `permissions.deny` string entries of a repo's
/// `.claude/settings.json` text, in order. Anything else in the file
/// (`env`, `apiKeyHelper`, hooks, `allow`, `defaultMode`, ...) is never
/// read, and a file that is not a JSON object yields nothing, as do
/// non-string entries and empty strings.
pub(super) fn repo_deny_entries(settings: &str) -> Vec<String> {
    let Ok(serde_json::Value::Object(root)) = serde_json::from_str(settings) else {
        return Vec::new();
    };
    root.get("permissions")
        .and_then(|permissions| permissions.get("deny"))
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(serde_json::Value::as_str)
        .filter(|entry| !entry.trim().is_empty())
        .map(str::to_owned)
        .collect()
}

/// Most bytes of JSON the entries appended to the inline deny list may
/// take together. The settings travel as ONE argv element
/// (`--settings`), and a platform caps that (about 32K characters on
/// Windows), so a repo's own list must not be able to push the spawn over
/// it.
pub(super) const REPO_DENY_MAX_JSON_BYTES: usize = 8 * 1024;

/// The longest prefix of `entries`, in file order, whose JSON array form
/// fits in [`REPO_DENY_MAX_JSON_BYTES`], and how many entries were left
/// out. It stops at the first entry that does not fit rather than skip
/// to a shorter later one, so what is kept is exactly what the file
/// lists first.
pub(super) fn cap_repo_deny(entries: Vec<String>) -> (Vec<String>, usize) {
    // The array's brackets, then each entry quoted and comma-separated.
    let mut used: usize = 2;
    let mut kept = 0;
    for entry in &entries {
        let quoted = serde_json::to_string(entry).map_or(usize::MAX, |json| json.len());
        let comma = usize::from(kept > 0);
        match used
            .checked_add(quoted)
            .and_then(|sum| sum.checked_add(comma))
        {
            Some(next) if next <= REPO_DENY_MAX_JSON_BYTES => {
                used = next;
                kept += 1;
            }
            _ => break,
        }
    }
    let dropped = entries.len() - kept;
    let mut entries = entries;
    entries.truncate(kept);
    (entries, dropped)
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
/// UUID). `repo_deny` goes after the tier's deny list in the inline
/// settings ([`inline_settings_json`]).
pub(super) fn build_claude_flags(
    worker_id: Uuid,
    model: &str,
    tier: ClaudeCodeTrustTier,
    resume: Option<&str>,
    repo_deny: &[String],
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
        // Condition A: no user, local or project settings and no MCP
        // servers (claude.ai connectors included). A repo's
        // `.claude/settings.json` would otherwise run its `apiKeyHelper`
        // and apply its `env` during the handshake, before any approval
        // (2.1.296), and its `.claude/agents` would load. The inline
        // settings below are the only settings the session has. The same
        // gate also keeps the repo's `CLAUDE.md`, `.claude/rules`,
        // `.claude/skills` and the `AGENTS.md` walk out of a worker's
        // context: the 2.1.296 CLI loads project memory only when the
        // `projectSettings` source is on (read from its source, not
        // verified at runtime).
        "--setting-sources",
        "",
        "--strict-mcp-config",
        "--permission-prompt-tool",
        "stdio",
        "--permission-prompts",
        "host",
    ]
    .map(String::from)
    .into();
    argv.extend([
        "--settings".to_owned(),
        inline_settings_json(tier, repo_deny),
    ]);
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
/// session on disk. `--setting-sources ""` loads no settings file at
/// all, so a `.claude/settings.json` planted where the probe runs cannot
/// run its `apiKeyHelper` or apply its `env` (2.1.296); the probe also
/// runs in a fresh private directory of its own.
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
        "",
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
