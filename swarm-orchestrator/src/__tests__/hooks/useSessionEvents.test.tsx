// ── session_created merge semantics (fix wave, item NEW-1) ──
//
// applyTemplate's own addSession(session) (from create_session's IPC
// response) and this hook's session_created handler (from the same
// command's emitted event) race in either order — Rust emits the event
// as part of create_session, so nothing guarantees which one reaches
// the frontend store first. A naive session_created handler that always
// replaces the store entry would reset workerIds back to [] if it lands
// AFTER spawns have already grown it via applyTemplate's own addSession.
// The handler now merges into any existing record instead.

import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSessionEvents } from "#hooks/useSessionEvents";
import { useSessionStore } from "#store/sessions";
import type { Session } from "#store/types";

type Handler = (e: { payload: unknown }) => void;

const registered = new Map<string, Handler>();

vi.mock("#lib/event-bus", () => ({
  onEvent: (type: string, handler: Handler) => {
    registered.set(type, handler);
    return () => registered.delete(type);
  },
}));

function resetStores(): void {
  for (const [id] of useSessionStore.getState().sessions)
    useSessionStore.getState().removeSession(id);
}

describe("useSessionEvents", () => {
  beforeEach(() => {
    resetStores();
    registered.clear();
  });
  afterEach(resetStores);

  it("creates a fresh, empty-workerIds session when nothing exists yet for that id", () => {
    renderHook(() => useSessionEvents());

    registered.get("session_created")?.({ payload: { sessionId: "session-1", name: "Fresh" } });

    const session = useSessionStore.getState().sessions.get("session-1");
    expect(session?.name).toBe("Fresh");
    expect(session?.workerIds).toEqual([]);
  });

  it("preserves an already-grown workerIds list instead of resetting it to empty (event arrives after applyTemplate's addSession + spawns)", () => {
    const richSession: Session = {
      id: "session-2",
      name: "Richer Already",
      workerIds: ["worker-a", "worker-b"],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:05.000Z",
    };
    useSessionStore.getState().addSession(richSession);

    renderHook(() => useSessionEvents());
    registered.get("session_created")?.({
      payload: { sessionId: "session-2", name: "Richer Already" },
    });

    // The event payload never carries workerIds — a naive replace would
    // have reset this to []. It must not.
    expect(useSessionStore.getState().sessions.get("session-2")?.workerIds).toEqual([
      "worker-a",
      "worker-b",
    ]);
  });

  it("preserves the existing createdAt instead of overwriting it with the event's arrival time", () => {
    const original: Session = {
      id: "session-3",
      name: "Original",
      workerIds: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    useSessionStore.getState().addSession(original);

    renderHook(() => useSessionEvents());
    registered.get("session_created")?.({ payload: { sessionId: "session-3", name: "Original" } });

    expect(useSessionStore.getState().sessions.get("session-3")?.createdAt).toBe(
      "2026-01-01T00:00:00.000Z",
    );
  });

  it("still removes a session on session_deleted", () => {
    useSessionStore.getState().addSession({
      id: "session-4",
      name: "Goes Away",
      workerIds: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    renderHook(() => useSessionEvents());
    registered.get("session_deleted")?.({ payload: { sessionId: "session-4" } });

    expect(useSessionStore.getState().sessions.has("session-4")).toBe(false);
  });

  // ── session_worker_removed (workerIds pruning, task 3) ────────────

  const SESSION_ID = "11111111-2222-3333-8444-555555555555";
  const WORKER_ID = "66666666-7777-8888-8999-aaaaaaaaaaaa";
  const OTHER_WORKER_ID = "bbbbbbbb-cccc-dddd-8eee-ffffffffffff";

  it("removes exactly the named worker from session.workerIds on session_worker_removed", () => {
    useSessionStore.getState().addSession({
      id: SESSION_ID,
      name: "Pruned",
      workerIds: [WORKER_ID, OTHER_WORKER_ID],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    renderHook(() => useSessionEvents());
    registered.get("session_worker_removed")?.({
      payload: { sessionId: SESSION_ID, workerId: WORKER_ID },
    });

    expect(useSessionStore.getState().sessions.get(SESSION_ID)?.workerIds).toEqual([
      OTHER_WORKER_ID,
    ]);
  });

  it("is a no-op (logged, not thrown) for a malformed session_worker_removed payload", () => {
    useSessionStore.getState().addSession({
      id: SESSION_ID,
      name: "Untouched",
      workerIds: [WORKER_ID],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    renderHook(() => useSessionEvents());
    expect(() =>
      registered.get("session_worker_removed")?.({
        payload: { sessionId: "not-a-uuid", workerId: WORKER_ID },
      }),
    ).not.toThrow();

    expect(useSessionStore.getState().sessions.get(SESSION_ID)?.workerIds).toEqual([WORKER_ID]);
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("is a no-op for a session id session_worker_removed doesn't name", () => {
    useSessionStore.getState().addSession({
      id: SESSION_ID,
      name: "Unrelated",
      workerIds: [WORKER_ID],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const otherSessionId = "77777777-8888-9999-8aaa-bbbbbbbbbbbb";

    renderHook(() => useSessionEvents());
    registered.get("session_worker_removed")?.({
      payload: { sessionId: otherSessionId, workerId: WORKER_ID },
    });

    expect(useSessionStore.getState().sessions.get(SESSION_ID)?.workerIds).toEqual([WORKER_ID]);
  });
});
