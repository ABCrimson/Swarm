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
  reaped; a failed shutdown is logged and never changes the kill's result); wait for any other
  shutdown of that session still running; `do_kill_worker` (shell, then worktree, unchanged); clear
  the mark, which travels into the blocking kill task so a cancelled kill cannot clear it early.
- **A per-worker fence in `AgentSessionRegistry`.** An attach holds an `AttachPermit`
  (`begin_attach`) from before its handshake until it has registered its session through
  `AttachPermit::insert`, the only registration path. `begin_close` marks the worker closing, then
  waits on a `tokio::sync::watch` count until every permit has dropped, and returns a `ClosingGuard`
  that clears the mark on drop, also when the kill is cancelled. A closing count, not a flag, lets
  overlapping kills of one worker each clear only their own mark.
- **Every session stop is counted.** A session leaves the registry only through `take_session`,
  which removes it and counts a `SessionStop` under the worker's fence; the stop derefs to the
  session and is dropped once its shutdown ends. `wait_stopped` waits for the count to reach zero,
  so a second kill, or a kill racing `agent_shutdown`, never touches the worker while the first
  shutdown is still running.
- **Closing is a typed refusal.** While closing, `begin_attach`, `AttachPermit::insert`, `get` and
  `ensure_open` fail with `AppError::WorkerClosing` (``Worker `<id>` is closing``), so a new attach,
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
`test_agent_spawn_reports_no_worker_when_attach_fails_after_a_kill` (`commands/agent.rs`),
`test_a_second_kill_waits_for_the_first_kills_session_shutdown`,
`test_kill_worker_waits_for_an_agent_shutdown_in_progress` (`commands/worker.rs`), the fence tests in
`agent/registry.rs`, and
`test_execute_turn_for_a_closing_worker_synthesizes_an_error_receipt` (`runtime.rs`).

## Consequences

- When `kill_worker` returns, no session of the worker is registered, still handshaking or still
  shutting down.
- A kill can take as long as an attach in flight: the adapter's handshake bound (30 s for Claude Code
  and Codex) plus that attach's own session teardown. That is longer than `swarmd`'s 10 s
  `STOP_WORKERS_TIMEOUT`, so a daemon stop can give up on a kill still waiting on an attach and exit
  with that attach's provider process alive; raising that timeout, and a kill-on-drop guard around the
  Claude Code handshake so the attach can be abandoned, are open follow-ups outside this decision.
- A kill dropped mid-shutdown (its future cancelled, as a `swarmd` stop that times out does) releases
  its `SessionStop` at once, while the Claude Code teardown may still be reaping the process, so a
  second kill's `wait_stopped` can return before that process is gone. This belongs to the same open
  follow-ups.
- During a kill, cancelling a turn or answering a permission request for that worker fails with
  `WorkerClosing`; the kill's session shutdown settles any turn in flight. A turn still queued settles
  as an error receipt when dispatched.
- The fence covers kills that go through `kill_worker`. `do_kill_worker` itself knows nothing of
  sessions, so a future caller of it must close the worker first.

See [Workers and PTYs](../architecture.md#workers-and-ptys).
