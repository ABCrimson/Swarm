# Architecture decision records

One file per decision that shaped SWARM Orchestrator. Numbers are not chronological: 0001 to 0032
were extracted together and loosely grouped by area, and each later record takes the next free
number. The **Date** line, not the number, says when a decision landed.
[`../architecture.md`](../architecture.md) describes how the system works **now**; these records say
**why** it works that way, what it replaced, and what the choice costs. Read an ADR before changing
the thing it covers.

## Format

Each record is `NNNN-<slug>.md` with a status, a date, then Context, Decision and Consequences.

- **Status** is `Accepted` (in force), `Superseded by ADR-NNNN` (kept for the reasoning; the code no
  longer works this way), or `Deprecated`. A superseding record names what it replaced.
- **Date** is the day the decision landed in the repository, from the commit history, not the day the
  record was written.
- Records are append-only. To change a decision, write a new record and mark the old one superseded;
  never rewrite the reasoning of an accepted one. A fix to a factual slip is fine.
- Numbers are never reused. Take the next free one.

## Index

| ADR | Decision | Status |
| --- | --- | --- |
| [0001](0001-tauri-free-core-two-shells.md) | `swarm-core` is Tauri-free; the desktop app and the daemon are thin shells | Accepted |
| [0002](0002-swarmd-separate-binary.md) | `swarmd` is a separate binary, not a `--headless` flag | Accepted |
| [0003](0003-single-writer-ordered-event-log.md) | One ordered event stream: a single writer and a SQLite log | Accepted |
| [0004](0004-persistence-by-exclusion.md) | Persistence by exclusion: deltas are ephemeral, blocks are durable | Accepted |
| [0005](0005-provenance-recorded-never-inferred.md) | Provenance is recorded, never inferred | Accepted |
| [0006](0006-measured-causality-graph.md) | The worker graph draws measured causality only | Accepted |
| [0007](0007-worktree-per-worker-system-git.md) | Worktree-per-worker isolation through the system `git` | Accepted |
| [0008](0008-worktree-removal-never-forces.md) | Worktree removal never forces and classifies its outcome strictly | Accepted |
| [0009](0009-ship-chain-structural-guarantees.md) | The ship chain's guarantees are structural, not conventional | Accepted |
| [0010](0010-typed-ship-errors.md) | Ship errors are typed objects | Accepted |
| [0011](0011-pr-body-evidence-before-prose.md) | The PR body: code-generated evidence first, model prose second | Accepted |
| [0012](0012-single-git-runner.md) | One git runner: redaction, environment and tiered budgets | Accepted |
| [0013](0013-provider-adapter-trait-pair.md) | Provider adapters: one trait pair with honest capabilities | Accepted |
| [0014](0014-piped-stdio-for-json-providers.md) | Piped stdio, not a PTY, for JSON-protocol provider CLIs | Accepted |
| [0015](0015-trust-tiers-closed-vocabulary.md) | Trust tiers are a closed vocabulary | Accepted |
| [0016](0016-claude-code-control-protocol.md) | Claude Code is driven over the stream-json control protocol | Accepted |
| [0017](0017-codex-app-server-protocol.md) | Codex is driven over the verified app-server protocol | Accepted |
| [0018](0018-agent-turn-scheduler.md) | One agent-turn scheduler with per-worker admission | Accepted |
| [0019](0019-webview-chat-beside-adapters.md) | The webview chat path stays beside the provider adapters | Accepted |
| [0020](0020-bus-routes-by-recording-events.md) | The bus routes by recording events | Accepted |
| [0021](0021-command-registry-remote-policy.md) | One command registry; remote policy is declared per command | Accepted |
| [0022](0022-swarmd-authentication-and-exposure.md) | `swarmd` authentication and network exposure | Accepted |
| [0023](0023-swarmd-one-ordered-lane.md) | `swarmd` delivers events on one ordered lane | Accepted |
| [0024](0024-transport-chosen-at-build-time.md) | The frontend transport is chosen at build time | Accepted |
| [0025](0025-single-instance-lock.md) | A single-instance lock on the data directory | Accepted |
| [0026](0026-rust-owns-config-and-sessions.md) | Rust owns config and sessions; the webview owns its plugin-store files | Accepted |
| [0027](0027-three-tier-frontend-state.md) | Frontend state in three tiers | Accepted |
| [0028](0028-desktop-shell-registry-forwarders.md) | The desktop shell is registry forwarders on one runtime | Accepted; exit teardown superseded by [0033](0033-cleanup-hook-teardown-and-command-acl.md) |
| [0029](0029-windows-daemon-logon-task.md) | The Windows daemon is a per-user logon Scheduled Task | Accepted |
| [0030](0030-tauri-3-alpha-capability-scoped-fs.md) | Tauri 3 alpha with a capability-scoped filesystem | Accepted |
| [0031](0031-temporal-polyfill-boot-entry.md) | Temporal is polyfilled by a boot entry module | Accepted |
| [0032](0032-react-compiler-oxc-wasi.md) | The React Compiler runs through the Oxc WASI binding | Accepted |
| [0033](0033-cleanup-hook-teardown-and-command-acl.md) | Exit teardown in a cleanup hook; a per-command ACL | Accepted |
| [0034](0034-persist-before-emit-fails-closed.md) | A persistent event is saved before anyone sees it, and fails closed | Accepted |
| [0035](0035-ai-tool-approval-and-fs-scope.md) | Webview AI tools need per-call approval; the file commands canonicalize and deny secrets | Accepted |
| [0036](0036-model-catalogue-and-per-attempt-pricing.md) | One model catalogue, priced per attempt | Accepted |
| [0037](0037-webkit-floor-and-macos-15-4.md) | The webview floor is WebKit 18.4, so macOS 15.4 | Accepted |
| [0038](0038-kill-stops-the-session-first.md) | A kill stops the provider session first, behind a closing fence | Accepted |
