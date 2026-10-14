# Roadmap

> The next ten major releases of SWARM Orchestrator and the minor releases between them, as planned on 2026-10-13.

---

## Table of Contents

- [How To Read This](#how-to-read-this)
- [The Ten Majors At A Glance](#the-ten-majors-at-a-glance)
- [Minor Releases Before 0.15.0](#minor-releases-before-0150)
- [0.15.0 Durable Spine](#0150-durable-spine)
- [Minor Releases Before 0.16.0](#minor-releases-before-0160)
- [0.16.0 Recoverable Jobs](#0160-recoverable-jobs)
- [Minor Releases Before 0.17.0](#minor-releases-before-0170)
- [0.17.0 Governed Organization](#0170-governed-organization)
- [Minor Releases Before 0.18.0](#minor-releases-before-0180)
- [0.18.0 Review And Ship](#0180-review-and-ship)
- [Minor Releases Before 0.19.0](#minor-releases-before-0190)
- [0.19.0 Accountable Operations](#0190-accountable-operations)
- [Minor Releases Before 1.0.0](#minor-releases-before-100)
- [1.0.0 Release Evidence](#100-release-evidence)
- [Minor Releases Before 1.1.0](#minor-releases-before-110)
- [1.1.0 Measured Value](#110-measured-value)
- [Minor Releases Before 1.2.0](#minor-releases-before-120)
- [1.2.0 The Agent Surface](#120-the-agent-surface)
- [Minor Releases Before 1.3.0](#minor-releases-before-130)
- [1.3.0 Causal Record](#130-causal-record)
- [Minor Releases Before 1.4.0](#minor-releases-before-140)
- [1.4.0 Scale What Wins](#140-scale-what-wins)
- [Not Scheduled](#not-scheduled)
- [What This Roadmap Does Not Promise](#what-this-roadmap-does-not-promise)
- [Sources](#sources)

---

## How To Read This

- **Where the plan starts.** The current release is 0.13.1 (`package.json` version; the Cargo workspace version in `Cargo.toml` matches). `CHANGELOG.md` `[Unreleased]` holds the Tauri 3 (alpha) modernization and the product fixes of Milestone 0 (M0), for example per-command RPC deadlines for ship over `swarmd` (M0.6). That section has a Breaking heading, so it ships as a 0.y release: proposed 0.14.0. It is the starting line, not one of the ten. Before 0.14.0 ships, Milestone 0's event-log durability change is measured on macOS and NTFS, and a p50 over 5 ms blocks the release (G3 V-A2).
- **What a major is.** A named release that delivers one outcome a user can observe. Before 1.0 a major is a `0.y.0` release (SemVer treats every 0.y bump as possibly breaking). From 1.0 on, a major that keeps every stored event log, wire frame and command contract compatible ships as the next `1.y.0`; a major that breaks any of them ships as the next `x.0.0` instead, and the table below shifts by that one number.
- **What a minor is.** The point releases between two majors (`0.y.z` / `1.y.z`): dependency refreshes, follow-ups, hardening and docs truth. A minor never changes a stored log, a wire frame or a command contract.
- **Where 1.0 falls, and why.** 1.0.0 is the sixth major. By then the event log is durable and replayable with upcasters (0.15.0), one job survives a crash without repeating an effect (0.16.0), acceptance is bound to an exact tree and reviewed by an identity other than the author (0.17.0), and every attempt's cost is ledgered (0.19.0). 1.0.0 itself adds release evidence: signed and notarized installers, and signed attestations over the event log that `swarm verify` checks (build-provenance attestations already ship). 1.0 is a compatibility and trust promise, not a claim that more agents produce better work. That claim is measured in 1.1.0, and only what wins there is scaled in 1.4.0.
- **Sizes.** S is at most 2 days, M at most 1 week, L at most 3 weeks, XL more than 3 weeks of one focused lane. A size is an estimate of effort, not a date.
- **How acceptance is proven.** This applies to every major; each section names its specific evidence.
  1. Each named test or command passes on the exact integrated tree, and the evidence records argv, timestamps, exit code, tree hash, runtime identities (toolchain and provider CLI versions) and fixture and output digests (the M0 evidence rule).
  2. A reviewer that did not author the change reviews it and can refute it; acceptance binds to the tree that reviewer saw.
  3. Performance claims carry measured numbers from a committed benchmark or budget run, never estimates.
  4. The frontend, Rust and end-to-end gates are green, the dependency-freshness sweep reports nothing behind except documented holds (`.peak-modern-holds.json`), and every doc the release touches states the code at its head.
- **Ids.** `W<n>.<x>` (epics), `W2-T<nn>` (Wave 2 tasks), `M<n>` / `M<n>.<m>` (milestones), and `Q<n>` and `N<n>` (open owner questions) refer to the maintainer's planning record (2026-10-10 to 2026-10-13), which is not part of this repository. They are kept so each line here traces to its source. `G<n>` names a 2026-10-13 integration report in the same record.

---

## The Ten Majors At A Glance

| # | Version | Name | The Outcome You Get | Size | Depends On |
|---|---------|------|---------------------|------|------------|
| 1 | 0.15.0 | Durable Spine | A command happens exactly once or visibly fails, survives a crash or restart, and reaches every client within bounded time and bytes. | XL | 0.14.0 |
| 2 | 0.16.0 | Recoverable Jobs | A job you submit survives a crash or restart, resumes from durable state, and never repeats an external effect blindly. | L (estimate) | 1 |
| 3 | 0.17.0 | Governed Organization | Agents drive Swarm through scoped tools, managers split work into child assignments, and a reviewer other than the author accepts the exact tree. | XL (estimate) | 1, 2 |
| 4 | 0.18.0 | Review And Ship | You see, comment on, rewind and ship each worker's changes as a pull request, with every hunk tied to the event log. | XL | 1, 3 |
| 5 | 0.19.0 | Accountable Operations | You see what every attempt costs, every resource is bounded, and the job, review and cost views stay usable at 30-40 workers. | XL (estimate) | 2, 3, 4 |
| 6 | 1.0.0 | Release Evidence | Signed, notarized installers with attestations you can verify, scoped remote access, and safe updates. | XL (estimate) | 1-5 |
| 7 | 1.1.0 | Measured Value | Published measurements of single-agent versus governed runs on a fixed task corpus, from a developer pilot. | L (estimate) | 2-6 |
| 8 | 1.2.0 | The Agent Surface | Full provider fidelity in the conversation: composer, plan mode, attachments, one chat model on the log. | XL | 1, 3 |
| 9 | 1.3.0 | Causal Record | Agent blame per hunk, provenance-gated merge, fork from any moment, and a swarm-wide time-travel timeline. | XL | 4, 6, 8 |
| 10 | 1.4.0 | Scale What Wins | More providers (ACP agents) and mixed teams where the 1.1.0 measurements show a win, and more machines. | XL | 7, 8 |

Rows 1, 4, 8, 9 and 10 take their epics' planned sizes; rows 2, 3, 5, 6 and 7 are the maintainer's estimates.

---

## Minor Releases Before 0.15.0

- Dependency refresh under the newest-on-any-channel rule (`AGENTS.md`); `@xyflow/react` moves to 13 once a build with provenance exists or the owner chooses to override pnpm's trust-downgrade refusal of 13.0.0-next.0. — G1
- Escape the remaining raw path and name renders outside the display-escape census (file tree, worker detail, session views and others). — M0.2 follow-up (G2)
- In the browser build, command-palette and template spawns stop creating webview Anthropic workers. — M0.8 follow-up (G4)
- Claude adapter follow-up: close the documented gap for subagents started with `isolation: "worktree"`. — M0.1 follow-up (G2)
- Decide, then implement, how Standard and Write-Enabled Claude workers receive the repository's own instructions (`CLAUDE.md`, `.claude/rules`, `.claude/skills`), which they no longer load since Milestone 0's adapter-trust change runs them with `--setting-sources ""` ([ADR-0038](adr/0038-agent-provider-trust-model.md)); `AGENTS.md` loaded under neither setting in that runtime check. This is an owner decision. — M0.1 follow-up (G2)
- Codex adapter watch: the app-server schema marks `ThreadStartResponse.sandbox` as legacy in favor of `activePermissionProfile` (the schema generated by codex-cli 0.163.0-alpha.5, read 2026-10-13); the adapter moves when it is removed. — G2 watch item
- Nothing cancels an attach in flight on kill: `kill_worker` → `begin_close` waits for attach permits (`agent/registry.rs`), and the attach awaits `adapter.spawn` inline (`commands/agent.rs`), so a kill still waits out the handshake, up to 30 s, although a dropped Claude `spawn` future now kills its CLI. — G3 follow-up
- macOS kill path: when a worker is killed while its output pump is stalled, drain or close the PTY before waiting on the shell, because XNU holds a dead session leader until its unread terminal output is read (seen in the 2026-10-14 CI run; the exit-watcher test now drains). — CI follow-up
- Run the integrated branch through the CI Rust matrix (`windows-2025` and `macos-26` in `.github/workflows/ci.yml`): the Claude adapter's Windows-only branches (`cfg(not(unix))`, `PATHEXT`) have not been built locally, and the Rust hook fixture has run only on Linux and WSL. — G2, G5 follow-ups

---

## 0.15.0 Durable Spine

### Outcome

A command happens exactly once or visibly fails, survives a crash or restart, and reaches every client within bounded time and bytes. Today a reconnecting `swarmd` client replays every persisted event after its last seq however far behind it is (module doc of `crates/swarmd/src/ws.rs`), only a ship attempt ends in a receipt (`ship_settled`) while other commands carry no command id or durable receipt, there is no effect outbox, and killing a worker signals only its shell ([Known Gaps](architecture.md#known-gaps)).

### Scope

This release is Wave 2, tasks W2-T00 to W2-T21 with W2-T01b.

- `swarmd` refuses a plaintext bind to a LAN address unless `--allow-plaintext-lan` is passed; loopback and tailnet ranges stay allowed. — W2.A (W2-T02)
- Writer group commit and schema v3 with upcasters and a pre-migration copy of the database. — W2.B (W2-T03, W2-T04)
- Command identity: client-minted `commandId`, durable receipts, a retry returns the stored receipt. — W2.C (W2-T10)
- Pure projection with sequenced snapshots and `list_*` reads. — W2.D (W2-T11)
- Durable effect outbox, readiness gate and startup reconcile. — W2.E (W2-T12)
- Bounded wire: gap measured before replay, one snapshot frame instead of an unbounded tail, per-connection byte cap. — W2.F (W2-T13, W2-T14)
- Terminal bytes on their own channel with a bounded scrollback ring; process-tree kill per OS (a job object on Windows; on Unix a walk over the shell's session and its descendants). — W2.G (W2-T07, W2-T15, W2-T20)
- Typed command contracts that generate the Zod schemas and the `docs/api.md` tables, checked in CI. — W2.H (W2-T05, W2-T17)
- Injectable clock and ids, no waiting sleeps in tests, committed benches and `pnpm perf` budgets, writer and per-worker metrics. — W2.I (W2-T06, W2-T09, W2-T18, W2-T19)
- Retention anchored on snapshots, with incremental vacuum. — W2.J (W2-T16)
- Truthful provider status: exit cause and stderr tail on `agent_session_exited`; provider session and message ids on every turn event. — W2.K (W2-T01b, W2-T08)
- Deferred into this release from Milestone 0: the ship guard across remounts and a second tab (durable receipts), and the cold-start event lost before the listener attaches (seq handshake). — G5, G4 follow-ups
- Not in this release: TLS, pairing and scoped tokens (1.0.0); resuming provider sessions after a restart; telemetry that leaves the machine.

### Acceptance Evidence

Wave 2 design acceptance A1-A9, condensed:

- A plaintext LAN bind exits non-zero without `--allow-plaintext-lan`, and tailnet binds still require the existing token.
- A retried `commandId` after a mid-call disconnect returns the stored receipt and exactly one effect exists.
- A crash during a queued effect: on restart a replay-safe effect (a leased `git_push`) is requeued and a process-bound one is terminalized with a durable reconcile event.
- A client far behind receives one snapshot frame under 1 MiB, then live events.
- A burst of 20 producers × 50 persistent agent events commits in at most 1/50 of the ungrouped transaction count (commit-hook count).
- A v2 log upgraded through the upcasters folds to the same projection as the live run; a failed migration rung leaves the pre-migration copy byte-identical.
- Zero waiting sleeps in tests (CI grep gate); `pnpm perf` passes every budget; the README publishes the measured installer size, idle memory and cold start.
- The generated contracts and `docs/api.md` tables are byte-identical to a fresh generation.
- Killing a worker whose shell spawned a grandchild leaves no live descendant, and the worktree removal succeeds.
- The Windows and macOS runs of these tests stay unverified until the owner approves CI runs or a WSL cross toolchain (Wave 2 design section 9).

### Risks And Open Decisions

- Q2: how Windows PTY children join the job object (`portable-pty` has no job-object support).
- Q5: observability stays local; no telemetry leaves the machine unless the owner adopts opt-in telemetry.
- Q11: whether to adopt pnpm's `permissions` setting.
- Q12: Tauri 3 alpha bumps land in their own commit at the release open.
- Unnumbered owner decision: CI runs or a WSL toolchain to prove Windows and macOS behavior in-release.
- Risk: the projection fold adds latency to every event; the writer bench measures it before and after.

---

## Minor Releases Before 0.16.0

- Dependency refresh, including the newest Tauri 3 pre-release. — AGENTS.md rule, Q12
- Tune the Wave 2 defaults (snapshot cadence, 30-day / 512 MiB retention, 1 MiB terminal ring) from measured numbers. — Wave 2 design section 13
- Worktree upgrades: branch from the fetched remote tip, non-fatal submodule init, project setup scripts on worktree create, temporary branch names renamed under the repo lock (S each). — W3.9

---

## 0.16.0 Recoverable Jobs

### Outcome

One durable job from submission to completion: it survives a crash or restart, resumes from durable state, and never repeats an external effect blindly. This release is M1.

### Scope

- Entities Project, Objective, Job, Assignment, Attempt, Operation, Artifact, Review, GateRun, Decision, Budget and Lease, with transitions enforced in Rust. — M1
- Durable intent recorded before any subprocess or git effect; idempotency keys; ambiguous external results reconciled by reading external state. — M1
- Leases with expiry and fencing tokens; capped backoff with jitter; restart reconcile that expires leases and resumes only authorized, unpaused jobs, never replaying shell commands. — M1
- Crash and power-loss fixtures prove the event log's durability setting, not only process-crash recovery. — M1
- One provider end to end: a vertical demo on deterministic stubs, then a small real-provider canary. — M1

### Acceptance Evidence

- Crash fixtures at every boundary (process killed before intent, after intent before effect, after effect before record) each recover to one consistent state.
- The canary run's receipt binds the tree hash and the provider CLI version.

### Risks And Open Decisions

- Retries stacked on provider SDK retries are forbidden by design.

---

## Minor Releases Before 0.17.0

- Dependency refresh. — AGENTS.md rule
- Hardening from the canary: any crash fixture that fails in the field becomes a test before the next major. — M1

---

## 0.17.0 Governed Organization

### Outcome

Agents drive Swarm through scoped tools, managers split work into child assignments, and a reviewer other than the author accepts the exact tree. This release is M2 with W3.1, W3.2 and W5.5.

### Scope

- Swarm tool surface (MCP) so Claude Code and Codex workers can call Swarm: fleet status, read a worker, hand off; approvals move server-side so they also bind remote clients and agents. — W3.1
- Secrets in the OS keychain instead of `swarm-config.json`, with a headless fallback for `swarmd`. — W3.2 (Q6)
- Persisted role assignments with the effective model, effort, tool and credential scopes of each. — M2
- Manager plans create child assignments; the bus delivers and acknowledges; admission limits and cost reservations before launch; a pause contract. — M2
- Reviewer identity distinct from the author; acceptance bound to the exact tree; a bounded rework loop. — M2
- Architecture decisions with supersession, retrieved into briefs; research and maintenance jobs. — M2
- Handoff on the bus, with chains tied to the calling turn's seq. — W5.5

### Acceptance Evidence

- A Claude worker and a Codex worker each call the status tool (fixture-driven adapter tests).
- A tool call's event cites the calling turn's seq.
- An unapproved spawn from an agent cannot act.
- Worker A's token cannot read worker B when its scope says no.
- After migration `swarm-config.json` holds no key.
- An acceptance recorded against one tree is refused for any other tree.
- The author cannot be its own reviewer.

### Risks And Open Decisions

- N4: default agent tool rights. The judge default lets a worker read the fleet, read itself and hand off; spawn, kill and ship need approval.
- Q6: the headless key fallback.
- The in-band MCP shapes for each CLI are spiked against the installed CLI before the design is fixed.

---

## Minor Releases Before 0.18.0

- Dependency refresh. — AGENTS.md rule
- Template-aware PR prose from the base tree, commit-style policy, generation off the webview so headless `swarmd` works, provenance in git notes. — W3.10 (Q4)

---

## 0.18.0 Review And Ship

### Outcome

You see, comment on, rewind and ship each worker's changes as a pull request, with every hunk tied to the event log. This release is the remainder of Wave 3.

### Scope

- Turn checkpoints as hidden refs, with a deny-list that keeps secrets out of checkpoint objects. — W3.3
- Diff viewer with line comments that become composer context; each hunk links to the seq that wrote it. — W3.4
- `swarm-forge` crate: GitHub first, reuse-or-create pull requests whose body carries the full Causal Record; the compare page stays as the fallback. Push destinations are immutable and PR creation binds to receipts (a push already binds its commit sha, and the compare receipt already comes from the recorded push). — W3.5, M4
- PR watch reactor, started by agents through the `swarm_watch_pr` tool: failing checks, remarks and conflicts wake the worker within fixed caps. — W3.6
- Rewind a worker's files to a checkpoint, never touching another worker's tree. — W3.7
- Cross-worker conflict radar before either worker ships. — W3.8
- Git quick actions, merge actions and "Fix In A Worker", each re-checking the expected head before writing. — W3.11
- Remove the deprecated `worker_output` event variant. — Wave 2 design section 3.2

### Acceptance Evidence

- A mid-turn `git pull` does not appear in the turn diff.
- A deny-listed file never enters a checkpoint object (`git cat-file` test).
- A hunk opens the seq that wrote it (end-to-end on fixture data).
- A PR body carries the Causal Record, and the PR number and URL are in the log.
- A failing check wakes the worker once, and a head move resets the counters.
- Rewinding A never touches B's tree.
- Two workers editing one hunk get the conflict event before either ships.

### Risks And Open Decisions

- Q4: the trailer policy.
- Hidden-ref growth (retention covers it).
- Forge API drift.

---

## Minor Releases Before 0.19.0

- Dependency refresh. — AGENTS.md rule
- Codified taste: Biome GritQL rules for house patterns and a suppression-reason gate. — W4.14 (Q1)

---

## 0.19.0 Accountable Operations

### Outcome

You see what every attempt costs, every resource is bounded, and the job, review and cost views stay usable at 30-40 workers. This release is M3 with W4.1, W4.2, W4.3, W4.8 and W4.9.

### Scope

- A unified attempt ledger with cache categories and an authoritative / estimated / unknown status on every amount; reservations and hard ceilings. — M3
- Usage limits with scheduler deferral at window exhaustion, and cost per merged hunk; live model discovery replaces the hard-coded catalog. — W4.9
- Disk and byte quotas, paged transcripts, retention and export; app-wide daemon limits; replay watermarks. — M3
- Capability metadata authoritative at every control. — M3
- Typed routes with deep links, and feature folders. — W4.1
- Inbox and notifications: Needs You, Working and Done-Unread shelves; OS notifications that deep-link to the turn. — W4.2
- Virtualized conversation timeline. — W4.3
- Theme tokens, a light variant and a contrast control; no static inline styles. — W4.8
- Job overview, review queues, cost view and evidence inspector; accessibility and 30-40 worker layouts. — M3

### Acceptance Evidence

- A notification deep-links to a worker's turn (end-to-end).
- The scheduler defers on an exhausted window and resumes at its reset.
- axe reports zero violations on every route, and focus order is tested for the inbox and composer.
- A layout test renders 40 workers within the frame budget (measured).
- Every cost figure shows its status.

### Risks And Open Decisions

- N1: whether localization is in scope; if it is, strings are extracted during the feature-folder move.
- Q5: the usage ledger stays local.
- Routing churn across the folder move.

---

## Minor Releases Before 1.0.0

- Dependency refresh. — AGENTS.md rule
- Docs truth sweep: every `docs/*.md` page re-measured against the release candidate head. — AGENTS.md Docs rule

---

## 1.0.0 Release Evidence

### Outcome

Signed, notarized installers with attestations you can verify, scoped remote access, and safe updates. This release is M4 with W5.4, W7.1, W7.4, W7.5, W7.8, W7.9 and W4.13.

### Scope

- Scoped remote sessions: `swarmd pair` (QR, one-time code, revocation), per-scope remote policy, TLS with the certificate's SPKI hash in the pairing URL. Today the token is the only authentication and the transport is plain `ws://` ([The Daemon](daemon.md)). — W7.1, M4
- Process isolation per attempt and scoped credentials; the provider binary identity recorded per attempt. — M4
- Authenticode signing on Windows and Developer ID signing plus notarization on macOS; arm64 Linux and Windows builds; install scripts. Today release artifacts carry Tauri updater signatures and build-provenance attestations (`.github/workflows/release.yml`), with no Authenticode signing or Apple notarization. — W7.8, M4
- The desktop updater installs and relaunches through the cleanup hook; `swarmd` self-update with a database snapshot and trial / commit / rollback. — W7.5, W7.4
- An SBOM for every artifact and checksums for the installer bundles (`swarmd` binaries already publish `.sha256` files); backups. — M4
- Signed attestations over a seq range and tree hash, verified by `swarm verify`, signed with a per-installation key in the OS keychain or the user's git SSH signing key, never the updater key. — W5.4
- Release train: nightly, stable promotes a nightly SHA, a bundle smoke test per runner, and `tauri-driver` end-to-end on Windows and Linux (the design in [End-to-End Testing](e2e.md), not built today). — W7.9
- User documentation (getting started, workers, ship, remote) beside the reference. — W4.13

### Acceptance Evidence

- A phone or second machine pairs and watches one worker with a scope that cannot spawn.
- `swarm verify` returns OK on a PR body and detects a one-byte tamper.
- No attestation path can read the updater key (test).
- A failed trial update restores the log byte for byte.
- SmartScreen and Gatekeeper show no warning on the signed installers.
- Native Windows, macOS and Linux checks run on CI runners.

### Risks And Open Decisions

- Q5: crash reports are opt-in.
- Q6: key storage and recovery.
- Signing identities are owner-held.
- Whether 1.0 ships on a Tauri 3 pre-release (owner decision, unnumbered).

---

## Minor Releases Before 1.1.0

- Dependency refresh. — AGENTS.md rule
- Fixes from release evidence: any check that fails on a native runner becomes a gate. — M4

---

## 1.1.0 Measured Value

### Outcome

Published measurements of single-agent versus governed runs on a fixed task corpus, from a developer pilot. This release is M5.

### Scope

- A fixed task corpus. — M5
- Three arms run at fixed spend and fixed deadline: the single strongest agent, a governed controller, and a controlled runtime change. — M5
- Metrics: accepted task rate, escaped defects, wall time, cost per accepted change, intervention minutes and recovery success. — M5
- A hard-case suite: lost process, duplicate event, expired lease, rate limit, exhausted budget, full disk, malformed hook output, prompt injection in a log, conflicting worktrees, ambiguous external result, candidate changed after approval, paused job timer, malicious dependency script. — M5
- A developer pilot; the scope of any paid layer is decided from pilot evidence. — M5 (and the design review's measurement rule)

### Acceptance Evidence

- Published distributions per arm, with the corpus, seeds and tree hashes so anyone can rerun them.
- Every hard case has a recorded outcome.

### Risks And Open Decisions

- The result may favor the single agent. Then 1.4.0 scales that, not more agents.

---

## Minor Releases Before 1.2.0

- Dependency refresh. — AGENTS.md rule
- Act on the measurement: defaults change toward the arm that won. — M5

---

## 1.2.0 The Agent Surface

### Outcome

Full provider fidelity in the conversation: composer, plan mode, attachments, one chat model on the log. This release is the remainder of Wave 4.

### Scope

- Markdown pipeline. — W4.4
- Keybinding engine. — W4.5
- Composer: `@file` mentions, slash commands, image paste, queue and steer, permission-mode picker, context meter. — W4.6
- Provider contract: capabilities matrix, attachments, five-way permission decisions, steer, typed file-change / command / plan blocks, plan mode with structured questions, and Codex re-verified at the newest app-server with a checked-in schema and drift test (the adapter names codex-cli 0.156.1 as verified today). — W4.7
- One chat model: retire the webview Anthropic chat into a Rust adapter and close its CSP opening. — W4.10
- Import or fork existing Claude Code / Codex CLI sessions into a worker. — W4.11
- MCP Apps rendering in a sandboxed frame. — W4.12
- Multi-instance providers and a replay corpus. — W4.15

### Acceptance Evidence

- A Codex file edit renders as a unified diff.
- Claude plan mode yields a plan card, and a structured question is answerable.
- No `@anthropic-ai/sdk` import remains in `src/`.
- The provider replay corpus passes for each provider.

### Risks And Open Decisions

- Composer scope creep.
- If retiring the webview chat removes a command contract, this release ships as 2.0.0 (see How To Read This).

---

## Minor Releases Before 1.3.0

- Dependency refresh. — AGENTS.md rule

---

## 1.3.0 Causal Record

### Outcome

Agent blame per hunk, provenance-gated merge, fork from any moment, and a swarm-wide time-travel timeline. This release is Wave 5 without W5.4 and W5.5.

### Scope

- Agent blame per hunk and provenance-gated ship. — W5.1
- Fork-at-seq: a new worktree from the checkpoint plus a provider-native fork at the recorded message; cross-provider by injecting a summarized transcript; recorded tool results are never replayed. — W5.2
- Time-travel timeline with the provenance graph hydrated from the log (it is session-scoped today, see [Known Gaps](architecture.md#known-gaps)). — W5.3
- Graph-timeline sync and a ship-readiness strip. — W5.6

### Acceptance Evidence

- Every hunk in a shipped PR shows its seq.
- A policy violation blocks the push with a cited seq.
- A fork at seq N on Claude resumes at message N, and its first checkpoint equals the source's.
- The provenance graph after restart equals the graph before.

### Risks And Open Decisions

- Provider fork APIs change.

---

## Minor Releases Before 1.4.0

- Dependency refresh. — AGENTS.md rule

---

## 1.4.0 Scale What Wins

### Outcome

More providers (ACP agents) and mixed teams where the 1.1.0 measurements show a win, and more machines. This release is Wave 6 with W7.2, W7.3, W7.6 and W7.7.

### Scope

- An ACP adapter (Agent Client Protocol, https://agentclientprotocol.com) with raw frames in the log. — W6.1
- An installer for agents from the ACP Registry. An agent shipped as a binary archive installs only with its `sha256` verified; the registry's format makes that field optional, so a binary without it is refused unless the user opts out. `npx` and `uvx` agents install at their exact pinned package version. — W6.2
- Cross-provider team lead with tasks, claims and handoffs as events. — W6.3
- Scheduled prompts and multi-repo. — W6.4
- Desktop as a client of several environments (WSL and remote side by side). — W7.2
- SSH launcher. — W7.3
- A real Windows service; `swarmd` runs as a per-user logon Scheduled Task today ([ADR-0029](adr/0029-windows-daemon-logon-task.md)). — W7.6
- A PWA served by `swarmd`. — W7.7

Gate: the ACP and team pieces (W6.1-W6.3) ship only if the 1.1.0 measurements show the governed, multi-agent arm wins for their workload; the machine pieces do not depend on it.

### Acceptance Evidence

- Gemini CLI (an `npx` agent in the ACP Registry) installs at its exact pinned version and runs a turn, and a binary-archive agent installs with its `sha256` verified.
- A cancelled ACP turn settles cancelled with every permission answered.
- A three-provider team produces one log with cross-provider causal edges.
- A scheduled prompt survives a restart.
- The desktop attaches to a WSL `swarmd` and a remote `swarmd` in one session.
- The Playwright WebKit project passes against the PWA.

### Risks And Open Decisions

- Q7: PWA first or a Tauri 3 mobile shell.
- Q8: relay choice (iroh P2P, a user-owned Cloudflare tunnel, or none beyond Tailscale and SSH).
- Q10: monorepo shape.
- N4: whether autonomous team leads may spawn without approval.
- ACP protocol churn.

---

## Not Scheduled

- Frontier items stay unscheduled until their owner question is answered, then each gets its own design: child-webview preview pane; CEF flavor versus headless Chrome (Q3); auto-verify preview loop; server-side terminal state with prompt boundaries in the log; iroh P2P remote (Q8); container isolation; a Tauri 3 mobile shell (Q7); window capture. — Wave 8
- Voice input stays in the backlog. — capability matrix

---

## What This Roadmap Does Not Promise

- No dates: sizes are effort estimates for one focused lane, and no release has a calendar date.
- No revenue, subscriber, valuation or pricing figures: none has evidence behind it (2026-10-12 audit).
- Not that more agents are better: 1.1.0 measures the single strongest agent against a governed controller and a controlled runtime change at fixed spend and deadline, and 1.4.0 scales only what wins.
- Not that third-party CLIs, protocols or the Tauri 3 pre-release stay stable: each release re-verifies them.
- Not Windows or macOS behavior that only CI runners can prove until those runs exist.

---

## Sources

- Repository at commit f243f17, read 2026-10-13: `package.json` (version 0.13.1), `Cargo.toml` (`[workspace.package]` version), `CHANGELOG.md` `[Unreleased]`, `.peak-modern-holds.json`, `docs/architecture.md` (Known Gaps), `docs/daemon.md`, `docs/e2e.md`, `docs/updater-keys.md`, `docs/adr/README.md` (ADRs 0001-0040), `docs/adr/0029-windows-daemon-logon-task.md`, `docs/adr/0038-agent-provider-trust-model.md`, `.github/workflows/ci.yml`, `.github/workflows/release.yml`, `crates/swarmd/src/ws.rs` (module doc), `crates/swarm-core/src/config.rs`, `crates/swarm-core/src/agent/codex.rs` (module doc: verified against codex-cli 0.156.1).
- Planning record (not in this repository): the Waves 2-8 roadmap (2026-10-10); the Wave 2 durable-spine design and plan (2026-10-10); three external reviews pasted by the owner (a design review, an audit and an implementation roadmap with milestones M0-M5, 2026-10-12); the integration log and reports G1-G7 and G9 (2026-10-13).
- codex-cli 0.163.0-alpha.5 app-server schema, generated 2026-10-13 (G2).
- Agent Client Protocol, fetched 2026-10-13: https://agentclientprotocol.com/overview/introduction, https://agentclientprotocol.com/get-started/registry, https://agentclientprotocol.com/get-started/agents, https://raw.githubusercontent.com/agentclientprotocol/registry/main/FORMAT.md ("Each binary distribution may include a `sha256` …").
