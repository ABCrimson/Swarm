# ADR-0006: The worker graph draws measured causality only

- **Status:** Accepted
- **Date:** 2026-08-14

## Context

The Workers graph first drew a "Spawn Order" chain: an edge between each pair of consecutive workers
in map-insertion order, whether or not anything had happened between them. It looked like causality
and was not.

## Decision

Edges come from stamped envelopes ([ADR-0005](0005-provenance-recorded-never-inferred.md)) and
nowhere else. An envelope becomes an edge only if it has a real `originWorker` and its type resolves
to a kind and a target: `worker_spawned`, `worker_killed` and `worker_input` target
`payload.workerId`; `bus_message` targets `payload.toWorker` when present. Kinds are `spawn`, `kill`,
`command` and `message`. Repeats of the same `{from, to, kind}` collapse into one edge with a count.
`file_written` is not an edge (files are not workers); it is a "Wrote N Files" badge on the origin
worker's node.

Hand-spawned workers with no recorded cause render as nodes with no edges and a quiet hint. That
empty state is the acceptance criterion. A user may still draw an edge by hand; it has `kind:
"manual"`, a desaturated style and its own legend group, lives in React state, and is never merged
into measured edges. Workflow export covers manual edges only, because export and import round-trip
every edge as manual and would launder a measured fact into an annotation.

The store is populated by live envelopes only; it is not hydrated from `events_since` at startup.

## Consequences

- A reload shows every live worker with zero edges until new causality happens, though the log still
  holds the history. A replay or hydration pass is future work.
- An automatic relayout (ELK) on any topology change moves every node and overwrites a manual drag;
  there is no pin affordance yet.
- The causality inspector walks `causeSeq` backward hop by hop and says so when a hop is missing
  (`incomplete`) rather than presenting the last known cause as a root.

See [Causality Graph](../architecture.md#causality-graph).
