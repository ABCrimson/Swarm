# ADR-0033: Exit teardown in a cleanup hook; a per-command ACL

- **Status:** Accepted
- **Date:** 2026-10-10

## Context

[ADR-0028](0028-desktop-shell-registry-forwarders.md) ran `Runtime::shutdown` on `RunEvent::Exit`.
That event is skipped by `AppHandle::restart` on the main thread and by `exit`'s process-exit fallback,
so those paths lost the teardown and could leave a seq gap. Running the teardown with `block_on` panics
when the code is reached on a Tokio worker. Separately, the app's own commands had no ACL: nothing
named them in the capability file, so the webview's reach was not pinned.

## Decision

- **Teardown in a plugin hook.** `lifecycle.rs` registers the `swarm-lifecycle` plugin. Its
  `on_cleanup_before_exit` hook, which every exit path reaches, runs `Runtime::shutdown` once, guarded
  by a once-only `Teardown` flag. The work runs on a scoped helper thread through the Tokio handle
  captured at registration, so it is safe on a Tokio worker. The release-log guard is dropped last so
  the teardown's own lines are flushed.
- **A per-command ACL.** `commands/command_list.rs` is the one list of app command names. `commands!`
  and the `build.rs` `AppManifest::commands` both include it, so the forwarders and the generated
  `allow-<command>`/`deny-<command>` permissions cannot drift. `capabilities/default.json` grants one
  `allow-*` per command, and the `capability_contract` test `app_commands_are_granted_one_by_one` pins it.

## Consequences

- A new command needs a `command_list.rs` entry and its `allow-*` line, or the contract test fails
  (and the webview `invoke` is rejected).
- `exit` blocks the calling thread for up to 2.5 s of agent-session shutdown, then until the event
  writer has committed its backlog (at most 120 s; see the 2026-10-14 amendment to
  [ADR-0039](0039-event-log-flushes-every-commit.md)).
- ADR-0028's exit-teardown paragraph and its `restart` consequence no longer hold; the rest stands.

See [Desktop shell](../architecture.md#desktop-shell).
