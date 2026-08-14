// ── system_log consumer (adversarial review F4) ─────────
//
// system_log was a documented event type with no live emitter and no
// consumer — useLogStore/LogViewer rendered only test-seeded data.
// The worktree isolation startup probe is the first real emitter;
// this hook is the first real consumer, feeding useLogStore so the
// existing Logs page actually shows something.

import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSystemLogEvents } from "#hooks/useSystemLogEvents";
import { useLogStore } from "#lib/log-store";

type Handler = (e: { payload: unknown }) => void;

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

  it("unsubscribes on unmount", () => {
    const { unmount } = renderHook(() => useSystemLogEvents());
    expect(registered.has("system_log")).toBe(true);
    unmount();
    expect(registered.has("system_log")).toBe(false);
  });
});
