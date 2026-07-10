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
});
