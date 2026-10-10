# ADR-0035: Webview AI tools need per-call approval; the file commands canonicalize and deny secrets

- **Status:** Accepted
- **Date:** 2026-10-10

## Context

The webview chat's built-in tools ran the moment the model requested them: a command typed into a
worker's terminal, a worker killed, a file read or written. Tool input is untrusted model output, and
anything the model reads (a file, a terminal) can steer it. Behind the tools, `read_file` and
`write_file` normalized paths lexically only, with no deny list, so a local caller could read
`swarm-config.json` (the Anthropic API key) or `daemon-token`. Three weaknesses surfaced in review of
the first approval gate: it sat in the tool runner, not the tool; a "session" grant meant any input
forever; and the prompt was a sentence interpolating model text, which a crafted value could spoof.

## Decision

**Approval, in `src/lib/tools.ts`.** `spawn_worker`, `kill_worker`, `run_command`, `read_file` and
`write_file` wait for the user inside their own `execute`, after the input validates, so
`toolRegistry.get(name).execute()` cannot act unapproved. `get_metrics` and the sandboxed custom tools
have no backend side effect and are not gated. Answers are Allow Once, Allow For Session and Deny.

- A session grant is keyed by tool, worker and the exact argument (the command string, the path as
  given, the worker id, the spawn name). It never releases another pending call, and `write_file`
  is never offered one.
- `ToolApprovalPrompt` shows the tool and every field of the validated input as escaped data:
  backslashes doubled, newline/CR/tab spelled out, other control, bidi and zero-width characters as
  `\uXXXX`, non-string values as canonical JSON, `write_file` also the byte size. A value over 500
  characters is cut on the raw value with a hidden-count, commands and paths are never cut, and the
  Allow buttons stay off until each cut value has been expanded.
- Stopping a turn or killing its worker denies the turn's pending tool calls: `runTurn` denies them
  when its abort signal fires, and `worker_killed` cancels the worker's turn.

**File commands, in `crates/swarm-core/src/commands/fs.rs`.** The path is canonicalized (for a write:
the parent and, when it exists, the target) and the scope and deny checks run on the real path. The
deny list is `swarm-config.json` and `daemon-token` (and names prefixed with them, such as
`.daemon-token.<rand>` and `.corrupt-<ms>` backups) in the data directory, compared case-insensitively,
and `~/.ssh`, `~/.gnupg`, `~/.aws`. On Windows a write is also refused for a file name with `:`
(alternate data streams), a trailing `.` or space, or a reserved device name. The lexical form only
chooses the error once canonicalization fails.

## Consequences

- Every machine-acting tool call interrupts the user once, unless an identical call was granted for
  the session. That is the price of an agent that can type into a shell.
- Approval is not a sandbox: an approved `run_command` runs with the user's rights, and a grant keyed
  by the path as given does not follow later changes to what that path resolves to.
- The Rust deny list is narrower than the webview `fs` plugin's static deny scope
  ([ADR-0030](0030-tauri-3-alpha-capability-scoped-fs.md)); the plugin only reaches dialog-picked paths.
- A hard link to a secret is not detected. The Windows 8.3 and stream cases have `#[cfg(windows)]`
  tests that run only on the Windows CI runner.
- `read_file` and `write_file` stay `Denied` over `swarmd`
  ([ADR-0021](0021-command-registry-remote-policy.md)).

See [Who Can Call What](../api.md#who-can-call-what) and [File System Commands](../api.md#file-system-commands).
