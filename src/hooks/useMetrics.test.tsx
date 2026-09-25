// ── useMetrics ──────────────────────────────────────
//
// Regression: metrics.tokensPerSec was never written, so every Tokens/s
// readout (Dashboard, Metrics, StatusBar, particle throughput) was a
// permanent 0. It is now derived from the AI store's usage records.
// Also pins envelope-time stamping (backfilled samples keep their own
// time) and payload validation at the seam.

import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useMetrics } from "#hooks/useMetrics";
import { TOKEN_RATE_WINDOW_MS } from "#lib/metrics-aggregation";
import { useAiStore } from "#store/ai";
import { useSystemStore } from "#store/system";

type Handler = (e: { ts: number; payload: unknown }) => void;

const { handlers, onEventSpy } = vi.hoisted(() => {
  const handlers = new Map<string, Set<Handler>>();
  const onEventSpy = vi.fn((type: string, handler: Handler) => {
    const set = handlers.get(type) ?? new Set<Handler>();
    set.add(handler);
    handlers.set(type, set);
    return () => set.delete(handler);
  });
  return { handlers, onEventSpy };
});

vi.mock("#lib/event-bus", () => ({ onEvent: onEventSpy }));

function emit(ts: number, payload: unknown): void {
  for (const handler of handlers.get("system_metrics") ?? []) handler({ ts, payload });
}

const PAYLOAD = {
  cpuPercent: 12.5,
  memoryMb: 2048,
  memoryTotalMb: 16_384,
  workerCount: 2,
  aiReqPerSec: 0.5,
};

describe("useMetrics", () => {
  beforeEach(() => {
    handlers.clear();
    onEventSpy.mockClear();
    useSystemStore.setState(useSystemStore.getInitialState(), true);
    useAiStore.setState(useAiStore.getInitialState(), true);
  });

  it("subscribes to system_metrics exactly once and unsubscribes on unmount", () => {
    const { unmount } = renderHook(() => useMetrics());
    expect(onEventSpy).toHaveBeenCalledTimes(1);
    expect(onEventSpy).toHaveBeenCalledWith("system_metrics", expect.any(Function));
    unmount();
    expect(handlers.get("system_metrics")?.size).toBe(0);
  });

  it("records the payload and stamps history with the envelope's ts", () => {
    renderHook(() => useMetrics());
    emit(1_234, PAYLOAD);

    const { metrics } = useSystemStore.getState();
    expect(metrics).toMatchObject(PAYLOAD);
    expect(metrics.history).toEqual([{ time: 1_234, cpu: 12.5, memory: 2048, workerCount: 2 }]);
  });

  it("derives tokensPerSec from recent token usage instead of leaving it at 0", () => {
    useAiStore.getState().addTokenUsage({
      inputTokens: 700,
      outputTokens: 300,
      model: "claude-sonnet-5",
      provider: "anthropic",
      costUsd: 0,
      timestamp: Date.now(),
    });
    renderHook(() => useMetrics());
    emit(1, PAYLOAD);

    expect(useSystemStore.getState().metrics.tokensPerSec).toBe(
      1_000 / (TOKEN_RATE_WINDOW_MS / 1000),
    );
  });

  it("ignores a malformed payload", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    renderHook(() => useMetrics());
    emit(1, { cpuPercent: "high" });

    expect(useSystemStore.getState().metrics.history).toHaveLength(0);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
