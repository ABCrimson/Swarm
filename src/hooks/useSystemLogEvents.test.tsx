// ── useSystemLogEvents ──────────────────────────────
//
// Backend system_log envelopes (e.g. the worktree-isolation startup
// probe) reach the Logs page's store, validated at the seam.

import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSystemLogEvents } from "#hooks/useSystemLogEvents";
import { useLogStore } from "#lib/log-store";

type Handler = (e: { ts?: number; payload: unknown }) => void;

const registered = new Map<string, Handler>();

vi.mock("#lib/event-bus", () => ({
  onEvent: (type: string, handler: Handler) => {
    registered.set(type, handler);
    return () => registered.delete(type);
  },
}));

function resetStore(): void {
  useLogStore.getState().clear();
}

describe("useSystemLogEvents", () => {
  beforeEach(() => {
    resetStore();
    registered.clear();
  });
  afterEach(resetStore);

  it("feeds a system_log envelope into useLogStore with source 'backend'", () => {
    renderHook(() => useSystemLogEvents());

    registered.get("system_log")?.({
      payload: {
        level: "warn",
        message: "Git Unavailable — Isolated Spawns Will Fail Until Git Is Installed Or Upgraded",
        target: "swarm_core::git",
        timestamp: 1_700_000_000_000,
      },
    });

    const entries = useLogStore.getState().entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]?.level).toBe("warn");
    expect(entries[0]?.source).toBe("backend");
    expect(entries[0]?.message).toContain("Git Unavailable");
    expect(entries[0]?.timestamp).toBe(1_700_000_000_000);
    expect(entries[0]?.metadata).toEqual({ target: "swarm_core::git" });
  });

  it("coerces an unrecognized level to 'info' rather than dropping the entry", () => {
    renderHook(() => useSystemLogEvents());

    registered.get("system_log")?.({
      payload: {
        level: "trace",
        message: "some backend log",
        target: "swarm_core::worker",
        timestamp: 1_700_000_000_000,
      },
    });

    const entries = useLogStore.getState().entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]?.level).toBe("info");
  });

  it("stamps an entry with the envelope time when the payload carries none", () => {
    renderHook(() => useSystemLogEvents());

    registered.get("system_log")?.({ ts: 42, payload: { level: "error", message: "boom" } });

    const [entry] = useLogStore.getState().entries;
    expect(entry).toMatchObject({ timestamp: 42, level: "error", message: "boom" });
    expect(entry?.metadata).toBeUndefined();
  });

  it("drops a malformed payload instead of logging undefined", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    renderHook(() => useSystemLogEvents());

    registered.get("system_log")?.({ ts: 1, payload: { level: "info" } });

    expect(useLogStore.getState().entries).toHaveLength(0);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("unsubscribes on unmount", () => {
    const { unmount } = renderHook(() => useSystemLogEvents());
    expect(registered.has("system_log")).toBe(true);
    unmount();
    expect(registered.has("system_log")).toBe(false);
  });
});
