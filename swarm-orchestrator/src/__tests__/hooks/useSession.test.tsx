import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSession } from "#hooks/useSession";
import { useSessionStore } from "#store/sessions";
import type { Session } from "#store/types";

// Mock the Tauri IPC commands used by useSession
vi.mock("#lib/tauri", () => ({
  createSession: vi.fn().mockResolvedValue({
    id: "mock-session-id",
    name: "mock-session",
    workerIds: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }),
  deleteSession: vi.fn().mockResolvedValue(undefined),
  getSession: vi.fn().mockResolvedValue({
    id: "mock-session-id",
    name: "mock-session",
    workerIds: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }),
  listSessions: vi.fn().mockResolvedValue([]),
}));

vi.mock("#lib/fs", () => ({
  readScopedTextFile: vi.fn().mockResolvedValue(null),
  writeScopedTextFile: vi.fn().mockResolvedValue(undefined),
}));

function createSession(overrides?: Partial<Session>): Session {
  return {
    id: crypto.randomUUID(),
    name: "test-session",
    workerIds: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function resetStore(): void {
  act(() => {
    const state = useSessionStore.getState();
    for (const [id] of state.sessions) {
      state.removeSession(id);
    }
    state.setActiveSession(null);
  });
}

describe("useSession", () => {
  beforeEach(resetStore);
  afterEach(resetStore);

  it("returns undefined session when id does not exist", () => {
    const { result } = renderHook(() => useSession("nonexistent-id"));

    expect(result.current.session).toBeUndefined();
  });

  it("returns the session data when it exists in the store", () => {
    const session = createSession({ name: "my-session" });
    useSessionStore.getState().addSession(session);

    const { result } = renderHook(() => useSession(session.id));

    expect(result.current.session).toBeDefined();
    expect(result.current.session?.name).toBe("my-session");
  });

  it("exposes update, remove, and setActive functions", () => {
    const session = createSession();
    useSessionStore.getState().addSession(session);

    const { result } = renderHook(() => useSession(session.id));

    expect(typeof result.current.update).toBe("function");
    expect(typeof result.current.remove).toBe("function");
    expect(typeof result.current.setActive).toBe("function");
  });

  it("update modifies the session in the store", () => {
    const session = createSession({ name: "original" });
    useSessionStore.getState().addSession(session);

    const { result } = renderHook(() => useSession(session.id));

    act(() => {
      result.current.update({ name: "updated-name" });
    });

    expect(useSessionStore.getState().sessions.get(session.id)?.name).toBe("updated-name");
  });

  it("setActive sets the session as active", () => {
    const session = createSession();
    useSessionStore.getState().addSession(session);

    const { result } = renderHook(() => useSession(session.id));

    act(() => {
      result.current.setActive();
    });

    expect(useSessionStore.getState().activeSessionId).toBe(session.id);
  });

  it("remove calls IPC and removes from the store", async () => {
    const session = createSession();
    useSessionStore.getState().addSession(session);

    const { result } = renderHook(() => useSession(session.id));

    await act(async () => {
      await result.current.remove();
    });

    expect(useSessionStore.getState().sessions.has(session.id)).toBe(false);
  });
});
