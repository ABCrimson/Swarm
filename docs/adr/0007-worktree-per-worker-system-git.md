# ADR-0007: Worktree-per-worker isolation through the system `git`

- **Status:** Accepted
- **Date:** 2026-08-14

## Context

The collision unit for coding agents is the process writing files. N workers in one working tree
overwrite each other. Git worktrees give each worker its own checkout and branch. Implementing them
raised two questions: how to drive git, and what to do when isolation fails.

## Decision

**Shell out to the user's `git`.** `gix` does not implement creating or removing linked worktrees, and
`libgit2` (`git2`) vendors a C build and checks out through a different path than the user's own
hooks, LFS filters and attributes. Using the real binary reuses exactly what the user already trusts,
including the hooks a ship's commit and push must run.

**A worker spawned with a `repoRoot` (and `isolation` of `worktree`, the default) gets
`<worktrees_root>/<repo>-<hash8>/w-<id8>` on a new branch `swarm/<slug>-<id8>`**, forked from the
repo's `HEAD` and locked with the worker id as the reason. `worktrees_root` defaults to
`~/.swarm/worktrees`.

**Isolation fails closed.** If repo discovery, `HEAD` resolution, `worktree add` or `worktree lock`
fails, the spawn fails: no worker, no PTY, no fallback to a shared cwd. A spawn without a `repoRoot`
is unisolated, as before. Registry capacity is reserved before anything is created, and a failure
after that point rolls back the shell, the worktree and its unchanged branch.

**Every mutating git call is serialized per repository** through `RepoLocks`, keyed by the canonical
toplevel, with one retry after 200 ms when the failure looks like transient lock contention. Different
repositories run in parallel.

**A startup capability probe** runs `git --version` against a minimum of 2.32 and reports a missing or
too-old git as a `system_log` event rather than letting the first spawn fail mysteriously. A startup
`git worktree prune` runs against the configured `default_repo_root`.

## Consequences

- Worktrees cost a checkout per worker, and `worktree add` can take long on a big repository
  (budgeted in [ADR-0012](0012-single-git-runner.md)).
- A full multi-repository orphan reconciliation (rebuild the expected worktree set from the event log
  and diff it against `git worktree list`) is not implemented; only the configured default repo is
  pruned at startup.
- Killing a worker signals only its shell, so a process that detached from the terminal can hold the
  worktree directory open and make removal fail
  ([ADR-0008](0008-worktree-removal-never-forces.md)).

See [Worktree Isolation](../architecture.md#worktree-isolation).
