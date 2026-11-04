#!/bin/sh
# The Unix twin of codex.cmd: a shell that starts the fake Codex
# app-server as its child (no `exec`) and waits for it, the way cmd.exe
# runs npm's codex.cmd shim on Windows. Killing only this shell leaves the
# node beneath it running.
node "$(dirname "$0")/../codex/fake_codex_app_server.mjs" "$@"
