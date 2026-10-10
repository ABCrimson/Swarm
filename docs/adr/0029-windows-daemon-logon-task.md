# ADR-0029: The Windows daemon is a per-user logon Scheduled Task

- **Status:** Accepted
- **Date:** 2026-08-15 (corrected 2026-09-23)

## Context

`swarmd` runs worker agents as the user and touches the user's `%APPDATA%` and repositories. It needs
to stay up across sessions and restart after a crash. A Windows service (SYSTEM or a service account)
would run it with the wrong identity and a different profile, and elevated, which is the opposite of
what a daemon that executes agent-issued commands should be. Other platforms get the equivalent: a
`systemd --user` unit and a launchd LaunchAgent.

## Decision

On Windows, `install.ps1` registers a **per-user logon Scheduled Task** named `SWARM Daemon (swarmd)`.
It is not a Windows service. It runs in the installing user's interactive session, non-elevated
(`RunLevel Limited`), loopback-only (no `--bind`), and starts at that user's logon. The unit files on
Linux and macOS are likewise user-level, non-elevated and loopback-only by default.

Details that were learned by running it:

- `ExecutionTimeLimit` 0, because the default 72 hours stopped the daemon after three days and a stop
  is not a failure, so it never restarted. Normal priority (the default is below normal and every
  worker inherits it), `MultipleInstances IgnoreNew`, and a logon trigger scoped to the installing
  user.
- The task runs `conhost --headless swarmd.exe --log-file …` rather than a PowerShell wrapper with
  stream redirection (UTF-16 output, error records, and Task Scheduler managing the wrapper instead of
  `swarmd`).
- Upgrade and uninstall stop the task and the running `swarmd.exe` first, since a running executable
  cannot be overwritten; the new binary is staged beside the old one and moved into place.
- Scripts are ASCII only: Windows PowerShell 5.1 reads a BOM-less script in the ANSI code page.
- The connect URL comes from `swarmd connect-url`, never from a log. Linux units pass the installing
  shell's `PATH` so `claude` and `codex` are found, and use `RestartPreventExitStatus=75`; sandboxing
  directives are left out because workers inherit them.

## Consequences

- The daemon does not run before the user logs on, and not while they are logged off. A boot-start
  daemon would need a different design and a deliberate decision about identity.
- Documentation must say "logon Scheduled Task", never "Windows service".

See [daemon.md](../daemon.md) and [Runtime Modes](../architecture.md#runtime-modes).
