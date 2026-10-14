# ADR-0038: Agent sessions trust no repo configuration; the provider CLI is found only on absolute PATH entries

- **Status:** Accepted (supersedes the `--setting-sources project` part of [0015](0015-trust-tiers-closed-vocabulary.md) and [0016](0016-claude-code-control-protocol.md))
- **Date:** 2026-10-13

## Context

A worker's session runs the provider CLI inside a repo SWARM did not write, often one it has never
seen. Claude Code with `--setting-sources project` (ADR-0015, ADR-0016) loaded that repo's
`.claude/settings.json`. A review of the adapters measured what that costs on `claude` 2.1.296, using
only the free control requests (`initialize`, `get_settings`) so no model turn ran:

- A repo `apiKeyHelper` **ran** during the `initialize` handshake, before any approval, and a repo
  `env` block was applied (`ANTHROPIC_BASE_URL` redirects the CLI and the user's credentials with it;
  `CLAUDE_CODE_USE_BEDROCK` switched the reported provider). `disableAllHooks` stops neither.
- Repo `.claude/agents/*.md` loaded in Standard but not under `--restricted`.
- Repo `permissions.allow` and `additionalDirectories` were ignored in an untrusted folder, and
  `defaultMode` was honored.
- `--setting-sources ""` loads none of this, while inline `--settings` still applies.

The probe had the same hole: it ran in `std::env::temp_dir()`, which is the shared `/tmp` on Linux,
so another local user's `/tmp/.claude/settings.json` ran its `apiKeyHelper` as the SWARM user whenever
the spawn dialog asked about a provider. The Restricted tier also left `EnterWorktree` reachable: the
CLI allows it without a `path` unasked in every mode (`dontAsk` only turns an "ask" into a denial),
and it creates a branch and a checkout under `<cwd>/.claude/worktrees/`. An empty `cwd` made the child
inherit SWARM's own directory (`/` for a macOS app opened from the Finder), which widened every
"working directory" limit to the whole disk. On Unix the spawn changes into the worktree before the
`execvp` search of `PATH`, so a relative or empty `PATH` entry resolved a binary the repo had
committed.

## Decision

**No repo settings load.** The probe and every Claude Code tier pass `--setting-sources ""`; the
inline `--settings` JSON is the session's only settings. SWARM itself reads
`<cwd>/.claude/settings.json` and takes only the `permissions.deny` string entries from it, appended
after the tier's deny list: a repo can narrow a session and nothing else. The appended entries are kept
in file order up to 8 KiB of JSON in total and the rest are dropped with a warning, because the
settings travel as one argv element and Windows caps one at about 32K characters. SWARM reads at most
1 MiB of the file: the read stops one byte past the cap, because the reported length cannot be trusted
(a symlink to `/proc/self/pagemap` reports a regular file of length 0 and then yields zeros without
end). A longer, unreadable, non-UTF-8 or non-object file contributes no entries and is logged.

**Deny lists.** Every tier denies `EnterWorktree` and `ExitWorktree`. Restricted also denies
`PowerShell` (the flag removes it; the entry is a second fence, like `Bash`), `DesignSync` (writes to
claude.ai design projects), `WebSearch` and `PushNotification` (send data out), so "Restricted" means
no writes and no outbound side effects. The inline settings also set `disableBypassPermissionsMode`
and `disableAutoMode` to `"disable"` (with them `--permission-mode auto` came back as `default`).

**The Bash patterns are a convenience fence.** Standard and WriteEnabled still deny `Bash(rm -rf*)`,
`Bash(git push --force*)`, `Bash(git push -f*)`, `Bash(git reset --hard*)` and `Bash(sudo*)`, but shell
spellings are unbounded (`rm -r -f`, `git push origin +main`) and PowerShell is not covered. The gate is
the permission mode plus the human: in `manual` every call the CLI does not auto-approve becomes a
`can_use_tool` ask, and `acceptEdits` additionally auto-approves file edits and
`mkdir`/`touch`/`rm`/`rmdir`/`mv`/`cp`/`sed` in the working directories (2.1.296 source). No more
patterns are added.

**A private probe directory.** Each probe runs in a fresh `swarm-claude-probe-<uuid>` directory under
the temp root, created non-recursively (it fails rather than reuse an existing path) with mode `0700`
on Unix, and removed when the probe returns.

**Absolute working directory.** Both adapters refuse a spawn whose `cwd` is empty, relative, missing or
not a directory ("Agent Session Needs An Absolute, Existing Working Directory") before building any
argv.

**Absolute PATH only.** Both adapters resolve the CLI over the absolute entries of `PATH` and nowhere
else: relative and empty entries are skipped, the current directory is never searched, and nothing
found is "Not Found On PATH" at probe and a spawn error, never a bare name for the OS to search. Claude
looks for an executable `claude` (Unix) or `claude.exe` (Windows); an npm `claude.cmd` shim maps to the
`node_modules/@anthropic-ai/claude-code/bin/claude.exe` beside it, since the shim itself is never run.
Codex uses the same rule (an executable `codex` on Unix; on Windows the `PATHEXT` lookup, which finds the npm `codex.cmd` shim) and no longer falls back to the bare name. The Claude adapter caches the resolution: a probe resolves
afresh, a spawn reuses it.

## Consequences

- **A Standard or WriteEnabled worker no longer receives the repo's `CLAUDE.md`, `.claude/rules`,
  `.claude/skills` or the `AGENTS.md` walk.** The 2.1.296 CLI gates project memory on the
  `projectSettings` source; this is read from the CLI source, not verified at runtime. Feeding that text
  back (for example in the first prompt) is the owner's decision and is not done here. Repo
  `.claude/agents` and the repo's `permissions.ask` no longer load either.
- The Agent tool's `isolation: "worktree"` creates a worktree too, and no deny rule short of denying
  `Agent` blocks it. It is a known gap.
- Not tested on a CLI older than 2.1.296. An older CLI that rejects `--setting-sources ""` fails the
  probe or the handshake, which is closed.
- A repo agent's `permissionMode` could raise a subagent's mode (read in the CLI source, not verified
  at runtime); with no repo agents loaded this cannot arise from the repo.
- The probe directory is removed after the probe returns. If the probe future is dropped first, the
  directory stays: a synchronous drop guard would block a Tokio thread, and the only caller sets no
  timeout. Its contents are empty, since nothing is configured to write there.
- Codex repo-config trust, measured on codex-cli 0.163.0-alpha.5 via `config/read`: with a fresh
  `CODEX_HOME` and no trust entry, the project layer (`.codex/config.toml`) is listed but disabled
  ("To load project-local config, hooks, and exec policies, add <dir> as a trusted project in
  <CODEX_HOME>/config.toml"), and its model and `approval_policy` were not applied. SWARM does not
  rely on this beyond the tier policy check it already makes. Not checked: behavior once the user
  trusts the project, and whether trust is keyed by cwd or by git root.
- Probe and spawn can still resolve different binaries if a `PATH` directory changes between them; the
  cache narrows that for Claude, and changing a `PATH` directory already needs the user's own write
  access.
