import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSessionEvents } from "#hooks/useSessionEvents";
import type { DomainEvent } from "#lib/event-bus";
import { useSessionStore } from "#store/sessions";
import type { Session } from "#store/types";

type Handler = (e: DomainEvent) => void;
const registered = new Map<string, Handler>();

vi.mock(import("#lib/event-bus"), () => ({
  onEvent: (type: string, handler: Handler) => {
    registered.set(type, handler);
    return () => {
      registered.delete(type);
    };
  },
}));

const mockListSessions = vi.fn<() => Promise<Session[]>>();
vi.mock(import("#lib/tauri"), async (importOriginal) => ({
  ...(await importOriginal()),
  listSessions: () => mockListSessions(),
}));

function deliver(type: string, payload: unknown): void {
  registered.get(type)?.({ seq: 1, ts: 0, type, payload });
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: crypto.randomUUID(),
    name: "Session",
    workerIds: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function resetStore(): void {
  for (const [id] of useSessionStore.getState().sessions) {
    useSessionStore.getState().removeSession(id);
  }
}

const SESSION_ID = "11111111-2222-4333-8444-555555555555";
const WORKER_ID = "66666666-7777-4888-8999-aaaaaaaaaaaa";
const OTHER_SESSION_ID = "99999999-aaaa-4bbb-8ccc-dddddddddddd";
const OTHER_WORKER_ID = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";

describe("useSessionEvents", () => {
  beforeEach(() => {
    resetStore();
    registered.clear();
    mockListSessions.mockResolvedValue([]);
  });
  afterEach(() => {
    cleanup();
    resetStore();
  });

  // ── startup restore ──

  it("restores the backend's persisted sessions into the store on mount", async () => {
    const restored = makeSession({ id: SESSION_ID, name: "From Last Run" });
    mockListSessions.mockResolvedValue([restored]);

    renderHook(() => useSessionEvents());

    await waitFor(() => {
      expect(useSessionStore.getState().sessions.get(SESSION_ID)).toEqual(restored);
    });
  });

  it("logs, and keeps working, when the restore fails", async () => {
    using consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    mockListSessions.mockRejectedValue(new Error("backend not ready"));

    renderHook(() => useSessionEvents());
    await waitFor(() => {
      expect(consoleError).toHaveBeenCalledWith(
        "useSessionEvents: could not restore persisted sessions",
        expect.any(Error),
      );
    });

    deliver("session_created", { sessionId: SESSION_ID, name: "Still Live" });
    expect(useSessionStore.getState().sessions.get(SESSION_ID)?.name).toBe("Still Live");
  });

  // ── session_created merge semantics ──
  // applyTemplate's own addSession() (from create_session's IPC response)
  // and this handler (from the same command's emitted event) race in
  // either order. A handler that replaced the store entry would reset
  // workerIds to [] when it lands after spawns already grew it.

  it("creates a fresh, empty-workerIds session when nothing exists yet for that id", () => {
    renderHook(() => useSessionEvents());

    deliver("session_created", { sessionId: SESSION_ID, name: "Fresh" });

    const session = useSessionStore.getState().sessions.get(SESSION_ID);
    expect(session?.name).toBe("Fresh");
    expect(session?.workerIds).toEqual([]);
  });

  it("preserves an already-grown workerIds list and createdAt instead of resetting them", () => {
    const rich = makeSession({ id: SESSION_ID, workerIds: [WORKER_ID, OTHER_WORKER_ID] });
    useSessionStore.getState().addSession(rich);

    renderHook(() => useSessionEvents());
    deliver("session_created", { sessionId: SESSION_ID, name: "Renamed" });

    const merged = useSessionStore.getState().sessions.get(SESSION_ID);
    expect(merged?.workerIds).toEqual([WORKER_ID, OTHER_WORKER_ID]);
    expect(merged?.createdAt).toBe(rich.createdAt);
    expect(merged?.name).toBe("Renamed");
  });

  // ── session_deleted ──

  it("removes a session on session_deleted", () => {
    useSessionStore.getState().addSession(makeSession({ id: SESSION_ID }));

    renderHook(() => useSessionEvents());
    deliver("session_deleted", { sessionId: SESSION_ID });

    expect(useSessionStore.getState().sessions.has(SESSION_ID)).toBe(false);
  });

  // ── session_worker_added ──

  it("adds the named worker to session.workerIds exactly once", () => {
    useSessionStore.getState().addSession(makeSession({ id: SESSION_ID, workerIds: [WORKER_ID] }));

    renderHook(() => useSessionEvents());
    deliver("session_worker_added", { sessionId: SESSION_ID, workerId: OTHER_WORKER_ID });
    deliver("session_worker_added", { sessionId: SESSION_ID, workerId: OTHER_WORKER_ID });

    expect(useSessionStore.getState().sessions.get(SESSION_ID)?.workerIds).toEqual([
      WORKER_ID,
      OTHER_WORKER_ID,
    ]);
  });

  // ── session_worker_removed ──

  it("removes exactly the named worker from session.workerIds", () => {
    useSessionStore
      .getState()
      .addSession(makeSession({ id: SESSION_ID, workerIds: [WORKER_ID, OTHER_WORKER_ID] }));

    renderHook(() => useSessionEvents());
    deliver("session_worker_removed", { sessionId: SESSION_ID, workerId: WORKER_ID });

    expect(useSessionStore.getState().sessions.get(SESSION_ID)?.workerIds).toEqual([
      OTHER_WORKER_ID,
    ]);
  });

  it("is a no-op for a valid payload naming another session", () => {
    useSessionStore.getState().addSession(makeSession({ id: SESSION_ID, workerIds: [WORKER_ID] }));

    renderHook(() => useSessionEvents());
    deliver("session_worker_removed", {
      sessionId: "77777777-8888-4999-8aaa-bbbbbbbbbbbb",
      workerId: WORKER_ID,
    });

    expect(useSessionStore.getState().sessions.get(SESSION_ID)?.workerIds).toEqual([WORKER_ID]);
  });

  // ── startup restore sequenced against live events ──
  // The snapshot is requested at mount but resolves later; events delivered
  // meanwhile hit a store that does not hold the restored sessions yet.

  function deferSnapshot(): (sessions: Session[]) => void {
    let resolve: (sessions: Session[]) => void = () => {};
    mockListSessions.mockReturnValue(
      new Promise<Session[]>((r) => {
        resolve = r;
      }),
    );
    return resolve;
  }

  it("does not resurrect a session deleted before the snapshot resolves", async () => {
    const resolveSnapshot = deferSnapshot();
    const other = makeSession({ id: OTHER_SESSION_ID });
    renderHook(() => useSessionEvents());

    deliver("session_deleted", { sessionId: SESSION_ID });
    resolveSnapshot([makeSession({ id: SESSION_ID }), other]);

    await waitFor(() => {
      expect(useSessionStore.getState().sessions.get(OTHER_SESSION_ID)).toEqual(other);
    });
    expect(useSessionStore.getState().sessions.has(SESSION_ID)).toBe(false);
  });

  it("does not restore a worker removed before the snapshot resolves", async () => {
    const resolveSnapshot = deferSnapshot();
    renderHook(() => useSessionEvents());

    deliver("session_worker_removed", { sessionId: SESSION_ID, workerId: WORKER_ID });
    resolveSnapshot([makeSession({ id: SESSION_ID, workerIds: [WORKER_ID, OTHER_WORKER_ID] })]);

    await waitFor(() => {
      expect(useSessionStore.getState().sessions.has(SESSION_ID)).toBe(true);
    });
    expect(useSessionStore.getState().sessions.get(SESSION_ID)?.workerIds).toEqual([
      OTHER_WORKER_ID,
    ]);
  });

  it("keeps a worker added before the snapshot resolves", async () => {
    const resolveSnapshot = deferSnapshot();
    renderHook(() => useSessionEvents());

    deliver("session_worker_added", { sessionId: SESSION_ID, workerId: OTHER_WORKER_ID });
    resolveSnapshot([makeSession({ id: SESSION_ID, workerIds: [WORKER_ID] })]);

    await waitFor(() => {
      expect(useSessionStore.getState().sessions.has(SESSION_ID)).toBe(true);
    });
    expect(useSessionStore.getState().sessions.get(SESSION_ID)?.workerIds).toEqual([
      WORKER_ID,
      OTHER_WORKER_ID,
    ]);
  });

  it("applies pre-snapshot events in arrival order (remove then re-add keeps the worker)", async () => {
    const resolveSnapshot = deferSnapshot();
    renderHook(() => useSessionEvents());

    deliver("session_worker_removed", { sessionId: SESSION_ID, workerId: WORKER_ID });
    deliver("session_worker_added", { sessionId: SESSION_ID, workerId: WORKER_ID });
    resolveSnapshot([makeSession({ id: SESSION_ID, workerIds: [WORKER_ID] })]);

    await waitFor(() => {
      expect(useSessionStore.getState().sessions.has(SESSION_ID)).toBe(true);
    });
    expect(useSessionStore.getState().sessions.get(SESSION_ID)?.workerIds).toEqual([WORKER_ID]);
  });

  it("keeps a session created this run over its persisted copy", async () => {
    const resolveSnapshot = deferSnapshot();
    const other = makeSession({ id: OTHER_SESSION_ID });
    renderHook(() => useSessionEvents());

    deliver("session_created", { sessionId: SESSION_ID, name: "Live" });
    resolveSnapshot([makeSession({ id: SESSION_ID, name: "Persisted" }), other]);

    await waitFor(() => {
      expect(useSessionStore.getState().sessions.has(OTHER_SESSION_ID)).toBe(true);
    });
    expect(useSessionStore.getState().sessions.get(SESSION_ID)?.name).toBe("Live");
  });

  it("applies events immediately once the snapshot has resolved", async () => {
    mockListSessions.mockResolvedValue([makeSession({ id: SESSION_ID, workerIds: [WORKER_ID] })]);
    renderHook(() => useSessionEvents());
    await waitFor(() => {
      expect(useSessionStore.getState().sessions.has(SESSION_ID)).toBe(true);
    });

    deliver("session_worker_removed", { sessionId: SESSION_ID, workerId: WORKER_ID });
    expect(useSessionStore.getState().sessions.get(SESSION_ID)?.workerIds).toEqual([]);
    deliver("session_deleted", { sessionId: SESSION_ID });
    expect(useSessionStore.getState().sessions.has(SESSION_ID)).toBe(false);
  });

  it("does not hydrate when unmounted before the snapshot resolves", async () => {
    const resolveSnapshot = deferSnapshot();
    const { unmount } = renderHook(() => useSessionEvents());

    unmount();
    resolveSnapshot([makeSession({ id: SESSION_ID })]);
    await Promise.resolve();
    await Promise.resolve();

    expect(useSessionStore.getState().sessions.has(SESSION_ID)).toBe(false);
  });

  it("unsubscribes every listener on unmount", () => {
    const { unmount } = renderHook(() => useSessionEvents());
    expect([...registered.keys()].sort()).toEqual([
      "session_created",
      "session_deleted",
      "session_worker_added",
      "session_worker_removed",
    ]);

    unmount();

    expect(registered.size).toBe(0);
  });
});
