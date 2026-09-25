import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import type { DomainEvent } from "#lib/event-bus";

/**
 * The four kinds of MEASURED causal edge this store derives from stamped
 * envelopes — distinct from `"manual"`, the user-drawn annotation kind
 * `WorkerGraph.tsx` renders separately and never stores here (measured
 * facts and user annotations must never merge — see
 * `docs/architecture.md`'s Causality Graph section).
 */
export type ProvenanceEdgeKind = "spawn" | "kill" | "command" | "message";

/**
 * One measured causal edge. Repeated same-`{from,to,kind}` occurrences
 * collapse into a single record — `count` increments, `lastSeq`/`lastTs`
 * advance to the most recent occurrence.
 */
export interface ProvenanceEdgeRecord {
  readonly from: string;
  readonly to: string;
  readonly kind: ProvenanceEdgeKind;
  readonly count: number;
  readonly lastSeq: number;
  readonly lastTs: number;
}

/**
 * Wire-frequent telemetry types excluded from the `bySeq` ring. Nothing
 * in this codebase ever attributes causation to a raw output chunk, a
 * streaming delta, or a metrics/log tick — `causeSeq` only ever cites a
 * sparse event like `agent_turn_started` or `worker_spawned`. Excluding
 * these costs nothing (a lookup for one of their seqs would never
 * happen) and keeps the bounded ring from being flushed by telemetry
 * within seconds of a real session starting.
 */
const RING_EXCLUDED_TYPES = new Set<string>([
  "worker_output",
  "system_metrics",
  "ai_stream_delta",
  "system_log",
]);

/**
 * Bound on the `bySeq` ring — CausalityPanel's fast path for "what event
 * is at seq N". A miss falls back to a single-row `events_since` backfill
 * (see `CausalityPanel.tsx`), so this bound trades a rarer network hop
 * for bounded memory, never correctness.
 */
export const RING_LIMIT = 2000;

function edgeKey(from: string, to: string, kind: ProvenanceEdgeKind): string {
  return `${from}->${to}:${kind}`;
}

/**
 * Resolves the SUBJECT worker a stamped envelope's edge should point at
 * — `undefined` when the event type carries no edge-shaped target (e.g.
 * ephemeral telemetry) or the target field is absent (a broadcast
 * `bus_message` has no `toWorker`).
 */
function resolveEdgeTarget(event: DomainEvent): string | undefined {
  const payload = event.payload;
  if (typeof payload !== "object" || payload === null) return undefined;
  const p = payload as Record<string, unknown>;
  switch (event.type) {
    case "worker_spawned":
    case "worker_killed":
    case "worker_input":
      return typeof p.workerId === "string" ? p.workerId : undefined;
    case "bus_message":
      return typeof p.toWorker === "string" ? p.toWorker : undefined;
    default:
      return undefined;
  }
}

function resolveEdgeKind(type: string): ProvenanceEdgeKind | undefined {
  switch (type) {
    case "worker_spawned":
      return "spawn";
    case "worker_killed":
      return "kill";
    case "worker_input":
      return "command";
    case "bus_message":
      return "message";
    default:
      return undefined;
  }
}

/** State slice for measured causality. */
interface ProvenanceStoreState {
  /** Measured edges by `from->to:kind`. Replaced (never mutated) when an edge changes. */
  readonly edges: ReadonlyMap<string, ProvenanceEdgeRecord>;
  /**
   * Bounded recent-event ring keyed by seq — see {@link RING_LIMIT}. One
   * Map for the store's lifetime, mutated in place and never replaced: it
   * is read on demand (`getState().bySeq`, CausalityPanel's walk), never
   * subscribed to, so ringing an event notifies no subscriber.
   */
  readonly bySeq: Map<number, DomainEvent>;
  /** Per-worker `file_written` counts, rendered as a node badge, never an edge. Replaced on change. */
  readonly fileWriteCounts: ReadonlyMap<string, number>;
}

/** Mutation actions for the provenance store. */
interface ProvenanceStoreActions {
  /**
   * The single derivation entrypoint: feed it any envelope from the
   * ordered bus (see `useProvenanceEvents`) and it does everything —
   * rings the event, and (when the envelope carries a real
   * `originWorker` and an edge-shaped type) derives or collapses a
   * measured edge. The engine records provenance; this store only ever
   * mirrors what it recorded — never infers a cause of its own.
   *
   * Only an edge or file-count change produces a state update; the far
   * more frequent telemetry and ring-only events cost a Map write at most.
   */
  readonly ingestEvent: (event: DomainEvent) => void;
  /** Test-only: clears all derived state. */
  readonly reset: () => void;
}

/** Rings `event` in place, evicting the oldest entry past {@link RING_LIMIT}. */
function ring(bySeq: Map<number, DomainEvent>, event: DomainEvent): void {
  if (RING_EXCLUDED_TYPES.has(event.type)) return;
  bySeq.set(event.seq, event);
  if (bySeq.size > RING_LIMIT) {
    // The ring only ever grows one entry past its bound before this trims
    // it back, and the ordered bus dispatches in ascending seq order
    // (event-bus.ts dedups/sorts pending events), so insertion order
    // tracks seq order — the first key iterated is reliably the oldest.
    const oldest = bySeq.keys().next().value;
    if (oldest !== undefined) bySeq.delete(oldest);
  }
}

/**
 * Zustand store for measured causal edges derived from the ordered event
 * bus — replaces the fabricated "Spawn Order" chain that used to connect
 * workers in Map insertion order. Plain copy-on-write updates (no immer:
 * drafting copied the 2000-entry ring on every event);
 * `subscribeWithSelector` for fine-grained subscriptions.
 */
export const useProvenanceStore = create<ProvenanceStoreState & ProvenanceStoreActions>()(
  subscribeWithSelector((set, get) => ({
    edges: new Map(),
    bySeq: new Map(),
    fileWriteCounts: new Map(),

    ingestEvent(event) {
      ring(get().bySeq, event);

      // file_written -> node badge, never an edge (files aren't workers,
      // and a node-per-file would explode the layout).
      if (event.type === "file_written") {
        const writer = event.originWorker;
        if (!writer) return;
        set((s) => ({
          fileWriteCounts: new Map(s.fileWriteCounts).set(
            writer,
            (s.fileWriteCounts.get(writer) ?? 0) + 1,
          ),
        }));
        return;
      }

      const from = event.originWorker;
      if (!from) return; // unattributed -- no measured edge to draw
      const kind = resolveEdgeKind(event.type);
      if (!kind) return; // not an edge-shaped event type
      const to = resolveEdgeTarget(event);
      if (!to) return; // no resolvable target (e.g. a broadcast bus_message)

      const key = edgeKey(from, to, kind);
      set((s) => ({
        edges: new Map(s.edges).set(key, {
          from,
          to,
          kind,
          count: (s.edges.get(key)?.count ?? 0) + 1,
          lastSeq: event.seq,
          lastTs: event.ts,
        }),
      }));
    },

    reset() {
      get().bySeq.clear();
      set({ edges: new Map(), fileWriteCounts: new Map() });
    },
  })),
);

/**
 * Selects the edges that should actually render: both endpoints must
 * still be live workers. An edge whose endpoint departed (killed, never
 * re-spawned) drops from the graph but is never deleted from the store
 * — `CausalityPanel` can still look up its trace by seq after the node
 * is gone.
 */
export function selectVisibleEdges(
  edges: ReadonlyMap<string, ProvenanceEdgeRecord>,
  liveWorkerIds: ReadonlySet<string>,
): ProvenanceEdgeRecord[] {
  const visible: ProvenanceEdgeRecord[] = [];
  for (const record of edges.values()) {
    if (liveWorkerIds.has(record.from) && liveWorkerIds.has(record.to)) {
      visible.push(record);
    }
  }
  return visible;
}

/**
 * Finds the seq of the most recent measured edge involving `workerId`
 * as either endpoint (causer or subject) — the starting point
 * `WorkerDetail`'s "View Causality" action hands to `CausalityPanel`.
 * `null` when this worker has no measured causality at all.
 */
export function selectMostRecentSeqForWorker(
  edges: ReadonlyMap<string, ProvenanceEdgeRecord>,
  workerId: string,
): number | null {
  let best: number | null = null;
  for (const record of edges.values()) {
    if (record.from !== workerId && record.to !== workerId) continue;
    if (best === null || record.lastSeq > best) best = record.lastSeq;
  }
  return best;
}
