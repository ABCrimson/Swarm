# ADR-0017: Codex is driven over the verified app-server protocol

- **Status:** Accepted (supersedes the 2026-08-15 authored protocol)
- **Date:** 2026-09-23

## Context

`codex app-server` is a stateful, bidirectional JSON-RPC 2.0 protocol: the client sends requests with
ids, the server sends notifications for streaming and lifecycle, and the server can send the client its
own id-bearing request mid-turn that blocks until answered (an approval). It is the structural opposite
of Claude Code's one-way NDJSON, and `CodexAdapter` shipped (2026-08-15) with no change to either trait
method's signature, the check that the trait survives a different protocol family. The one addition was
a new field, `Capabilities::interactive_permissions`.

That first cut was written when Codex was not installed on the build machine, so its method names and
parameter shapes (`thread/sendMessage`, `approval/request`, `sandboxPolicy`, and others) were authored
by extrapolation from three method names in a plan. It could not drive a real server. One consequence
was a security defect: the sandbox went out under a key the server ignored, so a read-only thread ran
under the user's default sandbox. A review also found a wire-order dependency (settling a turn depended
on a response arriving before the terminal notification, which JSON-RPC does not guarantee) that
produced zero `agent_turn_settled` events for a turn that completed.

## Decision

Rewrite against the schema codex-cli 0.156.1 generates (`codex app-server generate-json-schema` and
`generate-ts`), with the handshake, thread-open, resume, interrupt and stdin-EOF behaviour checked
against a live 0.156.1 server (no model turns):

- `initialize {clientInfo, capabilities}` must be the connection's first request (anything else is
  answered `-32600 Not initialized`), followed by the `initialized` notification. Unused notifications
  are opted out of.
- `thread/start`, or `thread/resume` for `AgentSpawnSpec::resume`, carries `cwd`, the tier's
  `approvalPolicy`, the sandbox under the key **`sandbox`**, and `model` only when one was asked for
  (a Claude alias is never forwarded). The response reports the applied policy; anything more
  permissive than requested refuses the session. The thread id is the `SessionKey`.
- `turn/start {threadId, input}` is acknowledged with the turn, whose id is the `TurnId`. Items stream
  as `item/started`, deltas, `item/completed`; `turn/completed` carries the terminal status
  (`completed` settles ok; `failed` and `interrupted` settle error). A completion that overtakes its
  acknowledgement settles exactly once.
- Approvals arrive as the server's own requests (`item/commandExecution/requestApproval`,
  `item/fileChange/requestApproval`, `item/permissions/requestApproval`), are surfaced as pending
  `agent_permission_request`, and are answered by `respond_permission` as a real round trip. A request
  the server later withdraws (`serverRequest/resolved`) is dropped. Every other server request is
  answered `-32601`; none is left unanswered, because the server blocks the turn.
- Cancel is `turn/interrupt` (graceful; the thread survives); `resume` is `thread/resume`.
  Capabilities say so. `native_cost` is `false`: usage is token counts, never a dollar figure.
- Shutdown closes stdin, which app-server treats as a request to exit; the child is killed only after a
  grace period. Bounds: handshake 30 s, turn acknowledgement 30 s, other requests 10 s, interrupt
  settle 10 s, graceful exit 3 s, probe 5 s per subprocess.
- The binary is resolved over absolute `PATH` entries only, with no bare-name fallback (see
  [0038](0038-agent-provider-trust-model.md)); on Windows the `codex.cmd` npm shim is resolved through
  `PATHEXT`.

## Consequences

- The adapter is tied to a verified server release (`VERIFIED_CODEX_VERSION`, 0.156.1); serde ignores
  fields it does not read, so a newer server that only adds fields stays compatible.
- A thread is persisted by Codex only once it ran a turn; resuming one that never did fails with the
  server's `no rollout found`.
- A turn whose `turn/start` is never acknowledged has no id to settle, so its `send_turn` fails instead
  of hanging. Once teardown begins, nothing but its own settlement and `agent_session_exited` is
  emitted, so no event follows the exit.
- `never` and `danger-full-access` stay unconstructible ([ADR-0015](0015-trust-tiers-closed-vocabulary.md)).
- The fixtures are scripts authored from the generated schema and played by an ESM fake app-server that
  enforces `Not initialized` and records the adapter's wire traffic.

See [Adapter Layer](../architecture.md#adapter-layer).
