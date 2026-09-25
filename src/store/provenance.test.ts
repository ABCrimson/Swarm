import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DomainEvent } from "#lib/event-bus";
import {
  RING_LIMIT,
  selectMostRecentSeqForWorker,
  selectVisibleEdges,
  useProvenanceStore,
} from "#store/provenance";

function ev(overrides: Partial<DomainEvent> & Pick<DomainEvent, "type" | "payload">): DomainEvent {
  return {
    seq: 1,
    ts: 1000,
    ...overrides,
  };
}

describe("provenance store", () => {
  beforeEach(() => {
    useProvenanceStore.getState().reset();
  });

  describe("ingestEvent — edge derivation per event kind", () => {
    it("derives a spawn edge from a stamped worker_spawned event (payload.workerId is the target)", () => {
      const { ingestEvent } = useProvenanceStore.getState();
      ingestEvent(
        ev({
          seq: 10,
          ts: 5000,
          type: "worker_spawned",
          originWorker: "w-caller",
          payload: { workerId: "w-new", name: "Sub-Agent", pid: 123 },
        }),
      );

      const edges = [...useProvenanceStore.getState().edges.values()];
      expect(edges).toEqual([
        { from: "w-caller", to: "w-new", kind: "spawn", count: 1, lastSeq: 10, lastTs: 5000 },
      ]);
    });

    it("derives a kill edge from a stamped worker_killed event", () => {
      const { ingestEvent } = useProvenanceStore.getState();
      ingestEvent(
        ev({
          seq: 11,
          type: "worker_killed",
          originWorker: "w-caller",
          payload: { workerId: "w-target" },
        }),
      );

      const edges = [...useProvenanceStore.getState().edges.values()];
      expect(edges).toHaveLength(1);
      expect(edges[0]).toMatchObject({ from: "w-caller", to: "w-target", kind: "kill" });
    });

    it("derives a command edge from a stamped worker_input event", () => {
      const { ingestEvent } = useProvenanceStore.getState();
      ingestEvent(
        ev({
          seq: 12,
          type: "worker_input",
          originWorker: "w-caller",
          payload: { workerId: "w-target", bytes: 11, source: "tool", preview: "pnpm build\n" },
        }),
      );

      const edges = [...useProvenanceStore.getState().edges.values()];
      expect(edges[0]).toMatchObject({ from: "w-caller", to: "w-target", kind: "command" });
    });

    it("derives a message edge from a bus_message event with a toWorker", () => {
      const { ingestEvent } = useProvenanceStore.getState();
      ingestEvent(
        ev({
          seq: 13,
          type: "bus_message",
          originWorker: "w-from",
          payload: {
            messageId: "m-1",
            fromWorker: "w-from",
            toWorker: "w-to",
            topic: "status",
            payload: {},
          },
        }),
      );

      const edges = [...useProvenanceStore.getState().edges.values()];
      expect(edges[0]).toMatchObject({ from: "w-from", to: "w-to", kind: "message" });
    });

    it("skips a broadcast bus_message (no toWorker) — no resolvable target", () => {
      const { ingestEvent } = useProvenanceStore.getState();
      ingestEvent(
        ev({
          seq: 14,
          type: "bus_message",
          originWorker: "w-from",
          payload: {
            messageId: "m-1",
            fromWorker: "w-from",
            toWorker: null,
            topic: "status",
            payload: {},
          },
        }),
      );

      expect(useProvenanceStore.getState().edges.size).toBe(0);
    });

    it("draws no edge for an unattributed event (originWorker absent)", () => {
      const { ingestEvent } = useProvenanceStore.getState();
      ingestEvent(
        ev({
          seq: 15,
          type: "worker_spawned",
          payload: { workerId: "w-new", name: "Human Spawned", pid: 1 },
        }),
      );

      expect(useProvenanceStore.getState().edges.size).toBe(0);
    });

    it("draws no edge for an event type with no edge-shaped target (e.g. worker_state)", () => {
      const { ingestEvent } = useProvenanceStore.getState();
      ingestEvent(
        ev({
          seq: 16,
          type: "worker_state",
          originWorker: "w-caller",
          payload: { workerId: "w-target", state: "running" },
        }),
      );

      expect(useProvenanceStore.getState().edges.size).toBe(0);
    });
  });

  describe("ingestEvent — collapse and count", () => {
    it("collapses repeated same-kind A->B occurrences into one record with an incrementing count", () => {
      const { ingestEvent } = useProvenanceStore.getState();
      ingestEvent(
        ev({
          seq: 20,
          ts: 1000,
          type: "worker_input",
          originWorker: "w-a",
          payload: { workerId: "w-b", bytes: 1, source: "tool" },
        }),
      );
      ingestEvent(
        ev({
          seq: 25,
          ts: 2000,
          type: "worker_input",
          originWorker: "w-a",
          payload: { workerId: "w-b", bytes: 1, source: "tool" },
        }),
      );
      ingestEvent(
        ev({
          seq: 30,
          ts: 3000,
          type: "worker_input",
          originWorker: "w-a",
          payload: { workerId: "w-b", bytes: 1, source: "tool" },
        }),
      );

      const edges = [...useProvenanceStore.getState().edges.values()];
      expect(edges).toHaveLength(1);
      expect(edges[0]).toEqual({
        from: "w-a",
        to: "w-b",
        kind: "command",
        count: 3,
        lastSeq: 30,
        lastTs: 3000,
      });
    });

    it("keeps different kinds between the same nodes as separate records (manual-acceptance parity: A->B spawn + A->B command, no merge)", () => {
      const { ingestEvent } = useProvenanceStore.getState();
      ingestEvent(
        ev({
          seq: 1,
          type: "worker_spawned",
          originWorker: "w-a",
          payload: { workerId: "w-b", name: "B", pid: 1 },
        }),
      );
      ingestEvent(
        ev({
          seq: 2,
          type: "worker_input",
          originWorker: "w-a",
          payload: { workerId: "w-b", bytes: 1, source: "tool" },
        }),
      );

      const edges = [...useProvenanceStore.getState().edges.values()];
      expect(edges).toHaveLength(2);
      expect(edges.map((e) => e.kind).toSorted()).toEqual(["command", "spawn"]);
    });
  });

  describe("ingestEvent — file_written badge, not an edge", () => {
    it("increments the origin worker's file-write count instead of drawing an edge", () => {
      const { ingestEvent } = useProvenanceStore.getState();
      ingestEvent(
        ev({
          seq: 40,
          type: "file_written",
          originWorker: "w-a",
          payload: { path: "/repo/out.txt", bytes: 7 },
        }),
      );
      ingestEvent(
        ev({
          seq: 41,
          type: "file_written",
          originWorker: "w-a",
          payload: { path: "/repo/out2.txt", bytes: 3 },
        }),
      );

      expect(useProvenanceStore.getState().edges.size).toBe(0);
      expect(useProvenanceStore.getState().fileWriteCounts.get("w-a")).toBe(2);
    });

    it("does not count an unattributed file_written (no originWorker to badge)", () => {
      const { ingestEvent } = useProvenanceStore.getState();
      ingestEvent(ev({ seq: 42, type: "file_written", payload: { path: "/x", bytes: 1 } }));

      expect(useProvenanceStore.getState().fileWriteCounts.size).toBe(0);
    });
  });

  describe("bySeq ring", () => {
    it("rings a persisted, causality-relevant event", () => {
      const { ingestEvent } = useProvenanceStore.getState();
      const e = ev({ seq: 100, type: "agent_turn_started", payload: { workerId: "w-a" } });
      ingestEvent(e);

      expect(useProvenanceStore.getState().bySeq.get(100)).toEqual(e);
    });

    it("excludes wire-frequent telemetry types from the ring", () => {
      const { ingestEvent } = useProvenanceStore.getState();
      for (const type of ["worker_output", "system_metrics", "agent_turn_delta", "system_log"]) {
        ingestEvent(ev({ seq: 1, type, payload: {} }));
      }

      expect(useProvenanceStore.getState().bySeq.size).toBe(0);
    });

    it("evicts the oldest entry once the ring exceeds its bound", () => {
      const { ingestEvent } = useProvenanceStore.getState();
      for (let seq = 1; seq <= RING_LIMIT; seq++) {
        ingestEvent(ev({ seq, type: "worker_state", payload: { workerId: "w", state: "idle" } }));
      }
      expect(useProvenanceStore.getState().bySeq.size).toBe(RING_LIMIT);
      expect(useProvenanceStore.getState().bySeq.has(1)).toBe(true);

      // One more push over the bound evicts exactly the oldest (seq 1).
      ingestEvent(
        ev({
          seq: RING_LIMIT + 1,
          type: "worker_state",
          payload: { workerId: "w", state: "idle" },
        }),
      );

      expect(useProvenanceStore.getState().bySeq.size).toBe(RING_LIMIT);
      expect(useProvenanceStore.getState().bySeq.has(1)).toBe(false);
      expect(useProvenanceStore.getState().bySeq.has(2)).toBe(true);
      expect(useProvenanceStore.getState().bySeq.has(RING_LIMIT + 1)).toBe(true);
    });
  });

  describe("notifications", () => {
    it("telemetry and ring-only events notify no subscriber", () => {
      const listener = vi.fn();
      const unsubscribe = useProvenanceStore.subscribe(listener);
      const { ingestEvent } = useProvenanceStore.getState();

      ingestEvent(ev({ seq: 1, type: "worker_output", payload: { workerId: "w", data: "x" } }));
      ingestEvent(ev({ seq: 2, type: "agent_turn_started", payload: { workerId: "w" } }));
      ingestEvent(ev({ seq: 3, type: "worker_spawned", payload: { workerId: "w" } })); // unstamped
      unsubscribe();

      expect(listener).not.toHaveBeenCalled();
      expect(useProvenanceStore.getState().bySeq.has(2)).toBe(true);
    });

    it("an edge change replaces the edges map (and leaves the file counts alone)", () => {
      const before = useProvenanceStore.getState();
      before.ingestEvent(
        ev({
          seq: 1,
          type: "worker_spawned",
          originWorker: "w-a",
          payload: { workerId: "w-b", name: "B", pid: 1 },
        }),
      );

      const after = useProvenanceStore.getState();
      expect(after.edges).not.toBe(before.edges);
      expect(after.fileWriteCounts).toBe(before.fileWriteCounts);
      expect(after.bySeq).toBe(before.bySeq);
    });
  });

  describe("reset", () => {
    it("clears edges, bySeq, and fileWriteCounts", () => {
      const { ingestEvent, reset } = useProvenanceStore.getState();
      ingestEvent(
        ev({
          seq: 1,
          type: "worker_spawned",
          originWorker: "w-a",
          payload: { workerId: "w-b", name: "B", pid: 1 },
        }),
      );
      ingestEvent(
        ev({
          seq: 2,
          type: "file_written",
          originWorker: "w-a",
          payload: { path: "/x", bytes: 1 },
        }),
      );

      reset();

      const state = useProvenanceStore.getState();
      expect(state.edges.size).toBe(0);
      expect(state.bySeq.size).toBe(0);
      expect(state.fileWriteCounts.size).toBe(0);
    });
  });
});

describe("selectVisibleEdges — endpoint-drop", () => {
  it("keeps an edge only when both endpoints are live workers", () => {
    const edges = new Map([
      [
        "a->b:spawn",
        { from: "a", to: "b", kind: "spawn" as const, count: 1, lastSeq: 1, lastTs: 1 },
      ],
      ["c->d:kill", { from: "c", to: "d", kind: "kill" as const, count: 1, lastSeq: 2, lastTs: 2 }],
    ]);

    const visible = selectVisibleEdges(edges, new Set(["a", "b", "c"])); // d is gone

    expect(visible).toHaveLength(1);
    expect(visible[0]).toMatchObject({ from: "a", to: "b" });
  });

  it("returns an empty array when the edge map is empty", () => {
    expect(selectVisibleEdges(new Map(), new Set(["a"]))).toEqual([]);
  });
});

describe("selectMostRecentSeqForWorker", () => {
  it("returns the highest lastSeq among edges where the worker is either endpoint", () => {
    const edges = new Map([
      [
        "a->b:spawn",
        { from: "a", to: "b", kind: "spawn" as const, count: 1, lastSeq: 5, lastTs: 5 },
      ],
      [
        "c->a:kill",
        { from: "c", to: "a", kind: "kill" as const, count: 1, lastSeq: 12, lastTs: 12 },
      ],
      [
        "a->d:command",
        {
          from: "a",
          to: "d",
          kind: "command" as const,
          count: 1,
          lastSeq: 9,
          lastTs: 9,
        },
      ],
    ]);

    expect(selectMostRecentSeqForWorker(edges, "a")).toBe(12);
  });

  it("returns null when the worker has no measured causality", () => {
    const edges = new Map([
      [
        "a->b:spawn",
        { from: "a", to: "b", kind: "spawn" as const, count: 1, lastSeq: 5, lastTs: 5 },
      ],
    ]);

    expect(selectMostRecentSeqForWorker(edges, "z")).toBeNull();
  });
});
