# ADR-0030: Tauri 3 alpha with a capability-scoped filesystem

- **Status:** Accepted
- **Date:** 2026-09-23 (moved to the alpha.4 set 2026-10-10)

## Context

The project runs the newest release on any channel for every dependency, including prereleases. Tauri 3
is in alpha across the whole stack (core, runtime, build, plugins, CLI, API), and it changes how an
app is assembled: the webview runtime is chosen by value instead of by feature flag. The v2 app also
carried a static filesystem scope and the `shell` plugin's deprecated `open`, whose regex rejected
every `https` URL, so "Open Compare Page" always failed.

## Decision

Adopt the Tauri 3 alpha stack end to end, pinned exactly (`tauri` and `tauri-runtime-wry`
`3.0.0-alpha.4`; the plugins and the JS packages at their own newest alpha), with the runtime chosen
explicitly: `tauri::Builder::default().runtime(tauri_runtime_wry::Wry::default())`. The webview
runtime features (`devtools` and friends) live on `tauri-runtime-wry`; `devtools` is an opt-in
`swarm-desktop` feature so signed release builds do not ship the inspector (debug builds keep it).

Least-privilege capabilities (`src-tauri/capabilities/default.json`), pinned by `capability_contract`
tests:

- **No static filesystem scope.** The fs commands (`read-file`, `read-dir`, `stat`, `write-file`) act
  only on paths the user picked in an open or save dialog, which grants that path (a directory with
  its contents) for the rest of the session. They never create directories, delete or rename.
  `fs:deny-default` is set, and a `fs:scope` deny list covers the app data directory (`$APPDATA/**`)
  and credential stores under `$HOME` (`.ssh`, `.gnupg`, `.aws`, `.azure`, `.kube`, `.docker`,
  `.config/gh`, `.claude`, `.codex`, `.git-credentials`, `.netrc`).
- `tauri-plugin-shell` is removed in favour of `tauri-plugin-opener`, scoped to exactly two things:
  `openUrl` for `https://*/*/*/compare/*` and `openPath` for `$HOME/.swarm/worktrees/**`. The plugin's
  injected link-click handler stays off.
- `updater:default` is not granted to the webview; updates go through the native
  `check_for_updates` command.
- `dialog_grants.rs` mirrors every folder grant into the global `fs:scope` so dot-entries are readable
  on macOS and Linux, where `*` and `**` never match a leading dot. The deny list still wins.

## Consequences

- Alpha APIs move between releases: `tauri-plugin-fs` 3.0.0-alpha.2 removed the text-file commands and
  their permissions (the capability grants `fs:allow-read-file` and `fs:allow-write-file`, and
  `fs:allow-stat` so a size check can run before a file is read), and `tauri-plugin-opener` alpha.2
  renamed `revealItemInDir` to `revealItemsInDir`. Each bump needs the contract tests and a launch
  check.
- The CSP keeps `'unsafe-inline'` for styles, because xterm and sonner insert `<style>` elements and
  Tauri's style nonces are turned off for `style-src`; `object-src`, `base-uri` and `form-action` are
  `'none'`.
- Windows and macOS bundling and the v3 `latest.json` updater manifest are verified only by a release
  dry run.

## Amendment (2026-10-14): the webview opens no path

The `openPath` scope `$HOME/.swarm/worktrees/**` admitted every file at any depth under the worktrees,
and an agent writes what it likes there: a `run.bat` it leaves in its worktree was one `openPath` call
from the OS running it (finding P-C18-L9-3-01). A tighter glob still trusts the shape of a path the
webview supplies, so the grant is gone instead: `opener:allow-open-path` is no longer in the
capability, and the worktree link calls the native `open_worker_directory` command with a worker id.
The shell looks the path up in its registry (the one recorded when the worktree was created), checks
`symlink_metadata().is_dir()` so a file, symlink or junction put in its place is refused, and opens it
with the opener plugin's Rust API, which applies no scope of its own. The opener grant left is
`openUrl` for `https://*/*/*/compare/*`; `capability_is_least_privilege` pins that it is the only one.
