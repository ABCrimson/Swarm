# ADR-0015: Trust tiers are a closed vocabulary

- **Status:** Accepted; the `--setting-sources project` part is superseded by [0038](0038-agent-provider-trust-model.md)
- **Date:** 2026-08-14 (Claude Code), 2026-08-15 (Codex); the Codex mapping was corrected 2026-09-23

## Context

Each provider has its own permission dial: Claude Code's `--permission-mode` values, Codex's
`approvalPolicy` and `sandbox`. Passing them through lets a spawn request name any of them, including
the ones that switch the safety net off (`bypassPermissions`, `approvalPolicy: "never"`,
`sandbox: "danger-full-access"`).

## Decision

`AgentSpawnSpec::permission_mode` is parsed through a closed three-token vocabulary, `restricted`,
`standard` and `write_enabled`, that fails closed on anything else, including a provider's raw mode
names. Absent means `standard`. Each adapter maps the tiers onto its provider:

| Tier | Claude Code | Codex |
| --- | --- | --- |
| `restricted` | `--restricted`, `--permission-mode dontAsk`, deny list for `Bash`, `Write`, `Edit`, `NotebookEdit` | `untrusted` approvals, `read-only` sandbox |
| `standard` | `--permission-mode manual`, deny list of destructive Bash patterns | `untrusted` approvals, `workspace-write` sandbox |
| `write_enabled` | `--permission-mode acceptEdits`, the same Bash deny list | `on-request` approvals, `workspace-write` sandbox |

The dangerous values are **unconstructible**, not checked: no tier variant maps to
`bypassPermissions`, and Codex's `AskForApproval` and `SandboxMode` types have no variants for `never`
or `danger-full-access`, so no code path can put them on the wire. Tests prove it argv-side.

## Consequences

- Provider-specific modes that fall between the tiers are not available.
- Claude's deny list is passed as inline `--settings` JSON together with `--setting-sources project`
  ([ADR-0016](0016-claude-code-control-protocol.md)), never as a file.
- The Codex adapter verifies the policy the server reports it applied and refuses the session if it is
  more permissive than requested ([ADR-0017](0017-codex-app-server-protocol.md)).
