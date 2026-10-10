# ADR-0025: A single-instance lock on the data directory

- **Status:** Accepted
- **Date:** 2026-08-15

## Context

Two engines opening the same `swarm-events.db` would both resume `seq` from `max_seq()` and collide on
the primary key: appends would fail while live emission kept handing out duplicate seqs. With a
desktop app and a daemon that resolve the same data directory (`swarmd` deliberately uses the desktop
bundle identifier's directory), a second process is easy to start by accident.

## Decision

`Runtime::start` takes `SingleInstanceLock::acquire(data_dir, shell_name, bind)` as its **first**
action, before the event log is opened; whichever process starts second refuses to touch the directory.

- `daemon.lock` is the mutex: opened with shared access, then locked exclusively for the life of the
  process with std's `File::try_lock`, which is `flock(LOCK_EX | LOCK_NB)` on Unix and a `LockFileEx`
  byte-range lock on Windows. The OS releases it on exit or crash, so there is no stale-lock cleanup
  and no PID polling. The guard also unlocks explicitly on drop: on Unix a `flock` belongs to the open
  file description, which every child forked while the lock is held (a PTY, git or agent CLI process)
  shares until its exec closes the close-on-exec copy.
- `daemon.lock.json` is informational (pid, which shell, bind address, start time), rewritten after
  every acquire. A losing contender reads it to name who holds the directory ("SWARM Is Already
  Running …"), best effort; it is never consulted to decide whether the lock is held.

## Consequences

- The desktop app shows the message in a dialog and exits; `swarmd` exits with status 75, and its
  systemd unit treats 75 as "do not restart" (`RestartPreventExitStatus=75`).
- The runtime keeps the lock until it is dropped, past `Runtime::shutdown`.
