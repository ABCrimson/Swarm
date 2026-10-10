//! Trust-tier mapping, requested-model filtering, effective-policy verification and
//! capabilities.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use super::CLAUDE_MODEL_ALIASES;
use super::protocol::{AskForApproval, SandboxMode, ThreadOpened};

use crate::agent::adapter::{CancelGranularity, Capabilities};
use crate::error::AppError;

/// On Windows an npm install starts Codex through `codex.cmd`. `cmd.exe` looks
/// up the shim's bare `node` in the worker's cwd before `PATH`, so a repo
/// `node.cmd` would run unsandboxed. This variable turns that lookup off.
/// Other platforms ignore it.
pub(super) const NO_CWD_EXE_LOOKUP_ENV: &str = "NoDefaultCurrentDirectoryInExePath";

/// Environment additions for every Codex child.
pub(super) fn child_env() -> HashMap<String, String> {
    HashMap::from([(NO_CWD_EXE_LOOKUP_ENV.to_owned(), "1".to_owned())])
}

/// SWARM's spawn-time trust dial for Codex — the same three wire tokens
/// as [`crate::agent::claude_code::ClaudeCodeTrustTier`], mapped onto
/// Codex's `approvalPolicy` + `sandbox` (see `policy`).
/// [`crate::agent::adapter::AgentSpawnSpec::permission_mode`] is parsed by `parse_trust_tier`,
/// which accepts only these tokens.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CodexTrustTier {
    /// Read-only: `untrusted` approvals + `read-only` sandbox.
    Restricted,
    /// Workspace writes, every non-trusted command asked about:
    /// `untrusted` approvals + `workspace-write` sandbox.
    Standard,
    /// Workspace writes, the model decides when to ask: `on-request`
    /// approvals + `workspace-write` sandbox.
    WriteEnabled,
}

impl CodexTrustTier {
    /// The tier's `approvalPolicy` and `sandbox`.
    pub(super) fn policy(self) -> (AskForApproval, SandboxMode) {
        match self {
            Self::Restricted => (AskForApproval::Untrusted, SandboxMode::ReadOnly),
            Self::Standard => (AskForApproval::Untrusted, SandboxMode::WorkspaceWrite),
            Self::WriteEnabled => (AskForApproval::OnRequest, SandboxMode::WorkspaceWrite),
        }
    }
}

/// Parses [`crate::agent::adapter::AgentSpawnSpec::permission_mode`]: `None` is
/// [`CodexTrustTier::Standard`]; anything outside the three tokens —
/// including Codex's own `"never"` — is refused rather than guessed at.
pub(super) fn parse_trust_tier(raw: Option<&str>) -> Result<CodexTrustTier, AppError> {
    match raw {
        None | Some("standard") => Ok(CodexTrustTier::Standard),
        Some("restricted") => Ok(CodexTrustTier::Restricted),
        Some("write_enabled") => Ok(CodexTrustTier::WriteEnabled),
        Some(other) => Err(AppError::PermissionDenied(format!(
            "unrecognized codex trust tier {other:?} — refusing to spawn rather than guess an \
             approval policy"
        ))),
    }
}

/// The model to request. `None`, a blank string and a Claude model name
/// (a provider-agnostic spawn form may carry one over) all omit `model`,
/// so Codex uses its configured default; `agent_session_started` then
/// reports the model the thread actually runs.
pub(super) fn requested_model(model: Option<&str>) -> Option<&str> {
    let model = model.map(str::trim).filter(|m| !m.is_empty())?;
    let lower = model.to_ascii_lowercase();
    if CLAUDE_MODEL_ALIASES.contains(&lower.as_str()) || lower.starts_with("claude") {
        tracing::warn!(
            model,
            "codex adapter: ignoring a Claude model name, using Codex's default model"
        );
        return None;
    }
    Some(model)
}

/// Refuses a thread whose applied policy is more permissive than the one
/// requested. The server reports what it actually applied; a stricter
/// result (for example a managed configuration forcing `readOnly`) is
/// fine, a looser one — `dangerFullAccess`, `externalSandbox`, `never`,
/// a granular policy — is not. This is what catches a request field the
/// server silently ignored.
pub(super) fn verify_effective_policy(
    opened: &ThreadOpened,
    approval: AskForApproval,
    sandbox: SandboxMode,
) -> Result<(), AppError> {
    let effective_sandbox = opened.sandbox.kind.as_str();
    let sandbox_ok = match sandbox {
        SandboxMode::ReadOnly => effective_sandbox == "readOnly",
        SandboxMode::WorkspaceWrite => matches!(effective_sandbox, "readOnly" | "workspaceWrite"),
    };
    let effective_approval = opened.approval_policy.as_str();
    let approval_ok = match approval {
        AskForApproval::Untrusted => effective_approval == Some("untrusted"),
        AskForApproval::OnRequest => matches!(effective_approval, Some("untrusted" | "on-request")),
    };
    if sandbox_ok && approval_ok {
        return Ok(());
    }
    Err(AppError::PermissionDenied(format!(
        "codex opened the thread with sandbox {effective_sandbox:?} and approval policy {} \
         instead of the requested {:?} / {:?} — refusing to run it",
        opened.approval_policy,
        sandbox.effective_type(),
        approval.as_str(),
    )))
}

/// What this adapter can honestly promise.
pub(super) fn codex_capabilities() -> Capabilities {
    Capabilities {
        // item/agentMessage/delta and the reasoning deltas.
        partial_deltas: true,
        // thread/resume.
        resume: true,
        // Token usage arrives as thread/tokenUsage/updated and rides the turn's
        // settlement; Codex never reports a dollar figure.
        native_cost: false,
        permission_modes: vec![
            "restricted".to_string(),
            "standard".to_string(),
            "write_enabled".to_string(),
        ],
        // turn/interrupt stops the turn and keeps the thread.
        cancel_granularity: CancelGranularity::Graceful,
        // A message sent while a turn runs is queued by the scheduler for
        // the next turn; nothing is injected into the running one.
        interrupt_midturn: false,
        // `cwd` is a thread/start parameter.
        worktree_aware: true,
        // Approvals are server requests answered on the wire.
        interactive_permissions: true,
    }
}
