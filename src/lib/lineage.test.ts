// deriveLineage / selectLineageStartSeq: the worker detail panel's
// Related Workers list, derived from measured provenance edges and a
// backward causality walk.

import { describe, expect, it } from "vitest";
import type { DomainEvent } from "#lib/event-bus";
import { deriveLineage, selectLineageStartSeq } from "#lib/lineage";
import type { ProvenanceEdgeKind, ProvenanceEdgeRecord } from "#store/provenance";
import type { WorkerState } from "#store/types";

function edge(
  from: string,
  to: string,
  kind: ProvenanceEdgeKind,
  lastSeq: number,
): [string, ProvenanceEdgeRecord] {
  return [`${from}->${to}:${kind}`, { from, to, kind, count: 1, lastSeq, lastTs: lastSeq * 1000 }];
}

function edges(
  ...records: [string, ProvenanceEdgeRecord][]
): ReadonlyMap<string, ProvenanceEdgeRecord> {
  return new Map(records);
}

function ev(seq: number, originWorker?: string, causeSeq?: number): DomainEvent {
  return { seq, ts: seq * 1000, type: "worker_input", originWorker, causeSeq, payload: {} };
}

const live = (states: Record<string, WorkerState>): Readonly<Record<string, WorkerState>> => states;

describe("deriveLineage", () => {
  it("is empty for a worker with no measured causality", () => {
    expect(deriveLineage("w-a", edges(), live({ "w-a": "running" }))).toEqual({
      rows: [],
      failed: 0,
    });
  });

  it("lists the one parent as Spawned By, with its status", () => {
    const lineage = deriveLineage(
      "w-b",
      edges(edge("w-a", "w-b", "spawn", 7)),
      live({ "w-a": "paused", "w-b": "running" }),
    );

    expect(lineage).toEqual({
      rows: [{ relation: "Spawned By", workerId: "w-a", state: "paused" }],
      failed: 0,
    });
  });

  it("lists many children as Spawned, failed ones first, then most recent first, and counts the failed ones", () => {
    const lineage = deriveLineage(
      "w-a",
      edges(
        edge("w-a", "w-1", "spawn", 3),
        edge("w-a", "w-2", "spawn", 5),
        edge("w-a", "w-3", "spawn", 4),
        // A command to a child is not a second Spawned row.
        edge("w-a", "w-1", "command", 9),
      ),
      live({ "w-a": "running", "w-1": "error", "w-2": "running", "w-3": "error" }),
    );

    expect(lineage.rows).toEqual([
      { relation: "Spawned", workerId: "w-3", state: "error" },
      { relation: "Spawned", workerId: "w-1", state: "error" },
      { relation: "Spawned", workerId: "w-2", state: "running" },
    ]);
    expect(lineage.failed).toBe(2);
  });

  it("orders Spawned By, Spawned, then Caused By: direct inbound edges first, then the walked chain nearest first", () => {
    const lineage = deriveLineage(
      "w-b",
      edges(
        edge("w-a", "w-b", "spawn", 2),
        edge("w-b", "w-c", "spawn", 4),
        edge("w-r", "w-b", "command", 8),
        edge("w-m", "w-b", "message", 6),
      ),
      live({
        "w-a": "running",
        "w-b": "running",
        "w-c": "idle",
        "w-r": "idle",
        "w-m": "running",
        "w-z": "running",
        "w-y": "running",
      }),
      // Root first, as walkCausalityChain returns it: w-y caused w-z,
      // which caused w-r's command to w-b.
      [ev(1, "w-y"), ev(5, "w-z", 1), ev(8, "w-r", 5)],
    );

    expect(lineage.rows.map((row) => [row.relation, row.workerId])).toEqual([
      ["Spawned By", "w-a"],
      ["Spawned", "w-c"],
      ["Caused By", "w-r"],
      ["Caused By", "w-m"],
      ["Caused By", "w-z"],
      ["Caused By", "w-y"],
    ]);
  });

  it("guards cycles: the worker itself is never a row, and each worker appears once, under its first relation", () => {
    const lineage = deriveLineage(
      "w-a",
      edges(
        // w-a and w-b spawned each other (a cycle), and w-b also commands w-a.
        edge("w-b", "w-a", "spawn", 2),
        edge("w-a", "w-b", "spawn", 3),
        edge("w-b", "w-a", "command", 5),
        // A self-edge.
        edge("w-a", "w-a", "message", 6),
      ),
      live({ "w-a": "running", "w-b": "running" }),
      // A chain that loops back through w-a and w-b.
      [ev(2, "w-b"), ev(3, "w-a", 2), ev(5, "w-b", 3), ev(6, "w-a", 5)],
    );

    expect(lineage.rows).toEqual([{ relation: "Spawned By", workerId: "w-b", state: "running" }]);
  });

  it("leaves out workers that are no longer live, and chain events with no origin", () => {
    const lineage = deriveLineage(
      "w-b",
      edges(edge("w-gone", "w-b", "spawn", 2), edge("w-b", "w-c", "spawn", 4)),
      live({ "w-b": "running", "w-c": "error" }),
      [ev(1), ev(2, "w-gone", 1)],
    );

    expect(lineage).toEqual({
      rows: [{ relation: "Spawned", workerId: "w-c", state: "error" }],
      failed: 1,
    });
  });
});

describe("selectLineageStartSeq", () => {
  it("is null when nothing measured reached the worker", () => {
    expect(selectLineageStartSeq(edges(edge("w-a", "w-b", "spawn", 3)), "w-a")).toBeNull();
  });

  it("is the most recent measured edge into the worker, whatever its kind", () => {
    const records = edges(
      edge("w-a", "w-b", "spawn", 3),
      edge("w-r", "w-b", "command", 9),
      edge("w-b", "w-c", "spawn", 12),
    );

    expect(selectLineageStartSeq(records, "w-b")).toBe(9);
  });
});
