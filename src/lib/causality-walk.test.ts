// walkCausalityChain: the backward `causeSeq` walk (ring first, then a
// single-row `events_since` backfill) behind the CausalityPanel trace.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_CAUSALITY_HOPS, walkCausalityChain } from "#lib/causality-walk";
import type { DomainEvent } from "#lib/event-bus";

const { invoke } = vi.hoisted(() => ({
  invoke: vi.fn<(cmd: string, args?: Record<string, unknown>) => Promise<unknown>>(),
}));
vi.mock(import("#lib/tauri"), () => ({ invoke }) as never);

function ev(
  overrides: Partial<DomainEvent> & Pick<DomainEvent, "seq" | "type" | "payload">,
): DomainEvent {
  return { ts: overrides.seq * 1000, ...overrides };
}

beforeEach(() => {
  invoke.mockReset();
});

describe("walkCausalityChain", () => {
  it("walks entirely from the ring when every hop is cached, terminating on a real root (no causeSeq)", async () => {
    const root = ev({ seq: 412, type: "agent_turn_started", payload: { workerId: "w-a" } });
    const spawn = ev({
      seq: 418,
      type: "worker_spawned",
      originWorker: "w-a",
      causeSeq: 412,
      payload: { workerId: "w-b", name: "B", pid: 1 },
    });
    const ring = new Map([
      [root.seq, root],
      [spawn.seq, spawn],
    ]);

    const result = await walkCausalityChain(418, ring);

    expect(invoke).not.toHaveBeenCalled();
    expect(result.truncated).toBe(false);
    expect(result.incomplete).toBe(false);
    expect(result.rows.map((r) => r.seq)).toEqual([412, 418]); // root-first order
  });

  it("falls back to a single-row events_since backfill on a ring miss", async () => {
    const root = ev({ seq: 100, type: "agent_turn_started", payload: { workerId: "w-a" } });
    invoke.mockResolvedValueOnce([root]);

    const startEvent = ev({
      seq: 105,
      type: "worker_input",
      originWorker: "w-a",
      causeSeq: 100,
      payload: { workerId: "w-b", bytes: 4, source: "tool", preview: "ls\n" },
    });
    const ring = new Map([[startEvent.seq, startEvent]]); // root (100) is NOT cached

    const result = await walkCausalityChain(105, ring);

    expect(invoke).toHaveBeenCalledWith("events_since", { afterSeq: 99, limit: 1 });
    expect(result.truncated).toBe(false);
    expect(result.incomplete).toBe(false);
    expect(result.rows.map((r) => r.seq)).toEqual([100, 105]);
  });

  it("treats a backfill row whose seq doesn't match the requested seq as a miss (the row.seq !== seq guard)", async () => {
    // events_since is asked for seq 100 (afterSeq: 99) but the mocked
    // response comes back with a DIFFERENT seq -- a gap/skip in what's
    // persisted. The guard must null this out rather than trust the wrong
    // row.
    const wrongSeqRow = ev({ seq: 101, type: "agent_turn_started", payload: { workerId: "w-a" } });
    invoke.mockResolvedValueOnce([wrongSeqRow]);

    const startEvent = ev({
      seq: 105,
      type: "worker_input",
      originWorker: "w-a",
      causeSeq: 100,
      payload: { workerId: "w-b", bytes: 4, source: "tool", preview: "ls\n" },
    });
    const ring = new Map([[startEvent.seq, startEvent]]);

    const result = await walkCausalityChain(105, ring);

    expect(invoke).toHaveBeenCalledWith("events_since", { afterSeq: 99, limit: 1 });
    expect(result.incomplete).toBe(true);
    expect(result.truncated).toBe(false);
    // Only the starting event resolved -- the mismatched row was rejected.
    expect(result.rows.map((r) => r.seq)).toEqual([105]);
  });

  it("ends the walk early and marks the result incomplete (not truncated) when a lookup genuinely misses", async () => {
    const startEvent = ev({
      seq: 50,
      type: "worker_killed",
      originWorker: "w-a",
      causeSeq: 10, // nothing will be found for seq 10
      payload: { workerId: "w-b" },
    });
    const ring = new Map([[startEvent.seq, startEvent]]);
    invoke.mockResolvedValueOnce([]); // events_since confirms nothing persisted there

    const result = await walkCausalityChain(50, ring);

    expect(result.rows.map((r) => r.seq)).toEqual([50]);
    expect(result.truncated).toBe(false);
    expect(result.incomplete).toBe(true);
  });

  it("terminates immediately for a root event with no causeSeq at all, marked neither truncated nor incomplete", async () => {
    const root = ev({ seq: 1, type: "agent_turn_started", payload: { workerId: "w-a" } });
    const ring = new Map([[root.seq, root]]);

    const result = await walkCausalityChain(1, ring);

    expect(invoke).not.toHaveBeenCalled();
    expect(result.rows.map((r) => r.seq)).toEqual([1]);
    expect(result.truncated).toBe(false);
    expect(result.incomplete).toBe(false);
  });

  it(`stops at ${MAX_CAUSALITY_HOPS} rows and reports truncated (not incomplete) when the chain is deeper than the cap`, async () => {
    // A synthetic chain one deeper than the cap (seq 1..depth), each
    // citing seq-1 as its cause, with seq 1 the true (never-reached) root.
    const depth = MAX_CAUSALITY_HOPS + 1;
    const ring = new Map<number, DomainEvent>();
    for (let seq = 1; seq <= depth; seq++) {
      ring.set(
        seq,
        ev({
          seq,
          type: "worker_state",
          causeSeq: seq > 1 ? seq - 1 : undefined,
          payload: { workerId: "w", state: "idle" },
        }),
      );
    }

    const result = await walkCausalityChain(depth, ring);

    expect(invoke).not.toHaveBeenCalled();
    expect(result.truncated).toBe(true);
    expect(result.incomplete).toBe(false);
    expect(result.rows).toHaveLength(MAX_CAUSALITY_HOPS);
    // The true root (seq 1) is excluded -- the cap bit before reaching it.
    expect(result.rows.map((r) => r.seq)).not.toContain(1);
    expect(result.rows.at(0)?.seq).toBe(depth - MAX_CAUSALITY_HOPS + 1);
    expect(result.rows.at(-1)?.seq).toBe(depth);
  });

  it("stops issuing lookups once the signal aborts", async () => {
    const controller = new AbortController();
    const start = ev({ seq: 9, type: "worker_input", causeSeq: 5, payload: { workerId: "w" } });
    invoke.mockImplementationOnce(async () => {
      controller.abort(new Error("closed"));
      return [ev({ seq: 5, type: "worker_input", causeSeq: 1, payload: { workerId: "w" } })];
    });

    await expect(
      walkCausalityChain(9, new Map([[start.seq, start]]), controller.signal),
    ).rejects.toThrow("closed");
    expect(invoke).toHaveBeenCalledTimes(1); // seq 1 is never fetched
  });
});
