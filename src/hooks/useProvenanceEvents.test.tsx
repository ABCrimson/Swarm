// ── useProvenanceEvents wiring ───────────────────────
//
// All derivation logic lives in useProvenanceStore.ingestEvent (see
// store/provenance.test.ts for exhaustive per-kind coverage). This file
// proves only the WIRING: exactly one live wildcard subscription (also
// under StrictMode's mount → unmount → mount), forwarding every envelope
// to the store untouched.

import { renderHook } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useProvenanceEvents } from "#hooks/useProvenanceEvents";
import type { DomainEvent } from "#lib/event-bus";
import { useProvenanceStore } from "#store/provenance";

// A Set-based bus like the real one: a second subscription would be a
// second live handler (a double ingest), not an overwrite.
const bus = vi.hoisted(() => {
  const handlers = new Map<string, Set<(e: unknown) => void>>();
  const onEvent = vi.fn((type: string, handler: (e: unknown) => void) => {
    const set = handlers.get(type) ?? new Set();
    set.add(handler);
    handlers.set(type, set);
    return () => set.delete(handler);
  });
  return {
    handlers,
    onEvent,
    live: (type: string) => handlers.get(type)?.size ?? 0,
    emit: (type: string, e: unknown) => {
      for (const handler of handlers.get(type) ?? []) handler(e);
    },
  };
});
vi.mock(import("#lib/event-bus"), () => ({ onEvent: bus.onEvent }) as never);

const emit = (e: DomainEvent): void => bus.emit("*", e);

describe("useProvenanceEvents", () => {
  beforeEach(() => {
    bus.handlers.clear();
    bus.onEvent.mockClear();
    useProvenanceStore.getState().reset();
  });
  afterEach(() => {
    useProvenanceStore.getState().reset();
  });

  it("subscribes to the wildcard channel exactly once", () => {
    renderHook(() => useProvenanceEvents());

    expect(bus.onEvent).toHaveBeenCalledTimes(1);
    expect(bus.onEvent).toHaveBeenCalledWith("*", expect.any(Function));
    expect(bus.live("*")).toBe(1);
  });

  it("leaves exactly one live subscription under StrictMode's effect replay", () => {
    renderHook(() => useProvenanceEvents(), { wrapper: StrictMode });

    expect(bus.live("*")).toBe(1);
    emit({ seq: 1, ts: 1, type: "file_written", originWorker: "w-a", payload: {} });
    expect(useProvenanceStore.getState().fileWriteCounts.get("w-a")).toBe(1); // not 2
  });

  it("forwards a stamped envelope to the store, producing a measured edge", () => {
    renderHook(() => useProvenanceEvents());

    emit({
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

    emit({
      seq: 1,
      ts: 1000,
      type: "worker_spawned",
      payload: { workerId: "w-new", name: "Human Spawned", pid: 1 },
    });

    expect(useProvenanceStore.getState().edges.size).toBe(0);
  });

  it("forwards a file_written envelope to the store as a badge count, not an edge", () => {
    renderHook(() => useProvenanceEvents());

    emit({
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

    expect(bus.live("*")).toBe(0);
  });
});
