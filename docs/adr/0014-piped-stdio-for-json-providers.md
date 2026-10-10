# ADR-0014: Piped stdio, not a PTY, for JSON-protocol provider CLIs

- **Status:** Accepted
- **Date:** 2026-08-14

## Context

Workers' shells run on a pseudo-terminal (`portable-pty`, ConPTY on Windows). The provider CLIs speak
newline-delimited JSON on stdin and stdout. A PTY's line discipline echoes input, injects `\r` and can
inject ANSI escapes, any of which corrupts NDJSON framing.

## Decision

`worker/proc.rs::spawn_piped` runs a provider CLI over `Stdio::piped()`. It reuses the PTY path's
backpressure shape: a named `piped-out-<pid>` thread reads stdout into a bounded `mpsc(4096)`, a
framing task turns bytes into lines with `NdjsonFramer`, and a `piped-err-<pid>` thread drains stderr.
On Windows the child is created with `CREATE_NO_WINDOW`. `spawn_pty` stays the substrate for
interactive shells; `spawn_piped` is the only one a JSON provider may use.

The framer scans linearly (its `\n` search resumes from a cursor, so each byte is examined once) and
caps a line at `MAX_LINE_BYTES` (10 MiB): an unterminated line past the cap returns
`AppError::LineTooLong`, discards the rest of that line, and keeps parsing. The caller still treats it
as a session-level failure. `PipedHandle::kill_and_wait` closes stdin, kills and reaps only the child;
`stderr_tail` keeps the last 4 KiB of stderr so a provider's fatal startup message is recoverable.

## Consequences

- Provider stderr is captured, not shown in a terminal.
- Killing a provider kills the child only, not processes it started.
- The old Rust Anthropic client, SSE parser and queue (the `ai/` module) were deleted in the same
  change that introduced this ([ADR-0019](0019-webview-chat-beside-adapters.md)); the framer is the
  descendant of the SSE loop's line splitter.
