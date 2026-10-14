# ADR-0009: The ship chain's guarantees are structural, not conventional

- **Status:** Accepted
- **Date:** 2026-08-14 (hardened 2026-09-23)

## Context

A worker's finished work should become a real commit, a real upstream push and a prefilled GitHub
compare page, with no AI involved in the mechanics. The same code can also destroy things: push over
someone's branch, commit a secret, bypass the user's hooks, mutate the repo's primary checkout.
Promising not to is not enough, because a future caller, a stale preview or a refactor can break a
promise; the code should be unable to.

## Decision

The chain lives in `swarm_core::git::ship` (tauri-free); `commands/git.rs` is plumbing. The guarantees
hold because the code cannot express the unsafe thing:

- **Never `--force`, never `--no-verify`.** `push_args` is a fixed `push --end-of-options origin
  <sha>:refs/heads/<branch>` vector (the source is the commit id, so the push carries the commit that
  was read, and an id never starts with `+`) with no place for a force flag; the upstream is recorded
  afterwards with `git branch --set-upstream-to`, because git records one only for a branch source; `commit_args` has no path that appends `-n` or
  `--no-verify`, so the user's hooks always run. Argv-shape unit tests pin both.
- **Never `-A`.** Staging is an explicit path list, sent on stdin as `:(top,literal)` pathspecs with
  `--pathspec-from-file` and NUL separation, so `app/[slug]/page.tsx` never globs and a large change
  set never hits an argv limit.
- **The primary-checkout guard fires twice.** Preflight reports it as one of eight non-fatal
  `blockers`. `stage_and_commit` and `push` do not trust that anyone read `canShip`: each runs
  `guard_not_primary_checkout` before touching anything, so a stale preflight or a caller that skips
  preflight can never mutate the repo's primary checkout.
- **A deny list is enforced, not narrated.** A credential-shaped name (basename starting `.env` or
  `id_rsa`, ending `.pem` or `.key`, or `secret` anywhere in the path), a file over 5 MiB (measured on the blob the commit would contain: the index blob
  in `staged` mode, the working-tree file `all` mode is about to stage, and the index blob again
  in the final pre-commit check in both modes), or an
  untracked `.claude/settings.json` never reaches a commit SWARM makes. In `staged` mode a denied path
  already in the index is unstaged with `git restore --staged`, and if that fails nothing is
  committed. The index is checked again just before `git commit`.
- **Push resolves its own facts.** `git_push` takes no commit sha: it uses the branch checked out now
  (never the stored branch a rename would make stale), refuses a detached `HEAD`, and resolves the sha
  itself and pushes that exact commit, so a commit that lands on the branch meanwhile is not pushed and the
  receipt's `sha` is what the remote received. It therefore also works with no preceding commit, for work
  that is committed but unpushed.
- **A push rejection never becomes a force-push.** The remedy for non-fast-forward is
  fetch-and-rebase and ship again, an explicit second click.
- **Receipts.** Mutating commands emit `ship_progress` steps and end an attempt with exactly one
  `ship_settled`, on failure or on the call the client marked `finalStep`. `nothingToCommit` settles
  nothing, because the client recovers by pushing commits that already exist.
- **Commit metadata.** `Swarm-Seq-Range: <from>..<to>` and a configured `Co-Authored-By` are added
  with `git commit --trailer`, message on stdin. The seq trailer is omitted for an unknown (`0..0`) or
  degenerate range; a co-author containing a newline is dropped, not sanitised.
- **Ownership split.** Worktree creation, naming and removal belong to the worktree feature. Ship owns
  commit and push and is the only writer of `last_shipped_seq` and `last_shipped_commit`, set only
  after a successful push. The two meet at one accessor, `worktree_info_for_worker`.

## Consequences

- `last_shipped_*` is in memory only; after a restart the seq range falls back to the worker's
  `worktree_created` row.
- The deny list governs what SWARM commits. Commits the agent made itself are pushed as they are, and
  a process that stages a file between the final check and `git commit` is not seen.
- The frontend's receipt wait is 30 s, shorter than the backend's 600 s commit and push budgets (see
  [architecture.md, Known gaps](../architecture.md#known-gaps)).

See [Ship Chain](../architecture.md#ship-chain).
