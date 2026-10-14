# ADR-0038: A kill stops the provider session first, behind a closing fence

- **Status:** Accepted
- **Date:** 2026-10-13

## Context

`kill_worker` used to remove the worker, reap its shell and `git worktree remove` its checkout, and
only then shut down the worker's agent session. An approved provider turn kept running against a
checkout that was being removed. An attach racing the kill (`agent_spawn`'s handshake takes up to
30 s) noticed the kill only after its handshake, so `kill_worker` could return while that attach's
provider process was still alive. Nothing marked the worker as being killed, so a new attach or turn
in that window was accepted.

## Decision

- **The session goes before the worker.** `kill_worker` runs, in order: mark the worker closing and
  wait for attaches in flight; remove and shut down the session (the provider process is stopped and
  reaped; a failed shutdown is logged and never changes the kill's result); `do_kill_worker` (shell,
  then worktree, unchanged); clear the mark.
- **A per-worker fence in `AgentSessionRegistry`.** An attach holds an `AttachPermit`
  (`begin_attach`) from before its handshake until it has registered its session through
  `AttachPermit::insert`, the only registration path. `begin_close` marks the worker closing, then
  waits on a `tokio::sync::watch` count until every permit has dropped, and returns a `ClosingGuard`
  that clears the mark on drop, also when the kill is cancelled. A closing count, not a flag, lets
  overlapping kills of one worker each clear only their own mark.
- **Closing is a typed refusal.** While closing, `begin_attach`, `AttachPermit::insert`, `get` and
  `ensure_open` fail with `AppError::WorkerClosing` (``Worker `<id>` Is Closing``), so a new attach,
  `agent_send_turn` admission, turn dispatch, `agent_cancel` and `agent_permission_respond` are
  refused. An attach whose registration is refused shuts its own session down while still holding
  its permit, so its `agent_session_exited` precedes `worker_killed`.
- **`Runtime::shutdown`** stops each worker's session the same way (close, drain, remove, shut down)
  inside its existing timeout, without killing the worker.

[ADR-0008](0008-worktree-removal-never-forces.md) stays in force: the worktree step is unchanged, and
stopping the provider first also means no provider process holds the checkout as its cwd during
removal.

Pinned by `test_kill_worker_stops_the_provider_session_before_removing_the_worktree`,
`test_kill_worker_preserves_a_dirty_worktree_with_a_session_attached` (`commands/worker.rs`),
`test_attach_and_turn_admission_are_refused_while_the_worker_is_closing`,
`test_kill_worker_returns_only_after_an_attaching_session_has_exited`,
`test_agent_spawn_shuts_down_a_session_whose_worker_is_killed_during_attach`,
`test_agent_spawn_reports_no_worker_when_attach_fails_after_a_kill` (`commands/agent.rs`), the fence
tests in `agent/registry.rs`, and
`test_execute_turn_for_a_closing_worker_synthesizes_an_error_receipt` (`runtime.rs`).

## Consequences

- When `kill_worker` returns, no session of the worker is registered or still handshaking.
- A kill can take as long as an attach in flight: the adapter's handshake bound (30 s for Claude Code
  and Codex) plus that attach's own session teardown.
- During a kill, cancelling a turn or answering a permission request for that worker fails with
  `WorkerClosing`; the kill's session shutdown settles any turn in flight. A turn still queued settles
  as an error receipt when dispatched.
- The fence covers kills that go through `kill_worker`. `do_kill_worker` itself knows nothing of
  sessions, so a future caller of it must close the worker first.

See [Workers and PTYs](../architecture.md#workers-and-ptys).
