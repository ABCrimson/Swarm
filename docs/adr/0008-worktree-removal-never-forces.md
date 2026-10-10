# ADR-0008: Worktree removal never forces and classifies its outcome strictly

- **Status:** Accepted
- **Date:** 2026-08-14

## Context

Killing a worker removes its worktree. A worker's tree may hold uncommitted work, and a removal can
fail for reasons unrelated to dirtiness. A first classification treated any non-zero exit other than
two hard-coded messages as "preserved". That is wrong for a locked but clean worktree, and dangerous
for a permission error partway through a delete, when git may already have removed tracked files.

## Decision

- The argv builder for `git worktree remove` cannot construct `--force` or `-f`. Without it, git
  itself refuses to remove a worktree with modified or untracked files, and that refusal is the
  preserve-on-dirty guarantee. SWARM never deletes a worktree's contents; it only asks git, and git
  says no when it would lose something.
- The outcome is `RemoveOutcome::Preserved` (wire `preserved_dirty`) **only** for git's specific
  refusal ("contains modified or untracked files"). Every other non-zero exit (still locked, a
  permission error, a missing path, an unrecognised message) is an error that the caller reports as
  `disposition: "failed"`. Unlock failing is `failed` directly and removal is not attempted.
- After a `removed` disposition, and only then, the branch is compared with the `base_commit`
  recorded at spawn. Unchanged: `git branch -d` (never `-D`) deletes it so `swarm/*` branches do not
  pile up. Diverged: it stays. This is logged, not an event, and a failure at either step never fails
  the kill.
- The kill path reaps the shell before it releases the writer and master. On Windows, dropping the
  master closes the pseudoconsole under the shell, and a live child holding the worktree as its cwd
  would block removal.

The shapes are pinned by tests that prove `--force` and `-D` are not constructible.

## Consequences

- Killing a worker signals only its shell. Jobs normally go down with it (the terminal session is
  hung up on Unix; closing the pseudoconsole closes every console client on Windows), but a process
  that detached from the terminal can survive and keep the worktree busy. Removal then reports
  `failed` (correctly, never laundered into `preserved_dirty`) and the worktree stays on disk until
  the process exits and the removal is retried or cleaned up by hand. A job object (Windows) or a
  process-group kill (Unix) at spawn time would close the gap; neither is implemented.
- Quitting the app does not kill workers or touch their worktrees; PTYs close with the process.

See [Worktree Isolation](../architecture.md#worktree-isolation).
