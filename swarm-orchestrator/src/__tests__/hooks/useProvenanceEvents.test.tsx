// ── useProvenanceEvents wiring ───────────────────────
//
// All derivation logic lives in useProvenanceStore.ingestEvent (see
// store/provenance.test.ts for exhaustive per-kind coverage). This file
// proves only the WIRING: the hook subscribes to the wildcard channel
// exactly once and forwards every envelope to the store untouched.

import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useProvenanceEvents } from "#hooks/useProvenanceEvents";
import type { DomainEvent } from "#lib/event-bus";
import { useProvenanceStore } from "#store/provenance";

type Handler = (e: DomainEvent) => void;

const registered = new Map<string, Handler>();
const unsubscribeSpy = vi.fn();

vi.mock("#lib/event-bus", () => ({
  onEvent: (type: string, handler: Handler) => {
    registered.set(type, handler);
    return unsubscribeSpy;
  },
}));

describe("useProvenanceEvents", () => {
  beforeEach(() => {
    registered.clear();
    unsubscribeSpy.mockClear();
    useProvenanceStore.getState().reset();
  });
  afterEach(() => {
    useProvenanceStore.getState().reset();
  });

  it("subscribes to the wildcard channel exactly once", () => {
    renderHook(() => useProvenanceEvents());
    expect(registered.has("*")).toBe(true);
  });

  it("forwards a stamped envelope to the store, producing a measured edge", () => {
    renderHook(() => useProvenanceEvents());

    registered.get("*")?.({
      seq: 1,
      ts: 1000,
      type: "worker_spawned",
      originWorker: "w-caller",
      payload: { workerId: "w-new", name: "Sub-Agent", pid: 1 },
    });

    const edges = [...useProvenanceStore.getState().edges.values()];
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ from: "w-caller", to: "w-new", kind: "spawn" });
  });

  it("forwards an unstamped envelope to the store, producing no edge", () => {
    renderHook(() => useProvenanceEvents());

    registered.get("*")?.({
      seq: 1,
      ts: 1000,
      type: "worker_spawned",
      payload: { workerId: "w-new", name: "Human Spawned", pid: 1 },
    });

    expect(useProvenanceStore.getState().edges.size).toBe(0);
  });

  it("forwards a file_written envelope to the store as a badge count, not an edge", () => {
    renderHook(() => useProvenanceEvents());

    registered.get("*")?.({
      seq: 1,
      ts: 1000,
      type: "file_written",
      originWorker: "w-a",
      payload: { path: "/repo/out.txt", bytes: 7 },
    });

    expect(useProvenanceStore.getState().edges.size).toBe(0);
    expect(useProvenanceStore.getState().fileWriteCounts.get("w-a")).toBe(1);
  });

  it("unsubscribes on unmount", () => {
    const { unmount } = renderHook(() => useProvenanceEvents());
    unmount();
    expect(unsubscribeSpy).toHaveBeenCalled();
  });
});
