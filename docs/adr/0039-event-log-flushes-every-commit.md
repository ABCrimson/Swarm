# ADR-0039: The event log flushes every commit

- **Status:** Accepted
- **Date:** 2026-10-13

## Context

[ADR-0003](0003-single-writer-ordered-event-log.md) says a crash never reuses a seq, and
[ADR-0034](0034-persist-before-emit-fails-closed.md) says anything a client saw live is in the log. The
log ran SQLite in WAL mode with `synchronous=NORMAL`. SQLite's documentation is explicit about what that
gives: "WAL mode is always consistent with synchronous=NORMAL, but WAL mode does lose durability", and
"A transaction committed in WAL mode with synchronous=NORMAL might roll back following a power loss or
system crash" (<https://sqlite.org/pragma.html#pragma_synchronous>). "Writers sync the WAL on every
transaction commit if PRAGMA synchronous is set to FULL but omit this sync if PRAGMA synchronous is set to
NORMAL" (<https://sqlite.org/wal.html>).

So under NORMAL the log survived a process crash, but after an OS crash or a power loss it could roll
back to an earlier state. That state could lack an event the engine had already emitted and lack the seq
block reservation that preceded it, so the restarted writer could reissue a seq a client had already
seen. Both documented guarantees were false for that failure.

Two more facts decide the setting:

- **macOS.** SQLite calls a plain `fsync()` unless `PRAGMA fullfsync` is on (the default is off). On macOS
  `fsync()` does not flush the drive's cache; `F_FULLFSYNC` does. The desktop app ships on macOS
  ([ADR-0037](0037-webkit-floor-and-macos-15-4.md)), so `synchronous` alone does not give power-loss
  durability there.
- **Rollback mode.** `init` only warns when a filesystem refuses WAL. In rollback mode SQLite documents
  "FULL is not necessarily durable across a power loss" and advises EXTRA, and "EXTRA is no different
  from FULL in WAL mode" (pragma documentation).

Measured cost (2026-10-13, WSL2 Ubuntu-26.04 on an Intel Core Ultra 9 290HX Plus, 3000 one-transaction
appends of a 392-byte payload plus a reservation per 1024 seqs, three runs each, EXTRA two (within run-to-run noise of FULL); details and the
reproduction command in [Event Log Persistence](../performance.md#event-log-persistence)):

| Directory | NORMAL | FULL (EXTRA measured the same) |
|-----------|--------|------|
| ext4 on the WSL2 VHD | 23-32k events/s, p50 about 7 µs | about 470-510 events/s, p50 about 2 ms, p99 5-6 ms, max up to 72 ms |
| `C:\` through 9p | 174-381 events/s, p50 2.3-3.1 ms | 229-260 events/s, p50 3.4-4.1 ms |

The native filesystems were measured on GitHub-hosted runners on 2026-10-14 (see the amendment at the end): APFS p50 0.75 ms and NTFS p50 3.37 ms at EXTRA.

## Decision

`EventLog::init` sets `PRAGMA synchronous = EXTRA` and `PRAGMA fullfsync = 1` on the writer connection,
reads both back (neither pragma echoes its value) and fails the open with `AppError::EventLog` unless
they read 3 and 1. In WAL mode EXTRA is FULL: each event append and each seq reservation is its own
committed transaction and syncs the `-wal` file before the writer goes on, so an event is on stable
storage before it is emitted and a block of seqs before its first seq is issued. `fullfsync` makes that
sync a `F_FULLFSYNC` on macOS and does nothing elsewhere. EXTRA also keeps the guarantee if WAL is ever
refused. Both pragmas are per connection and the read-only connections never commit, but they set `fullfsync`
too, so a final checkpoint run by whichever connection closes last flushes the same way. One limit
remains: if the filesystem refuses WAL, SQLite's directory sync after unlinking a rollback journal is
a plain `fsync()` on macOS.

Alternatives:

- **NORMAL (the previous setting).** Cheapest and consistent, but not durable across an OS crash or power
  loss, which breaks the two guarantees above. Rejected: the log is the replay source and the seq
  authority, so correctness comes before throughput.
- **FULL alone.** Durable in WAL mode on Linux and Windows, but not on macOS without `fullfsync`, and not
  necessarily durable if WAL is refused. Rejected.
- **EXTRA with `fullfsync`.** Chosen. The measured cost equals FULL's in WAL mode.
- **Group commit under FULL/EXTRA.** The writer drains every queued command, appends its persistent
  events in one transaction (one flush), then emits them in seq order: the same guarantee, and a burst of
  N costs one flush. Not done here. The gate for adding it: a p50 per
  commit above 5 ms on macOS (APFS, `F_FULLFSYNC`) or native Windows NTFS. It was not reached (see the
  last amendment).

## Consequences

- An appended (committed) event and a seq reservation survive a process crash, an OS crash and a power
  loss, provided the storage honours fsync/flush. Not guaranteed: a drive or filesystem that lies about
  flushes, and an event whose append had not committed (it was never emitted either).
- Persist-before-emit is an ordering, not an atomic transaction with the effect an event describes. A PTY
  write, a git push or a provider turn can happen with no event recorded if the process dies between the
  effect and the append, and an event can be recorded for an effect that then fails. The log is the
  record of what was announced.
- The writer waits for one flush per persistent event, so the persistent-event rate is bounded by flush
  latency (about 2 ms per event on the measured VHD). Ephemeral events are not stored, but they share the
  writer's FIFO, so a terminal-output or delta event queued behind a persistent one waits for that
  event's flush; a burst of N persistent events delays them about N x 2 ms, more when a commit triggers
  a WAL checkpoint. The queue backs up rather than dropping events.
- A long backlog of flushes lengthens the exit instead of losing events: the shutdown drain waits for
  the writer's backlog, not for a timer (see the amendment below).
- Test: `test_open_flushes_every_commit_to_stable_storage` in `orchestration/log.rs`. The ignored
  `measure_append_throughput_by_synchronous_level` reproduces the table above.
- Out of scope: the Wave 2 durable spine (a bounded replay watermark and operation receipts) builds on
  this guarantee and decides nothing here.

## Amendment (2026-10-14): the shutdown drain is bounded by the backlog, not by a timer

The first Windows CI run ([job "Rust (windows-2025)"](https://github.com/ABCrimson/Swarm/actions/runs/38546843636/job/115795064860)) showed this decision's cost landing
on shutdown. `lifecycle::tests::shutdown_persists_everything_recorded_before_it` records 500
`worker_killed` events and shuts down; the runner's NTFS had committed 407 of them when the 2.5 s drain
budget ran out, and an exiting process never writes the rest. With a flush per persistent event, any
fixed drain budget is a bet on the disk, and losing the bet drops events the writer had accepted, which
the fail-closed rule of [ADR-0034](0034-persist-before-emit-fails-closed.md) and the guarantee above do
not allow.

`OrchestrationEngine::shutdown` therefore takes no budget. Closing the sinks freezes the backlog (an
event recorded after that is dropped at the sink and its caller told), and the FIFO `Shutdown` barrier
queued behind the backlog reaches the writer only once the last accepted event is committed or failed
closed. The call returns then, so the wait is the backlog times the per-event flush. The writer channel
itself is unbounded; what makes the wait finite is that nothing joins the backlog after the close. A
long drain logs the number of uncommitted events every 5 s. A safety ceiling, `DRAIN_CEILING` (120 s),
covers a disk that stops making progress: reaching it logs an error with the number of accepted
persistent events left unpersisted (the sinks count what they queue, the writer what it commits) and
fails the shutdown with that count in its message, never silently. `Runtime::shutdown`'s argument now
bounds only the agent sessions (`SESSION_SHUTDOWN_TIMEOUT`, 2.5 s, in `src-tauri/src/lifecycle.rs` and
`crates/swarmd/src/main.rs`), and both shells log a failed shutdown at error level. The pragmas and the
per-event flush are unchanged; group commit remains the way to make the drain itself shorter.

Tests: `test_shutdown_waits_for_a_slow_writer_to_commit_its_backlog` in `runtime.rs` (a 10 ms-per-event
writer with a 4 s backlog), `test_shutdown_returns_after_the_last_accepted_seq_is_committed` and
`test_a_drain_at_its_ceiling_reports_the_unpersisted_count` in `orchestration/engine.rs`, the lifecycle
test above, and `test_sigterm_shuts_down_gracefully_and_releases_the_lock` in `swarmd`'s integration
tests, which counts every `session_created` a `SIGTERM` interrupted.

See [Ordered Event Core](../architecture.md#ordered-event-core).

## Amendment (2026-10-14): the flush cost on APFS and NTFS is under the 5 ms gate

`measure_append_throughput_by_synchronous_level` (3000 appends of a 392-byte payload, test profile) ran on
GitHub-hosted runners on 2026-10-14, one run per platform. At the shipped `synchronous=EXTRA` the p50 per
commit is 749 µs on APFS (`macos-26`, macOS 26.6.2, 1217 events/s, p99 2.61 ms) and 3.37 ms on NTFS
(`windows-2025`, Windows 10.0.26100.33438, 259 events/s, p99 10.0 ms). Both are under the 5 ms gate, so
group commit is not required by this decision. FULL measured 816 µs on APFS and 3.45 ms on NTFS; on macOS
EXTRA measured faster than FULL, which is run-to-run noise. The table and method are in
[docs/performance.md](../performance.md#event-log-persistence).

These are virtual machines, not the maintainer's hardware. The Linux control runner measured about 9 µs
at every level, so its virtual disk does not honor fsync as a physical disk does; the macOS and Windows
figures therefore bound the platform's caching behavior and are not guarantees for a given laptop. The NTFS
figure leaves 1.6 ms of headroom under the gate, and the earlier indirect CI estimate (about 6 ms per
event, a mean over a shutdown drain) was a mean on a loaded VM, not a p50.
