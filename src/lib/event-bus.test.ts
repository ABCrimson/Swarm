import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const listeners = new Map<string, (payload: unknown) => void>();
const invokeMock = vi.fn();

vi.mock("#lib/tauri", () => ({
  listen: vi.fn(async (event: string, handler: (payload: unknown) => void) => {
    listeners.set(event, handler);
    return () => listeners.delete(event);
  }),
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import {
  connectEventBus,
  type DomainEvent,
  getLastSeq,
  onEvent,
  resetEventBus,
  waitFor,
} from "#lib/event-bus";

function push(e: unknown): void {
  listeners.get("swarm://events")?.(e);
}

const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** A `worker_spawned` envelope whose payload matches the Rust `WorkerSpawnedPayload`. */
const ev = (seq: number): DomainEvent => ({
  seq,
  ts: seq * 1000,
  type: "worker_spawned",
  payload: { workerId: uuid(seq), name: `Worker ${seq}`, pid: null, isolation: "none" },
});

const page = (from: number, to: number): DomainEvent[] =>
  Array.from({ length: to - from + 1 }, (_, i) => ev(from + i));

describe("event-bus", () => {
  beforeEach(() => {
    listeners.clear();
    invokeMock.mockReset();
    resetEventBus();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe("dispatch", () => {
    it("dispatches events to type subscribers in order", async () => {
      await connectEventBus();
      const seen: number[] = [];
      onEvent("worker_spawned", (e) => seen.push(e.seq));
      push(ev(1));
      push(ev(2));
      expect(seen).toStrictEqual([1, 2]);
    });

    it("hands typed subscribers the parsed payload", async () => {
      await connectEventBus();
      const names: string[] = [];
      onEvent("worker_spawned", (e) => names.push(e.payload.name));
      push(ev(1));
      expect(names).toStrictEqual(["Worker 1"]);
    });

    it("keeps payload fields the schema does not declare", async () => {
      await connectEventBus();
      let payload: Record<string, unknown> | undefined;
      onEvent("worker_killed", (e) => {
        payload = e.payload;
      });
      push({
        seq: 1,
        ts: 1,
        type: "worker_killed",
        payload: { workerId: uuid(1), reason: "exit" },
      });
      expect(payload).toStrictEqual({ workerId: uuid(1), reason: "exit" });
    });

    it("drops an invalid payload for typed subscribers but still gives wildcard subscribers the envelope", async () => {
      await connectEventBus();
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const typed = vi.fn();
      const all: DomainEvent[] = [];
      onEvent("worker_state", typed);
      onEvent("*", (e) => all.push(e));

      const bad = {
        seq: 1,
        ts: 1,
        type: "worker_state",
        payload: { workerId: uuid(1), state: "zombie" },
      };
      push(bad);

      expect(typed).not.toHaveBeenCalled();
      expect(all).toStrictEqual([bad]);
      expect(error).toHaveBeenCalledWith(
        "event-bus: invalid worker_state payload at seq 1",
        expect.any(Array),
      );
      expect(getLastSeq()).toBe(1);
    });

    it("drops an invalid envelope without dispatching it", async () => {
      await connectEventBus();
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const all = vi.fn();
      onEvent("*", all);

      push({ seq: "x", type: "worker_spawned" });

      expect(all).not.toHaveBeenCalled();
      expect(error).toHaveBeenCalledWith("event-bus: invalid envelope", expect.any(Array));
      expect(getLastSeq()).toBe(0);
    });

    it("delivers every event to wildcard subscribers and tracks the last seq", async () => {
      await connectEventBus();
      const seen: string[] = [];
      onEvent("*", (e) => seen.push(`${e.seq}:${e.type}`));
      push(ev(1));
      push({ seq: 2, ts: 2, type: "future_event_type", payload: 42 });
      expect(seen).toStrictEqual(["1:worker_spawned", "2:future_event_type"]);
      expect(getLastSeq()).toBe(2);
    });

    it("unsubscribe stops delivery", async () => {
      await connectEventBus();
      const seen: number[] = [];
      const off = onEvent("worker_spawned", (e) => seen.push(e.seq));
      push(ev(1));
      off();
      push(ev(2));
      expect(seen).toStrictEqual([1]);
    });

    it("a throwing handler does not break fan-out to other subscribers or waitFor", async () => {
      await connectEventBus();
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const seen: number[] = [];
      onEvent("worker_spawned", () => {
        throw new Error("boom");
      });
      onEvent("worker_spawned", (e) => seen.push(e.seq));
      const settled = waitFor((e) => e.type === "worker_spawned");

      push(ev(1));

      expect(seen).toStrictEqual([1]);
      await expect(settled).resolves.toMatchObject({ seq: 1 });
      expect(error).toHaveBeenCalledWith("event-bus: handler threw", expect.any(Error));
    });

    it("delivers a stamped envelope's originWorker/causeSeq unstripped", async () => {
      await connectEventBus();
      let received: DomainEvent | undefined;
      onEvent("worker_input", (e) => {
        received = e;
      });

      push({
        seq: 1,
        ts: 1000,
        type: "worker_input",
        payload: { workerId: uuid(1), bytes: 3, source: "tool" },
        originWorker: "w-origin",
        causeSeq: 41,
      });

      expect(received?.originWorker).toBe("w-origin");
      expect(received?.causeSeq).toBe(41);
    });

    it("leaves an unstamped envelope's originWorker/causeSeq undefined", async () => {
      await connectEventBus();
      let received: DomainEvent | undefined;
      onEvent("worker_spawned", (e) => {
        received = e;
      });

      push(ev(1));

      expect(received).not.toHaveProperty("originWorker");
      expect(received).not.toHaveProperty("causeSeq");
    });
  });

  describe("waitFor", () => {
    it("resolves on a matching receipt", async () => {
      await connectEventBus();
      const settled = waitFor((e) => e.type === "ship_settled");
      push({
        seq: 1,
        ts: 1,
        type: "ship_settled",
        payload: { shipId: uuid(101), workerId: uuid(1), status: "ok" },
      });
      await expect(settled).resolves.toMatchObject({ type: "ship_settled" });
    });

    it("by type, resolves with the parsed payload of the first match", async () => {
      await connectEventBus();
      const settled = waitFor("ship_settled", (e) => e.payload.shipId === uuid(102));
      push({
        seq: 1,
        ts: 1,
        type: "ship_settled",
        payload: { shipId: uuid(101), workerId: uuid(1), status: "ok" },
      });
      push({
        seq: 2,
        ts: 2,
        type: "ship_settled",
        payload: { shipId: uuid(102), workerId: uuid(1), status: "error" },
      });
      await expect(settled).resolves.toMatchObject({ seq: 2, payload: { status: "error" } });
    });

    it("rejects on timeout", async () => {
      vi.useFakeTimers();
      await connectEventBus();
      const settled = waitFor((e) => e.type === "never", 100);
      const assertion = expect(settled).rejects.toThrow("waitFor timeout after 100ms");
      await vi.advanceTimersByTimeAsync(150);
      await assertion;
    });
  });

  describe("backfill", () => {
    it("backfills a seq gap via events_since and preserves order", async () => {
      invokeMock.mockResolvedValueOnce([ev(2), ev(3)]);
      await connectEventBus();
      const seen: number[] = [];
      onEvent("worker_spawned", (e) => seen.push(e.seq));

      push(ev(1));
      push(ev(4)); // gap: 2 and 3 missing
      await vi.waitFor(() => expect(seen).toStrictEqual([1, 2, 3, 4]));
      expect(invokeMock).toHaveBeenCalledExactlyOnceWith("events_since", { afterSeq: 1 });
    });

    it("does not double-dispatch backfilled events already seen live", async () => {
      invokeMock.mockResolvedValueOnce([ev(2), ev(3), ev(4)]);
      await connectEventBus();
      const seen: number[] = [];
      onEvent("worker_spawned", (e) => seen.push(e.seq));

      push(ev(1));
      push(ev(4)); // triggers a backfill that also contains 4
      await vi.waitFor(() => expect(seen).toStrictEqual([1, 2, 3, 4]));
    });

    it("pages through a full events_since page from the last row's seq", async () => {
      invokeMock.mockResolvedValueOnce(page(2, 5001));
      invokeMock.mockResolvedValueOnce(page(5002, 5003));
      await connectEventBus();
      const seen: number[] = [];
      onEvent("worker_spawned", (e) => seen.push(e.seq));

      push(ev(1));
      push(ev(5004));
      await vi.waitFor(() => expect(seen).toHaveLength(5004));
      expect(seen).toStrictEqual(Array.from({ length: 5004 }, (_, i) => i + 1));
      expect(invokeMock).toHaveBeenNthCalledWith(1, "events_since", { afterSeq: 1 });
      expect(invokeMock).toHaveBeenNthCalledWith(2, "events_since", { afterSeq: 5001 });
    });

    it("skips an invalid backfill row and dispatches the rest", async () => {
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      invokeMock.mockResolvedValueOnce([ev(2), { seq: "3" }, ev(4)]);
      await connectEventBus();
      const seen: number[] = [];
      onEvent("worker_spawned", (e) => seen.push(e.seq));

      push(ev(1));
      push(ev(5));
      await vi.waitFor(() => expect(seen).toStrictEqual([1, 2, 4, 5]));
      expect(error).toHaveBeenCalledWith(
        "event-bus: skipped an invalid backfill row",
        expect.any(Array),
      );
    });

    it("retries a failed backfill after a backoff, with the original afterSeq, and delivers in order", async () => {
      vi.useFakeTimers();
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      invokeMock.mockRejectedValueOnce(new Error("network down"));
      invokeMock.mockResolvedValueOnce([ev(2), ev(3)]);
      await connectEventBus();
      const seen: number[] = [];
      onEvent("worker_spawned", (e) => seen.push(e.seq));

      push(ev(1));
      push(ev(4)); // gap: backfill(afterSeq 1) rejects
      await vi.advanceTimersByTimeAsync(0);
      expect(invokeMock).toHaveBeenCalledOnce();
      expect(error).toHaveBeenCalledWith("event-bus: backfill failed:", expect.any(Error));

      push(ev(5)); // buffered while the retry waits: no second call yet
      await vi.advanceTimersByTimeAsync(249);
      expect(invokeMock).toHaveBeenCalledOnce();
      expect(seen).toStrictEqual([1]);

      await vi.advanceTimersByTimeAsync(1);
      expect(invokeMock).toHaveBeenNthCalledWith(2, "events_since", { afterSeq: 1 });
      expect(seen).toStrictEqual([1, 2, 3, 4, 5]);

      push(ev(6)); // the bus works normally afterwards
      expect(seen).toStrictEqual([1, 2, 3, 4, 5, 6]);
      expect(invokeMock).toHaveBeenCalledTimes(2);
    });

    it("backs off exponentially and gives up on the gap after six failures, delivering what it buffered", async () => {
      vi.useFakeTimers();
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      vi.spyOn(console, "debug").mockImplementation(() => {});
      invokeMock.mockRejectedValue(new Error("Not Connected To The SWARM Daemon."));
      await connectEventBus();
      const seen: number[] = [];
      onEvent("worker_spawned", (e) => seen.push(e.seq));

      push(ev(1));
      push(ev(4));
      const callTimes: number[] = [];
      for (let t = 0; t <= 20_000; t += 50) {
        if (invokeMock.mock.calls.length > callTimes.length) callTimes.push(t);
        await vi.advanceTimersByTimeAsync(50);
      }

      expect(callTimes).toStrictEqual([0, 250, 750, 1750, 3750, 7750]);
      expect(seen).toStrictEqual([1, 4]);
      expect(error).toHaveBeenCalledWith(
        "event-bus: backfill after seq 1 failed 6 times; giving up on the missing events",
      );

      push(ev(5));
      expect(seen).toStrictEqual([1, 4, 5]);
      expect(invokeMock).toHaveBeenCalledTimes(6);
    });

    it("a gap detected among flushed pending events triggers a second backfill", async () => {
      invokeMock.mockResolvedValueOnce([ev(2)]); // first backfill: afterSeq 1
      invokeMock.mockResolvedValueOnce([ev(4), ev(5)]); // second: afterSeq 3, from a gap within the flush
      await connectEventBus();
      const seen: number[] = [];
      onEvent("worker_spawned", (e) => seen.push(e.seq));

      push(ev(1));
      push(ev(3)); // gap: triggers backfill(afterSeq 1)
      push(ev(6)); // arrives mid-backfill; buffered without a gap check yet

      await vi.waitFor(() => expect(seen).toStrictEqual([1, 2, 3, 4, 5, 6]));
      expect(invokeMock).toHaveBeenCalledTimes(2);
      expect(invokeMock).toHaveBeenNthCalledWith(1, "events_since", { afterSeq: 1 });
      expect(invokeMock).toHaveBeenNthCalledWith(2, "events_since", { afterSeq: 3 });
    });

    it("an entirely ephemeral gap converges instead of re-triggering backfill forever", async () => {
      // Every events_since call comes back empty: seqs 2-4 were consumed
      // by events that are never persisted (e.g. terminal-source input).
      const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
      invokeMock.mockResolvedValue([]);
      await connectEventBus();
      const seen: number[] = [];
      onEvent("worker_spawned", (e) => seen.push(e.seq));

      push(ev(1));
      push(ev(5));

      await vi.waitFor(() => expect(seen).toStrictEqual([1, 5]));
      expect(invokeMock).toHaveBeenCalledOnce();
      expect(debug).toHaveBeenCalledWith(
        "event-bus: gap after seq 1 is entirely ephemeral; skipping ahead to seq 5",
      );

      push(ev(6));
      expect(seen).toStrictEqual([1, 5, 6]);
      expect(invokeMock).toHaveBeenCalledOnce();
    });

    it("a gap with a persisted head and an ephemeral tail backfills the persisted part, then converges", async () => {
      vi.spyOn(console, "debug").mockImplementation(() => {});
      invokeMock.mockResolvedValueOnce([ev(2), ev(3)]); // real rows, but they do not reach seq 10
      invokeMock.mockResolvedValueOnce([]); // seqs 4-9 are entirely ephemeral
      await connectEventBus();
      const seen: number[] = [];
      onEvent("worker_spawned", (e) => seen.push(e.seq));

      push(ev(1));
      push(ev(10));

      await vi.waitFor(() => expect(seen).toStrictEqual([1, 2, 3, 10]));
      expect(invokeMock).toHaveBeenCalledTimes(2);
      expect(invokeMock).toHaveBeenNthCalledWith(1, "events_since", { afterSeq: 1 });
      expect(invokeMock).toHaveBeenNthCalledWith(2, "events_since", { afterSeq: 3 });
    });
  });
});
