import { configure, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoSnapshot } from "#hooks/useAutoSnapshot";
import { connectEventBus, resetEventBus } from "#lib/event-bus";
import { clearSnapshots, createSnapshot } from "#lib/snapshots";
import { useSessionStore } from "#store/sessions";
import { DEFAULT_APP_SETTINGS } from "#store/ui";

// Like the app (main.tsx): effects run twice on mount.
configure({ reactStrictMode: true });

const listeners = new Map<string, (payload: unknown) => void>();

vi.mock("#lib/tauri", () => ({
  listen: async (event: string, handler: (payload: unknown) => void) => {
    listeners.set(event, handler);
    return () => listeners.delete(event);
  },
  invoke: vi.fn(),
  isTauri: () => Boolean(Reflect.get(globalThis, "isTauri")),
}));

vi.mock("#lib/snapshots", () => ({
  createSnapshot: vi.fn(),
  clearSnapshots: vi.fn(),
}));

const SESSION = "6ba7b810-9dad-41d1-80b4-00c04fd430c8";
const INTERVAL_MS = DEFAULT_APP_SETTINGS.snapshotIntervalMin * 60_000;

describe("useAutoSnapshot", () => {
  // Snapshots are plugin-store files, which need the Tauri bridge.
  beforeEach(async () => {
    vi.stubGlobal("isTauri", true);
    vi.useFakeTimers();
    listeners.clear();
    resetEventBus();
    vi.mocked(createSnapshot)
      .mockReset()
      .mockImplementation(async (session) => ({
        id: crypto.randomUUID(),
        sessionId: session.id,
        timestamp: new Date().toISOString(),
        data: {},
      }));
    vi.mocked(clearSnapshots).mockReset().mockResolvedValue(undefined);
    const now = new Date().toISOString();
    useSessionStore.setState({
      sessions: new Map([
        [SESSION, { id: SESSION, name: "Research", workerIds: [], createdAt: now, updatedAt: now }],
      ]),
      activeSessionId: null,
    });
    await connectEventBus();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("schedules nothing without the Tauri bridge", () => {
    vi.unstubAllGlobals();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    useSessionStore.setState({ activeSessionId: SESSION });
    renderHook(() => useAutoSnapshot());

    vi.advanceTimersByTime(INTERVAL_MS * 5);
    listeners.get("swarm://events")?.({
      seq: 1,
      ts: 1,
      type: "session_deleted",
      payload: { sessionId: SESSION },
    });

    expect(createSnapshot).not.toHaveBeenCalled();
    expect(clearSnapshots).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("snapshots the active session once per interval", () => {
    useSessionStore.setState({ activeSessionId: SESSION });
    renderHook(() => useAutoSnapshot());

    vi.advanceTimersByTime(INTERVAL_MS - 1);
    expect(createSnapshot).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(createSnapshot).toHaveBeenCalledExactlyOnceWith(
      useSessionStore.getState().sessions.get(SESSION),
    );
    vi.advanceTimersByTime(INTERVAL_MS);
    expect(createSnapshot).toHaveBeenCalledTimes(2);
  });

  it("does nothing without an active session", () => {
    renderHook(() => useAutoSnapshot());

    vi.advanceTimersByTime(INTERVAL_MS * 3);

    expect(createSnapshot).not.toHaveBeenCalled();
  });

  it("deletes a deleted session's snapshots", () => {
    renderHook(() => useAutoSnapshot());

    listeners.get("swarm://events")?.({
      seq: 1,
      ts: 1,
      type: "session_deleted",
      payload: { sessionId: SESSION },
    });

    expect(clearSnapshots).toHaveBeenCalledExactlyOnceWith(SESSION);
  });

  it("stops both on unmount", () => {
    useSessionStore.setState({ activeSessionId: SESSION });
    const { unmount } = renderHook(() => useAutoSnapshot());
    unmount();

    vi.advanceTimersByTime(INTERVAL_MS);
    listeners.get("swarm://events")?.({
      seq: 1,
      ts: 1,
      type: "session_deleted",
      payload: { sessionId: SESSION },
    });

    expect(createSnapshot).not.toHaveBeenCalled();
    expect(clearSnapshots).not.toHaveBeenCalled();
  });
});
