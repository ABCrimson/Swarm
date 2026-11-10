// A worker's lineage: the Related Workers list in the worker detail
// panel. A pure derivation over the provenance store's measured edges
// (`#store/provenance`) and a backward causality walk
// (`#lib/causality-walk`), so a screen reader or a large fleet gets the
// cause chain as text instead of a graph to pan.

import type { DomainEvent } from "#lib/event-bus";
import type { ProvenanceEdgeRecord } from "#store/provenance";
import type { WorkerState } from "#store/types";

/** How a related worker relates to the subject worker, as the row labels it (Title Case). */
export type LineageRelation = "Spawned By" | "Spawned" | "Caused By";

/** One related, live worker. */
export interface LineageRow {
  readonly relation: LineageRelation;
  readonly workerId: string;
  readonly state: WorkerState;
}

export interface Lineage {
  /** Spawned By, then Spawned, then Caused By; each worker once, under its first relation. */
  readonly rows: readonly LineageRow[];
  /** Rows whose worker is in the `error` state. */
  readonly failed: number;
}

/** Rows shown before the first "Show More". */
export const LINEAGE_FIRST_PAGE = 6;
/** Rows each "Show More" adds. */
export const LINEAGE_PAGE_STEP = 12;

/** Edges matching `keep`, most recent occurrence first. */
function recentFirst(
  edges: ReadonlyMap<string, ProvenanceEdgeRecord>,
  keep: (record: ProvenanceEdgeRecord) => boolean,
): ProvenanceEdgeRecord[] {
  return edges
    .values()
    .filter(keep)
    .toArray()
    .sort((a, b) => b.lastSeq - a.lastSeq);
}

/**
 * The seq to walk causality back from for `workerId`'s Caused By rows:
 * the most recent measured edge INTO the worker, of any kind (the latest
 * thing another worker did to it). `null` when nothing measured reached
 * it. Unlike `selectMostRecentSeqForWorker`, an edge the worker itself
 * caused is not a starting point: its chain is the worker's own.
 */
export function selectLineageStartSeq(
  edges: ReadonlyMap<string, ProvenanceEdgeRecord>,
  workerId: string,
): number | null {
  let best: number | null = null;
  for (const record of edges.values()) {
    if (record.to !== workerId || record.from === workerId) continue;
    if (best === null || record.lastSeq > best) best = record.lastSeq;
  }
  return best;
}

/**
 * Derives `workerId`'s related workers.
 *
 * - Spawned By: the origin of each measured `spawn` edge into the worker.
 * - Spawned: the subject of each `spawn` edge out of it.
 * - Caused By: the origin of each other measured edge into it (command,
 *   message, kill), then the origin of each event in `causeChain` (a
 *   `walkCausalityChain` result from `#lib/causality-walk`, root first)
 *   from nearest to root.
 *
 * Each group is most recent first. A worker appears once, under the first
 * relation that names it, and the subject never appears, so a spawn cycle
 * or a chain that loops back cannot repeat or recurse. Only live workers
 * (keys of `liveStates`) are listed: a row selects its worker, and a
 * departed one has no panel to open.
 *
 * @param liveStates State per live worker id.
 * @param causeChain A causality walk ending at {@link selectLineageStartSeq}; empty before it lands.
 */
export function deriveLineage(
  workerId: string,
  edges: ReadonlyMap<string, ProvenanceEdgeRecord>,
  liveStates: Readonly<Record<string, WorkerState>>,
  causeChain: readonly DomainEvent[] = [],
): Lineage {
  const rows: LineageRow[] = [];
  const seen = new Set([workerId]);
  const add = (relation: LineageRelation, relatedId: string | undefined): void => {
    if (relatedId === undefined || seen.has(relatedId)) return;
    const state = Object.hasOwn(liveStates, relatedId) ? liveStates[relatedId] : undefined;
    if (state === undefined) return;
    seen.add(relatedId);
    rows.push({ relation, workerId: relatedId, state });
  };

  for (const record of recentFirst(edges, (r) => r.kind === "spawn" && r.to === workerId)) {
    add("Spawned By", record.from);
  }
  for (const record of recentFirst(edges, (r) => r.kind === "spawn" && r.from === workerId)) {
    add("Spawned", record.to);
  }
  for (const record of recentFirst(edges, (r) => r.kind !== "spawn" && r.to === workerId)) {
    add("Caused By", record.from);
  }
  for (const event of causeChain.toReversed()) add("Caused By", event.originWorker);

  return { rows, failed: rows.filter((row) => row.state === "error").length };
}
