# ADR-0028: The desktop shell is registry forwarders on one runtime

- **Status:** Accepted
- **Date:** 2026-09-23

## Context

The desktop shell had 35 hand-written `#[tauri::command]` wrappers that re-packed typed parameters into
JSON, dispatched through the registry, and deserialised the result back. They had drifted:
`session_remove_worker` dropped its `originWorker` and `causeSeq` provenance, and the contract test
compared names only by parsing `lib.rs` as text. Startup showed its "already running" error with a
blocking dialog on the main thread inside the event loop, which deadlocks on macOS, so a second launch
hung. `main.rs` built a Tokio runtime Tauri never used (async commands ran on a second one). Nothing
shut down on quit.

## Decision

- **Forwarders.** A `commands!` macro declares one private `#[tauri::command]` per registry command
  that hands the invoke's JSON arguments to `Registry::dispatch` untouched and returns the registry's
  result or error value untouched, plus the invoke handler and the name lists the contract tests compare
  with `Registry::keys()` and `NATIVE_ONLY`. Command names, argument keys and success values are the
  same as before; errors are the registry's own JSON, exactly what `swarmd` returns. Tests drive real
  IPC through `tauri::test`'s `MockRuntime` against a real swarm-core runtime and check every `invoke`
  in `src/lib/tauri.ts` against the handler.
- **One runtime.** `install_async_runtime` builds the process's single multi-thread Tokio runtime
  (threads named `swarm-tokio`) and installs it with `tauri::async_runtime::set`; an integration test
  proves Tauri and ambient tasks share it.
- **Startup.** The main window is created hidden and shown once swarm-core is running. `setup` never
  returns an error to Tauri: a start failure (another instance, an unopenable event log) is shown in a
  non-blocking dialog and the app exits from its callback.
- **Exit teardown.** On `RunEvent::Exit` the shell calls `Runtime::shutdown`: stop the metrics loop,
  shut every live agent session down (in-flight turns get their settled receipt), then drain the event
  writer, so the next start continues without a seq gap. Each of the two phases is budgeted 2.5 s, so
  the teardown takes about 5 s at most. PTY workers are not killed on quit and their worktrees are not
  touched.
- **Logging.** Release builds write JSON lines at `info` to `swarm-desktop.log` in the app log
  directory, rotated to `.log.1` past 8 MiB, via a dedicated writer thread that is flushed after the
  teardown. IPC spans are `debug` level and record no arguments.

## Consequences

- Breaking, error values only: `agent_spawn` and the ship commands used to wrap a plain-string
  registry error into an object; they now return the string, and `src/lib/tauri.ts` and `useShip`
  normalise both forms.
- The shell restarts only through `request_restart`: `AppHandle::restart` skips the exit event and
  with it the teardown. The app calls neither today.
- Dialog folder grants are mirrored into the fs scope so dot-entries are readable on macOS and Linux
  (`dialog_grants.rs`).

See [Desktop shell](../architecture.md#desktop-shell).
