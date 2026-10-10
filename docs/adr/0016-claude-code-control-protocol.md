# ADR-0016: Claude Code is driven over the stream-json control protocol

- **Status:** Accepted (supersedes the 2026-08-14 spawn-time-only design)
- **Date:** 2026-09-23

## Context

The first adapter (2026-08-14) was built from a measurement spike on `claude` 2.1.232 and concluded:

- `--permission-mode manual` was a silent no-op in `-p` mode, so an interactive
  `agent_permission_request` round trip was "not buildable". `respond_permission` was a documented
  no-op, every permission request was a report of a denial already made, and
  `interactive_permissions` was `false`.
- The only cancel lever was killing the process (`KillOnly`, about 43 ms, with no graceful path on
  Windows).
- `system/init` was expected on spawn.

Against real 2.1.28x CLIs this was wrong in practice: the CLI writes nothing, not even `system/init`,
until it receives the first user message, so every real spawn timed out waiting for init.

The same spike did produce lasting findings: stdin close is not a cancel; `--allowedTools` is an
auto-approve list that does not restrict (Condition C of
[ADR-0013](0013-provider-adapter-trait-pair.md)); one process handles many turns, each with its own
`system/init` and terminal `result` while `session_id` stays stable, so one child serves a whole
session and `--resume` only rehydrates a session whose process is gone; and a first cut that wrote
`<cwd>/.claude/settings.json` into the worktree would have been committed by the ship chain, kept the
worktree dirty so removal refused forever, and clobbered a human's file. The settings now travel as an
inline `--settings '<json>'` value with `--setting-sources project`.

## Decision

Rewrite the adapter for the control protocol of 2.1.28x (oldest supported CLI 2.1.259):

- **Handshake.** Every session opens with the `initialize` control request and waits (30 s) for its
  `control_response`, which costs no API call and reports models, account and active permission mode.
  It fails closed on an unexpected permission mode. `probe` runs the same handshake plus
  `get_binary_version` in a throwaway process (15 s bound) and reports a signed-out or outdated CLI as
  unavailable; the account email is never kept.
- **Interactive permissions.** `--permission-prompt-tool stdio` makes the CLI send a `can_use_tool`
  control request and block. The session surfaces it as a pending `agent_permission_request` (no
  suggested decision) and answers from `respond_permission`; an ask nobody answers is denied after
  10 minutes. An ask that requires the CLI's own dialog (such as `AskUserQuestion`) is denied at once
  and reported as a denial. Denials the CLI decides itself (deny list, `dontAsk`, redirection guard)
  are reported with `suggestedDecision: Deny` from `system/permission_denied`, reconciled against the
  authoritative `result.permission_denials`. `interactive_permissions` is `true`.
- **Cancel.** The `interrupt` control request; the CLI aborts the turn and writes its `result`
  ("Turn Cancelled") while the session stays usable. The process is killed only if no acknowledgement
  arrives in 5 s or no result in a further 10 s. `cancel_granularity` is `Graceful`.
- **Turn ownership.** Each prompt is written with the SWARM turn id as its `uuid`, which the CLI
  echoes (`command_lifecycle`, `user_message_uuid`). Frames of turns SWARM did not start (a
  background-task notice, a scheduled wake-up, a resumed session's leftovers) are dropped, and
  background tasks are switched off for the child. Subagent frames carry `parent_tool_use_id` and are
  kept out of the transcript.
- **Teardown** runs once, in its own task: an idle session closes stdin and lets the CLI exit (3 s
  grace), a busy one is killed, and an in-flight turn gets a synthesised settlement.
- Stdin writes run on a dedicated thread, never on a Tokio worker.

## Consequences

- Delta granularity is sentence-clause (4 to 6 deltas per response), coarser than the webview SDK's
  token stream.
- Cost is derived from the CLI's running total; a killed turn loses cost data.
- `interrupt_midturn` stays `false`: the CLI could fold a message into a running turn, but a session
  rejects `send_turn` while busy and the scheduler serialises turns.
- Fixtures are ESM scenario modules for one fake CLI that plays the real ordering.

See [Adapter Layer](../architecture.md#adapter-layer).
