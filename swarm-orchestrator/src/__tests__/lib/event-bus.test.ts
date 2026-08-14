import { beforeEach, describe, expect, it, vi } from "vitest";

const listeners = new Map<string, (payload: unknown) => void>();
const invokeMock = vi.fn();

vi.mock("#lib/tauri", () => ({
  listen: vi.fn(async (event: string, handler: (payload: unknown) => void) => {
    listeners.set(event, handler);
    return () => listeners.delete(event);
  }),
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import { connectEventBus, type DomainEvent, onEvent, resetEventBus, waitFor } from "#lib/event-bus";

function push(e: DomainEvent): void {
  listeners.get("swarm://events")?.(e);
}

const ev = (seq: number, type = "worker_spawned"): DomainEvent => ({
  seq,
  ts: seq * 1000,
  type,
  payload: { workerId: `w-${seq}` },
});

describe("event-bus", () => {
  beforeEach(() => {
    listeners.clear();
    invokeMock.mockReset();
    resetEventBus();
  });

  it("dispatches events to type subscribers in order", async () => {
    await connectEventBus();
    const seen: number[] = [];
    onEvent("worker_spawned", (e) => seen.push(e.seq));
    push(ev(1));
    push(ev(2));
    expect(seen).toEqual([1, 2]);
  });

  it("unsubscribe stops delivery", async () => {
    await connectEventBus();
    const seen: number[] = [];
    const off = onEvent("worker_spawned", (e) => seen.push(e.seq));
    push(ev(1));
    off();
    push(ev(2));
    expect(seen).toEqual([1]);
  });

  it("backfills a seq gap via events_since and preserves order", async () => {
    invokeMock.mockResolvedValueOnce([ev(2), ev(3)]);
    await connectEventBus();
    const seen: number[] = [];
    onEvent("worker_spawned", (e) => seen.push(e.seq));

    push(ev(1));
    push(ev(4)); // gap: 2,3 missing
    await vi.waitFor(() => expect(seen).toEqual([1, 2, 3, 4]));
    expect(invokeMock).toHaveBeenCalledWith("events_since", { afterSeq: 1 });
  });

  it("does not double-dispatch backfilled events already seen live", async () => {
    invokeMock.mockResolvedValueOnce([ev(2), ev(3), ev(4)]);
    await connectEventBus();
    const seen: number[] = [];
    onEvent("worker_spawned", (e) => seen.push(e.seq));

    push(ev(1));
    push(ev(4)); // triggers backfill that ALSO contains 4
    await vi.waitFor(() => expect(seen).toEqual([1, 2, 3, 4]));
  });

  it("waitFor resolves on a matching receipt", async () => {
    await connectEventBus();
    const settled = waitFor((e) => e.type === "ai_stream_settled");
    push({ seq: 1, ts: 1, type: "ai_stream_settled", payload: { requestId: "r1", status: "ok" } });
    await expect(settled).resolves.toMatchObject({ type: "ai_stream_settled" });
  });

  it("waitFor rejects on timeout", async () => {
    vi.useFakeTimers();
    await connectEventBus();
    const settled = waitFor((e) => e.type === "never", 100);
    vi.advanceTimersByTime(150);
    await expect(settled).rejects.toThrow(/timeout/i);
    vi.useRealTimers();
  });

  it("backfill rejection does not lose the gap: pending events re-enter the gap-check path and retry with the original afterSeq; missed events are eventually delivered in order", async () => {
    invokeMock.mockRejectedValueOnce(new Error("network down"));
    invokeMock.mockResolvedValueOnce([ev(2), ev(3)]);
    await connectEventBus();
    const seen: number[] = [];
    onEvent("worker_spawned", (e) => seen.push(e.seq));

    push(ev(1));
    push(ev(4)); // gap: triggers backfill(afterSeq: 1), which rejects

    await vi.waitFor(() => expect(seen).toEqual([1, 2, 3, 4]));
    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(invokeMock).toHaveBeenNthCalledWith(1, "events_since", { afterSeq: 1 });
    expect(invokeMock).toHaveBeenNthCalledWith(2, "events_since", { afterSeq: 1 });

    // the bus keeps working normally afterward — no extra backfill needed
    push(ev(5));
    expect(seen).toEqual([1, 2, 3, 4, 5]);
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });

  it("a gap detected among flushed pending events triggers a second backfill", async () => {
    invokeMock.mockResolvedValueOnce([ev(2), ev(3)]); // first backfill: afterSeq 1
    invokeMock.mockResolvedValueOnce([ev(4), ev(5)]); // second backfill: afterSeq 3, from a gap within the flush
    await connectEventBus();
    const seen: number[] = [];
    onEvent("worker_spawned", (e) => seen.push(e.seq));

    push(ev(1));
    push(ev(3)); // gap: triggers backfill(afterSeq: 1)
    push(ev(6)); // arrives mid-backfill; buffered as pending without a gap check yet

    await vi.waitFor(() => expect(seen).toEqual([1, 2, 3, 4, 5, 6]));
    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(invokeMock).toHaveBeenNthCalledWith(1, "events_since", { afterSeq: 1 });
    expect(invokeMock).toHaveBeenNthCalledWith(2, "events_since", { afterSeq: 3 });
  });

  it("an entirely-ephemeral gap converges instead of wedging backfill forever", async () => {
    // Every events_since call comes back empty — the gap (seqs 2-4) is
    // e.g. an all-terminal-source worker_input stretch: consumed a seq,
    // never persisted.
    invokeMock.mockResolvedValue([]);
    await connectEventBus();
    const seen: number[] = [];
    onEvent("worker_spawned", (e) => seen.push(e.seq));

    push(ev(1));
    push(ev(5)); // gap: triggers backfill(afterSeq: 1)

    await vi.waitFor(() => expect(seen).toEqual([1, 5]));
    expect(invokeMock).toHaveBeenCalledTimes(1);

    // The wedge this test guards against: without the fix, lastSeq never
    // advances on an empty page, so every subsequent live event would
    // re-detect "the same" gap and re-trigger backfill forever.
    push(ev(6));
    expect(seen).toEqual([1, 5, 6]);
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it("a gap with a persisted head and an ephemeral tail still backfills the persisted part, then converges", async () => {
    invokeMock.mockResolvedValueOnce([ev(2), ev(3)]); // first backfill(afterSeq: 1): real rows, but doesn't reach seq 10
    invokeMock.mockResolvedValueOnce([]); // second backfill(afterSeq: 3): seqs 4-9 are entirely ephemeral
    await connectEventBus();
    const seen: number[] = [];
    onEvent("worker_spawned", (e) => seen.push(e.seq));

    push(ev(1));
    push(ev(10)); // gap: triggers backfill(afterSeq: 1)

    await vi.waitFor(() => expect(seen).toEqual([1, 2, 3, 10]));
    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(invokeMock).toHaveBeenNthCalledWith(1, "events_since", { afterSeq: 1 });
    expect(invokeMock).toHaveBeenNthCalledWith(2, "events_since", { afterSeq: 3 });
  });

  it("delivers a stamped envelope's originWorker/causeSeq to handlers unstripped", async () => {
    await connectEventBus();
    let received: DomainEvent | undefined;
    onEvent("worker_input", (e) => {
      received = e;
    });

    push({
      seq: 1,
      ts: 1000,
      type: "worker_input",
      payload: { workerId: "w-1", bytes: 3, source: "tool" },
      originWorker: "w-origin",
      causeSeq: 41,
    });

    expect(received?.originWorker).toBe("w-origin");
    expect(received?.causeSeq).toBe(41);
  });

  it("an unstamped envelope's originWorker/causeSeq are undefined, not stripped-to-null", async () => {
    await connectEventBus();
    let received: DomainEvent | undefined;
    onEvent("worker_spawned", (e) => {
      received = e;
    });

    push(ev(1));

    expect(received?.originWorker).toBeUndefined();
    expect(received?.causeSeq).toBeUndefined();
  });

  it("a throwing handler does not break fan-out to other subscribers or waitFor", async () => {
    await connectEventBus();
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const seen: number[] = [];
    onEvent("worker_spawned", () => {
      throw new Error("boom");
    });
    onEvent("worker_spawned", (e) => seen.push(e.seq));
    const settled = waitFor((e) => e.type === "worker_spawned");

    push(ev(1));

    expect(seen).toEqual([1]);
    await expect(settled).resolves.toMatchObject({ seq: 1 });
    expect(consoleErrorSpy).toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });
});
