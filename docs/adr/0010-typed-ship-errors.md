# ADR-0010: Ship errors are typed objects

- **Status:** Accepted
- **Date:** 2026-08-14

## Context

The rest of the IPC surface rejects with a human-readable string (`AppError` serialises to its
`Display` text). The ship UI needs to branch: a rejected push should offer fetch-and-rebase, an
expired credential should offer re-authentication, `nothingToCommit` should just be reported. A
string carries the message but not a machine-checkable kind to switch on.

## Decision

The four ship commands (`git_ship_preflight`, `git_stage_commit`, `git_push`, `ship_compare_url`)
reject with `ShipError { kind, message, remedy }`, serialised as an object. `ShipErrorKind` is a closed
list (`workerNotFound`, `noWorktree`, `primaryCheckout`, `invalidBranch`, `noRemote`, `nonGitHubHost`,
`nothingToCommit`, `identityMissing`, `hookFailed`, `pushRejected`, `authExpired`, `timeout`,
`unknown`); `ShipRemedy` is `fetchAndRebase`, `reAuthenticate` or `configureIdentity`. A lower-level
`AppError::Git` bridges in through `From<AppError> for ShipError`, which classifies a timeout as
`timeout` and everything else as `unknown`, so the divergence stays inside the ship module.

`validate_repo_root` and the read-only `ship_context` report their failures (an unreadable event log,
say) as ordinary strings; only a malformed worker id in `ship_context` is a `ShipError`. The frontend wraps
the object in `ShipCommandError`, a real `Error` subclass carrying `.shipError`, and normalises the
plain-string case (bad arguments, a panicked task) to `kind: "unknown"`.

## Consequences

- Two error conventions exist on the IPC surface, a documented, deliberate divergence.
- Over `swarmd`, the registry returns the same JSON, so remote clients get the same objects.
- Adding a kind means updating the Rust enum, the TypeScript schema and the UI's remedy mapping.

See [Errors](../architecture.md#errors) and [api.md](../api.md).
