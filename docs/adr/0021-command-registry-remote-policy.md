# ADR-0021: One command registry; remote policy is declared per command

- **Status:** Accepted
- **Date:** 2026-08-15 (argument normalisation 2026-09-23)

## Context

Once a second shell existed, command handlers could not be written twice. `swarm-desktop` also needs
every command, and `swarmd` needs a policy for what a remote client may call. The first `swarmd`
dispatcher special-cased `read_config`'s secret-key denial by comparing the command name as a string;
everything else reached the registry unfiltered. It was reproduced live: an authenticated WebSocket
client read `<data_dir>/daemon-token`, `swarm-config.json` (the Anthropic key) and arbitrary `$HOME`
files through `read_file`.

## Decision

Every handler's logic lives once, in `swarm_core::commands::*`, keyed by name in a `Registry`. Each
entry declares a `RemotePolicy` at construction (a required parameter, so a command cannot be
registered without one):

- `Allowed`: any authenticated remote client.
- `Denied`: never reachable remotely. `read_file` and `write_file` (host filesystem access).
- `SecretFiltered`: denied when the `key` argument is secret-shaped, in both directions.
  `read_config` and `write_config`. Reading would exfiltrate a credential; writing would plant one
  the desktop app might later trust. `is_secret_key` splits keys into lowercase words (separators and
  camelCase boundaries) before matching, so `ANTHROPIC_API_KEY`, `settings:githubToken` and `api-key`
  are all caught.

Two entry points: `Registry::dispatch` (local desktop IPC, no policy: the user's own machine was never
the boundary) and `Registry::dispatch_remote` (the `swarmd` WebSocket path, which must be the only
one it calls, and which never compares command names itself). A contract test asserts every entry has
a policy and that the `Denied` and `SecretFiltered` sets are exactly the four names above.

Both dispatchers **normalise arguments first**: omitted or `null` becomes `{}`, and anything other than
a JSON object is refused. Without that, `SecretFiltered` inspected `args.get("key")`, which is `None`
for a positional array while serde still deserialised the key from the array, so a remote `rpc` with
`args: ["anthropic_api_key"]` read the key and a two-element array replaced it.

Two commands need a live webview or OS plugin and exist only in the desktop shell
(`NATIVE_ONLY`: `check_for_updates`, `send_notification`); the shell's contract tests compare its
forwarder list with `Registry::keys()` and `NATIVE_ONLY`, so a command added on one side only fails CI.

## Consequences

- `Allowed` includes `spawn_worker` and `worker_input`: an authenticated remote client can run
  arbitrary commands as the daemon's user. That is the product, not an oversight; the policy narrows
  which commands are reachable, not what an allowed command can do ([ADR-0022](0022-swarmd-authentication-and-exposure.md)).
- Non-object `args` are rejected on the wire, a deliberate breaking change.
- Handler arguments are parsed from one JSON object, so desktop and daemon accept exactly the same
  arguments and answer with the same JSON.

See [The command registry](../architecture.md#the-command-registry).

## Amendment (2026-10-14): `open_worker_directory` is a third `NATIVE_ONLY` command

The webview's worktree link opens a worker's own worktree directory through it, by worker id,
instead of through an opener path scope (see the 2026-10-14 amendment to [ADR-0030](0030-tauri-3-alpha-capability-scoped-fs.md)).
