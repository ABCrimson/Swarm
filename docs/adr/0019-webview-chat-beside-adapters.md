# ADR-0019: The webview chat path stays beside the provider adapters

- **Status:** Accepted
- **Date:** 2026-08-14

## Context

SWARM first had a Rust-side Anthropic Messages API client with an SSE parser and a priority queue
(`ai/client.rs`, `ai/stream.rs`, `ai/queue.rs`, an `ai_request` command). The shipped chat never used
it: it called the Anthropic SDK from the webview. The multi-provider rework then needed a different
Rust capability, driving provider CLIs, so keeping a second Rust path to the same API was dead weight
and a source of drift. `ai_request` had zero shipped callers.

## Decision

Delete the Rust `ai/` module and the `ai_request` command; keep what was worth keeping (the queue
became the scheduler, the line splitter became the NDJSON framer). The two AI paths that remain are:

- **The webview chat** (`src/lib/ai-chat.ts`, `src/lib/anthropic.ts`, `AIChat.tsx`): the
  `@anthropic-ai/sdk` called from the webview with the API key read from the Rust-owned config. It
  runs the agentic tool loop, streams to the UI, and its built-in tools (`spawn_worker`,
  `kill_worker`, `run_command` (which writes a command line to a worker's terminal as `worker_input`
  with source `tool`), `read_file`, `write_file`, `get_metrics`, plus user-defined ones) run as
  ordinary IPC. No `swarm://events` envelope carries the stream and no message text enters the event log.
  Once per turn, before the first request, it calls `agent_turn_started` to learn a turn seq, and the
  side-effecting tool calls pass `originWorker` and `causeSeq` so their events are stamped
  ([ADR-0005](0005-provenance-recorded-never-inferred.md)).
- **The provider adapters** ([ADR-0013](0013-provider-adapter-trait-pair.md)): Rust-side, for workers
  spawned with `agent_spawn`. Their transcript is rendered by `AgentChat.tsx` from the `agent_*` stream.
  A worker with a live agent session shows `AgentChat`; one without shows `AIChat`.

The two use different identifier spaces (a chat-item `requestId` against a provider `TurnId`), which is
why the causal record keys off the `agent_*` family ([ADR-0011](0011-pr-body-evidence-before-prose.md)).

## Consequences

- The `ai_stream_delta` and `ai_stream_settled` events are gone from the event enum, along with the
  `useAiStream` hook that consumed them.
- The webview path needs a network connection from the webview to `api.anthropic.com`, which the
  desktop CSP allows (`connect-src`). In the browser build served by `swarmd` it cannot work: the
  served CSP's `connect-src` is `'self'`, and `read_config` is `SecretFiltered` remotely, so the key
  is unreadable. Remote AI goes through the adapter RPC surface.
  `TransportCapabilities.localAiChat` is `false` for the WebSocket transport, but no call site reads it
  yet.
- Webview tools that act on the machine wait for the user's approval, and the file commands behind
  them are scoped and deny-listed ([ADR-0035](0035-ai-tool-approval-and-fs-scope.md)).

## Amended 2026-10-13

`TransportCapabilities.localAiChat` is read now: `hasCapability("localAiChat")` hides or disables the
webview chat (the worker AI panel, the spawn dialog's Webview Anthropic provider, Settings' API key field,
the Ship preview's summary generation) in the browser build. The sentence above that no call site reads it
describes the state at the original commit.
