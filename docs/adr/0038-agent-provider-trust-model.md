# ADR-0038: Agent sessions trust no repo configuration; the provider CLI is found only on absolute PATH entries

- **Status:** Accepted (supersedes the `--setting-sources project` part of [0015](0015-trust-tiers-closed-vocabulary.md) and [0016](0016-claude-code-control-protocol.md))
- **Date:** 2026-10-13

## Context

A worker's session runs the provider CLI inside a repo SWARM did not write, often one it has never
seen. Claude Code with `--setting-sources project` (ADR-0015, ADR-0016) loaded that repo's
`.claude/settings.json`. A review of the adapters measured what that costs on `claude` 2.1.296, using
only the free control requests (`initialize`, `get_settings`) so no model turn ran; on 2.1.318
(2026-11-04) the `apiKeyHelper`, `env`, agent, skill and `permissions.allow` results held with the same
requests plus `get_binary_version`:

- A repo `apiKeyHelper` **ran** during the `initialize` handshake, before any approval, and a repo
  `env` block was applied (`ANTHROPIC_BASE_URL` redirects the CLI and the user's credentials with it;
  `CLAUDE_CODE_USE_BEDROCK` switched the reported provider). `disableAllHooks` stops neither.
- Repo `.claude/agents/*.md` and `.claude/skills` loaded in Standard. That agents did not load under
  `--restricted` was measured on 2.1.296 alone.
- Repo `permissions.allow` was ignored in an untrusted folder. On 2.1.296 alone, `additionalDirectories`
  was ignored too and `defaultMode` was honored.
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
settings travel on the command line and Windows caps the whole command line at 32,767 characters; 8 KiB
still fits (about 13 KiB in the worst case). SWARM uses at most
1 MiB of the file: the read stops one byte past the cap to tell a file of exactly 1 MiB from a longer
one, because the reported length cannot be trusted (a symlink to `/proc/self/pagemap` reports a
regular file of length 0 and then yields zeros without end). A longer, unreadable, non-UTF-8 or
non-object file contributes no entries and is logged.

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
Codex uses the same rule (an executable `codex` on Unix; on Windows the `PATHEXT` lookup, which finds
the npm `codex.cmd` shim) and no longer falls back to the bare name. The Claude adapter caches the
resolution: a probe resolves afresh, a spawn reuses it.

## Consequences

- **A Standard or WriteEnabled worker no longer receives the repo's `CLAUDE.md`, `.claude/rules` or
  `.claude/skills`.** The 2.1.296 CLI gates them on the `projectSettings` source: verified at runtime on
  Claude Code 2.1.296 (2026-10-13), where the exact Standard argv loaded none of them, planted agents or
  an `apiKeyHelper`, while `--setting-sources project` loaded all of them. `AGENTS.md` did not load under
  either setting, and its gating remains source-only. Feeding that text back (for example in the first
  prompt) is the owner's decision and is not done here. Repo `.claude/agents` and the repo's
  `permissions.ask` no longer load either.
- The Agent tool's `isolation: "worktree"` creates a worktree too, and no deny rule short of denying
  `Agent` blocks it. It is a known gap.
- The probe refuses any CLI older than 2.1.318 ("Claude Code 2.1.318 Or Newer Required"), the newest
  release this boundary was measured on. That includes Claude Code's `stable` channel (2.1.311 on
  2026-11-04, npm dist-tags) until it reaches 2.1.318. Measured 2026-11-04 on `claude` 2.1.318 with
  SWARM's exact probe, Standard, WriteEnabled and Restricted argv, in a directory with a planted
  `.claude/settings.json` (one run: an `apiKeyHelper` that writes a marker; one run: `env`
  `CLAUDE_CODE_USE_BEDROCK=1`), a planted agent, skill, rule and `CLAUDE.md`. In all eight runs no
  marker was written, `apiProvider` stayed `firstParty`, `initialize` listed neither the planted agent
  nor the planted skill, and `get_settings` listed only `flagSettings`. The same argv with
  `--setting-sources project` ran the helper (`apiKeySource: "apiKeyHelper"`), switched the provider
  to `bedrock`, and listed the agent, the skill and `projectSettings`. `CLAUDE.md` and `.claude/rules`
  gating needs a model turn and is verified only on 2.1.296.
- A repo agent's `permissionMode` could raise a subagent's mode (read in the CLI source, not verified
  at runtime); with no repo agents loaded this cannot arise from the repo.
- The probe directory is removed before `probe()` returns. If the probe future is dropped first, a drop
  guard removes it on the blocking pool, concurrently with the kill and reap of the probe's `claude`
  child, retrying for about 5 s while that child still holds it as its working directory.
- A same-user process could swap `.claude/settings.json` for a FIFO between the metadata check and the
  open, and the read would then block on that spawned task; this is accepted because it needs same-user
  write access to the worktree.
- Codex repo-config trust, measured on codex-cli 0.163.0-alpha.5 via `config/read`: with a fresh
  `CODEX_HOME` and no trust entry, the project layer (`.codex/config.toml`) is listed but disabled
  ("To load project-local config, hooks, and exec policies, add <dir> as a trusted project in
  <CODEX_HOME>/config.toml"), and its model and `approval_policy` were not applied. SWARM does not
  rely on this beyond the tier policy check it already makes. Codex workers run with a private
  `CODEX_HOME` with no `[projects]` trust entries (amendment of 2026-11-04), so a repo
  `.codex/config.toml` stays disabled for every worker whatever the operator trusts.
- Probe and spawn can still resolve different binaries if a `PATH` directory changes between them; the
  cache narrows that for Claude, and changing a `PATH` directory already needs the user's own write
  access.

## Amended 2026-10-14

The Claude adapter's `spawn` and `probe` futures are drop-safe. A `Process` holds its child in a drop
guard that kills and reaps it on the blocking pool, and `spawn` dismisses the guard only when the child
moves into the session's state, so a spawn future dropped mid-handshake leaves no running `claude`, no
registered session and no `agent_session_started` event. The probe directory has its own drop guard that
removes it on the blocking pool, retrying while the dying child may still hold it as its working
directory (Windows refuses to remove a directory that is a live process's cwd). This removes the leak the
bullet above used to accept. A caller dropped at any point after the process is created is covered too:
the child is guarded before it leaves the blocking task.

One gap remains and is accepted: a probe dropped during `private_probe_dir().await` can still leave an
empty directory, created after the drop and before any guard exists.

## Amended 2026-11-04: a private `CODEX_HOME` per Codex worker

A Codex worker inherited the operator's Codex home (`~/.codex`) and with it every MCP server that home
exposes: 12 on the measuring host by `mcpServerStatus/list` (2026-11-04), of which 3 are keys of
`mcp_servers`, four come from Codex plugins (cloudflare, context7, gitlab, vercel) and `codex_apps` is
built into the CLI, so no `mcp_servers` edit reaches them. A `-c 'mcp_servers={}'` override merges an
empty table into the loaded one: with it, `config/read` returned the same three keys.

Every Codex child now runs with `CODEX_HOME` at `<data dir>/codex-home/<worker id>`
(`crates/swarm-core/src/agent/codex/home.rs`). The home holds a Swarm-written `config.toml`, rewritten
at every spawn, with no `[mcp_servers]` table, no plugins and no `[projects]` trust entries, and a
`[features]` table that turns off `apps` (the built-in `codex_apps` connectors), `remote_plugin`,
`computer_use`, `browser_use` and `skill_mcp_dependency_install`, which codex-cli 0.168.0-alpha.1
enables by default, and, when the operator is signed in through a file, a copy of the operator's
`auth.json` (copied when missing or older than the source, kept when newer). Codex keeps its own state
there, so `thread/resume` finds a worker's threads; `kill_worker` deletes the home once the worker is
gone (`CodexAdapter::remove_worker_home`), the `auth.json` copy included.
An adapter built without a data directory refuses to spawn rather than fall back to the operator's
home. The fs commands deny every path under `<data dir>/codex-home/`
([ADR-0035](0035-ai-tool-approval-and-fs-scope.md)).

Evidence, codex-cli 0.168.0-alpha.1, 2026-11-04: with `CODEX_HOME` at an empty directory, `config/read`
returned no `mcp_servers` keys and `mcpServerStatus/list` returned an empty list; the operator's home
returned 3 keys and 12 servers. Limits of that evidence:

- The 0 servers were measured only without a login (no `auth.json` in the private home). In an empty
  home `codex features list` reports those five and `plugins` on; in a home holding only Swarm's
  `config.toml` the five read `false`. Whether a signed-in worker still gets a server the CLI builds
  in is not measured; a signed-in rerun needs the owner's go-ahead.
- User skills under `~/.agents/skills` are outside `CODEX_HOME` and still load in every worker at any
  tier (`skills/list` returned 63 user-scope skills). Skill isolation is an owner question.
- Not run: a token refresh inside a private copy; the installed CLI reports "refresh token was already
  used", so one refresh may invalidate the operator's and the other homes' copies.
