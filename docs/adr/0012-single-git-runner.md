# ADR-0012: One git runner: redaction, environment and tiered budgets

- **Status:** Accepted (supersedes the two-tier 20 s / 5 s budget scheme)
- **Date:** 2026-08-14 (runner), 2026-09-23 (tiered budgets, process-tree kill, raw stdout)

## Context

Git is spawned from many places, and its output ends up in error messages, logs and event payloads.
Three problems follow if each call site handles itself: a credential in a remote URL leaks in stderr;
a hung or interactive git blocks a worker; and parsed data (porcelain records, NUL-separated paths,
numstat rows, shas) gets corrupted by redaction or truncation meant for messages. The first runner
gave `worktree add` 20 s and everything else 5 s, which killed legitimate `commit` hooks and large
checkouts.

## Decision

Every invocation goes through `git::cli::run` / `run_with_stdin`, the only place a git child is
spawned:

- **argv vector only**, never a shell string; every call carries `-C <dir> -c core.longpaths=true`
  per invocation, never written to the user's git config.
- **Environment hygiene:** `GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never`, `GIT_OPTIONAL_LOCKS=0`,
  `LC_ALL=C` (the push-error classifier matches English phrases), and every inherited repository
  location variable (`GIT_DIR`, `GIT_INDEX_FILE`, and the rest of `git rev-parse --local-env-vars`)
  removed, so a SWARM launched from a git hook cannot redirect calls to the hook's repository.
  `CREATE_NO_WINDOW` on Windows.
- **stdout raw, stderr redacted.** stdout is returned as bytes untouched; stderr is redacted (URL
  userinfo, GitHub, GitLab, Anthropic and AWS token shapes) and then truncated to 8 KB, in that order
  so a token is never cut in half at the boundary. Every message, log line and payload is built from
  the redacted copy; the raw copy exists only for pattern classification.
- **Tiered budgets:** `READ_TIMEOUT` 15 s (metadata queries, lock, unlock, prune, `branch -d`),
  `SCAN_TIMEOUT` 60 s (status, diff, numstat, rev-list), `CREATE_TIMEOUT` 120 s (`worktree add`, a full
  checkout with smudge filters), `MUTATE_TIMEOUT` 600 s (add, restore, commit with its hooks),
  `PUSH_TIMEOUT` 600 s, `REMOVE_TIMEOUT` 600 s (deleting ignored build output).
- **Expiry kills the process tree.** On Unix git runs in its own process group: `SIGTERM` first (git
  deletes its own locks), `SIGKILL` after 3 s. On Windows it is `taskkill /T /F`, which cannot let git
  clean up, so a killed mutation there can leave a stale `index.lock`. A timeout is a typed
  `AppError::GitTimeout` naming only the subcommand.
- The post-exit pipe drain is bounded to 500 ms, so a grandchild that inherited the pipes (an `ssh`
  control master) cannot hang the caller.

## Consequences

- The ship receipt wait in the frontend (30 s) is shorter than the commit and push budgets; see
  [Known gaps](../architecture.md#known-gaps).
- An `ssh` passphrase or host-key prompt is not suppressed; under a terminal-launched SWARM on Unix it
  stops git until its budget expires.
- Callers run these blocking functions inside `spawn_blocking`.

See [Worktree Isolation](../architecture.md#worktree-isolation) and [Ship Chain](../architecture.md#ship-chain).
