# ADR-0039: The event log commits with synchronous=FULL

- **Status:** Accepted
- **Date:** 2026-10-13

## Context

[ADR-0003](0003-single-writer-ordered-event-log.md) says a crash never reuses a seq, and
[ADR-0034](0034-persist-before-emit-fails-closed.md) says anything a client saw live is in the log. The
log ran SQLite in WAL mode with `synchronous=NORMAL`. SQLite's own documentation is explicit about what
that gives: "WAL mode is always consistent with synchronous=NORMAL, but WAL mode does lose durability",
and "A transaction committed in WAL mode with synchronous=NORMAL might roll back following a power loss
or system crash" (<https://sqlite.org/pragma.html#pragma_synchronous>). "Writers sync the WAL on every
transaction commit if PRAGMA synchronous is set to FULL but omit this sync if PRAGMA synchronous is set to
NORMAL" (<https://sqlite.org/wal.html>).

So under NORMAL the log survived a process crash, but after an OS crash or a power loss it could roll
back to an earlier state. That state could lack an event the engine had already emitted and lack the
seq-block reservation that preceded it, so the restarted writer could reissue a seq a client had already
seen. Both documented guarantees were false for that failure.

Measured cost (2026-10-13, WSL2 Ubuntu-26.04 on an Intel Core Ultra 9 290HX Plus, 3000 one-transaction
appends of a 392-byte payload plus a reservation per 1024 seqs, three runs each; details and the
reproduction command in [Event Log Persistence](../performance.md#event-log-persistence)):

| Directory | NORMAL | FULL |
|-----------|--------|------|
| ext4 on the WSL2 VHD | 23-32k events/s, p50 about 7 µs | about 470-510 events/s, p50 about 2 ms, p99 5-6 ms |
| `C:\` through 9p | 174-381 events/s, p50 2.3-3.1 ms | 229-260 events/s, p50 3.4-4.1 ms |

WSL is a proxy for native Windows NTFS, where the real figure is the drive's flush latency.

## Decision

`EventLog::init` sets `PRAGMA synchronous = FULL` on the writer connection, reads the value back (the
pragma does not echo it) and fails the open with `AppError::EventLog` when SQLite reports anything else.
An event append and a seq reservation are each their own committed transaction, so each is fsynced
before the writer goes on: an event is on stable storage before it is emitted, and a block of seqs is on
stable storage before its first seq is issued. The read-only connections never commit and set no
`synchronous` level (it is per connection).

Alternatives:

- **NORMAL (the previous setting).** Cheapest, and consistent, but not durable across an OS crash or
  power loss, which breaks the two guarantees above. Rejected: the log is the replay source and the seq
  authority, so correctness comes before throughput.
- **FULL.** Chosen. One WAL fsync per commit.
- **EXTRA.** SQLite: "EXTRA is no different from FULL in WAL mode" (pragma documentation), so it costs the same
  and adds nothing here. Rejected.
- **NORMAL plus batching or group commit.** Would amortise the fsync, but delays the emit until the batch
  commits or emits events that may not be stored. A change to the writer, not to this setting. Not done.

## Consequences

- An appended (committed) event and a seq reservation survive a process crash, an OS crash and a power
  loss, provided the storage honours fsync/flush. Not guaranteed: a drive or filesystem that lies about
  flushes, and an event whose append had not committed (it was never emitted either).
- Persist-before-emit is an ordering, not an atomic transaction with the effect an event describes. A PTY
  write, a git push or a provider turn can happen with no event recorded if the process dies between the
  effect and the append, and an event can be recorded for an effect that then fails. The log is the
  record of what was announced.
- The writer thread waits for one fsync per persistent event, so the persistent-event rate is bounded by
  flush latency (about 2 ms per event on the measured VHD). The queue backs up rather than dropping
  events ([ADR-0003](0003-single-writer-ordered-event-log.md)); ephemeral events never touch the log.
- Test: `test_open_syncs_the_wal_on_every_commit` in `orchestration/log.rs`. The ignored
  `measure_append_throughput_by_synchronous_level` reproduces the table above.
- Out of scope: the Wave 2 durable spine (a bounded replay watermark and operation receipts) builds on
  this guarantee and decides nothing here.

See [Ordered Event Core](../architecture.md#ordered-event-core).
