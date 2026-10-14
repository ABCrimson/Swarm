// ── createAcknowledgedSync — the one-slot push contract ──
//
// The helper behind both Settings caps, driven directly: one call in
// flight, newest-wins queueing, rollback with Retry, and the late-reply
// re-send. The hooks' own tests cover the wiring.

import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CAP_ACK_TIMEOUT_MS, type CapSync, createAcknowledgedSync } from "#lib/acknowledged-sync";

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), dismiss: vi.fn() }),
}));

/** Replies the tests resolve with; `undefined` is a reply with no value at all. */
type R = number | null | undefined;

/** A sync over a controllable call; `feedback` re-applies every shown value, as the bridge's effect does. */
function harness(initial = 64, feedback = false) {
  let status: CapSync = { status: "idle" };
  let shown = initial;
  const pending: PromiseWithResolvers<R>[] = [];
  const call = vi.fn((_v: number) => {
    const d = Promise.withResolvers<R>();
    pending.push(d);
    return d.promise as Promise<number | null>;
  });
  const applied = vi.fn();
  const sync: ReturnType<typeof createAcknowledgedSync> = createAcknowledgedSync({
    initial,
    call,
    show: (v) => {
      shown = v;
      if (feedback) sync.apply(v); // simulates useSettingsBridge's effect re-running on the shown value
    },
    getStatus: () => status,
    setStatus: (s) => {
      status = s;
    },
    logPrefix: "probe",
    failureTitle: "Probe Failed",
    toastId: "probe",
    onApplied: applied,
  });
  return {
    sync,
    call,
    pending,
    applied,
    get shown() {
      return shown;
    },
    get status() {
      return status;
    },
  };
}
const flush = async () => {
  await vi.advanceTimersByTimeAsync(0);
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.clearAllMocks();
});
afterEach(() => vi.useRealTimers());

describe("createAcknowledgedSync", () => {
  it("one in flight; collapse to latest", async () => {
    const h = harness();
    h.sync.push(12);
    h.sync.push(11);
    h.sync.push(10);
    expect(h.call.mock.calls).toStrictEqual([[12]]);
    h.pending[0].resolve(12);
    await flush();
    expect(h.call.mock.calls).toStrictEqual([[12], [10]]);
    h.pending[1].resolve(10);
    await flush();
    expect(h.shown).toBe(10);
    expect(h.status.status).toBe("idle");
  });
  it("queued goes out on timeout", async () => {
    const h = harness();
    h.sync.push(12);
    h.sync.push(10);
    await vi.advanceTimersByTimeAsync(CAP_ACK_TIMEOUT_MS);
    expect(h.call.mock.calls).toStrictEqual([[12], [10]]);
    expect(h.status.status).toBe("pending");
  });
  it("timeout -> late success -> newer edit sends [[a],[b]] only", async () => {
    const h = harness();
    h.sync.apply(12);
    await vi.advanceTimersByTimeAsync(CAP_ACK_TIMEOUT_MS);
    expect(h.status.status).toBe("failed");
    expect(h.shown).toBe(64);
    h.pending[0].resolve(12);
    await flush();
    expect(h.shown).toBe(12);
    expect(h.status.status).toBe("idle");
    expect(toast.dismiss).toHaveBeenCalledWith("probe");
    h.sync.apply(20);
    h.pending[1].resolve(20);
    await flush();
    expect(h.call.mock.calls).toStrictEqual([[12], [20]]);
  });
  it("two timeouts, replies in send order", async () => {
    const h = harness();
    h.sync.apply(12);
    await vi.advanceTimersByTimeAsync(CAP_ACK_TIMEOUT_MS);
    h.sync.apply(20);
    await vi.advanceTimersByTimeAsync(CAP_ACK_TIMEOUT_MS);
    h.pending[0].resolve(12);
    await flush();
    h.pending[1].resolve(20);
    await flush();
    expect(h.call.mock.calls).toStrictEqual([[12], [20]]);
    expect(h.shown).toBe(20);
    expect(h.status.status).toBe("idle");
  });
  it("two timeouts, replies reversed -> latest re-sent exactly once", async () => {
    const h = harness();
    h.sync.apply(12);
    await vi.advanceTimersByTimeAsync(CAP_ACK_TIMEOUT_MS);
    h.sync.apply(20);
    await vi.advanceTimersByTimeAsync(CAP_ACK_TIMEOUT_MS);
    h.pending[1].resolve(20);
    await flush();
    h.pending[0].resolve(12);
    await flush();
    expect(h.call.mock.calls).toStrictEqual([[12], [20], [20]]);
    h.pending[2].resolve(20);
    await flush();
    expect(h.call.mock.calls).toStrictEqual([[12], [20], [20]]);
    expect(h.shown).toBe(20);
    expect(h.status.status).toBe("idle");
  });
  it("Retry of timed-out value whose original later resolves", async () => {
    const h = harness();
    h.sync.apply(12);
    await vi.advanceTimersByTimeAsync(CAP_ACK_TIMEOUT_MS);
    const s = h.status;
    if (s.status !== "failed") throw new Error("not failed");
    s.retry();
    expect(h.call.mock.calls).toStrictEqual([[12], [12]]);
    expect(h.shown).toBe(12);
    expect(h.status.status).toBe("pending");
    h.pending[0].resolve(12);
    await flush();
    expect(h.status.status).toBe("pending");
    h.pending[1].resolve(12);
    await flush();
    expect(h.call.mock.calls).toStrictEqual([[12], [12]]);
    expect(h.shown).toBe(12);
    expect(h.status.status).toBe("idle");
  });
  it("reply undefined and null acknowledge the request", async () => {
    const h = harness();
    h.sync.push(12);
    h.pending[0].resolve(undefined);
    await flush();
    expect(h.shown).toBe(12);
    expect(h.status.status).toBe("idle");
    expect(h.applied).toHaveBeenLastCalledWith(12);
    h.sync.push(13);
    h.pending[1].resolve(null);
    await flush();
    expect(h.shown).toBe(13);
    expect(h.applied).toHaveBeenLastCalledWith(13);
  });
  it("server differs twice, no feedback push", async () => {
    const h = harness(64, true);
    h.sync.apply(12);
    h.pending[0].resolve(9);
    await flush();
    expect(h.shown).toBe(9);
    h.sync.apply(12);
    h.pending[1].resolve(9);
    await flush();
    expect(h.shown).toBe(9);
    expect(h.call.mock.calls).toStrictEqual([[12], [12]]);
  });
  it("differing reply while an edit is queued: queued value goes out", async () => {
    const h = harness();
    h.sync.push(12);
    h.sync.push(10);
    h.pending[0].resolve(9);
    await flush();
    expect(h.call.mock.calls).toStrictEqual([[12], [10]]);
    expect(h.status.status).toBe("pending");
    expect(h.shown).toBe(10);
    h.pending[1].resolve(10);
    await flush();
    expect(h.shown).toBe(10);
    expect(h.status.status).toBe("idle");
  });
  it("cancelTimers leaves no timers and no timeout toast", async () => {
    const h = harness();
    h.sync.push(12);
    h.sync.push(10);
    h.sync.cancelTimers();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(CAP_ACK_TIMEOUT_MS * 3);
    expect(toast.error).not.toHaveBeenCalled();
  });
  it("Retry when the failed value equals the acknowledged one", async () => {
    const h = harness(12);
    h.sync.push(12);
    h.pending[0].reject(new Error("refused"));
    await flush();
    const s = h.status;
    if (s.status !== "failed") throw new Error("not failed");
    expect(h.shown).toBe(12);
    s.retry();
    expect(h.call.mock.calls).toStrictEqual([[12], [12]]);
  });
  it("rejection rolls back with Retry toast", async () => {
    const h = harness();
    h.sync.push(12);
    h.pending[0].reject(new Error("refused"));
    await flush();
    expect(h.shown).toBe(64);
    expect(toast.error).toHaveBeenCalledWith(
      "Probe Failed",
      expect.objectContaining({
        description: "refused",
        id: "probe",
        action: expect.objectContaining({ label: "Retry" }),
      }),
    );
  });
});
