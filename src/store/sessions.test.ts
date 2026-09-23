import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSessionStore } from "#store/sessions";
import type { Session } from "#store/types";

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
  const state = useSessionStore.getState();
  for (const [id] of state.sessions) {
    state.removeSession(id);
  }
  state.setActiveSession(null);
}

describe("SessionStore", () => {
  beforeEach(resetStore);
  afterEach(resetStore);

  describe("addSession", () => {
    it("adds a session to the store", () => {
      const session = createSession({ name: "my-session" });
      useSessionStore.getState().addSession(session);

      const stored = useSessionStore.getState().sessions.get(session.id);
      expect(stored).toBeDefined();
      expect(stored?.name).toBe("my-session");
    });

    it("adds multiple sessions", () => {
      const s1 = createSession({ name: "s1" });
      const s2 = createSession({ name: "s2" });
      const { addSession } = useSessionStore.getState();
      addSession(s1);
      addSession(s2);

      expect(useSessionStore.getState().sessions.size).toBe(2);
    });
  });

  describe("removeSession", () => {
    it("removes a session from the store", () => {
      const session = createSession();
      const { addSession, removeSession } = useSessionStore.getState();
      addSession(session);

      removeSession(session.id);

      expect(useSessionStore.getState().sessions.has(session.id)).toBe(false);
    });

    it("clears activeSessionId when the active session is removed", () => {
      const session = createSession();
      const { addSession, setActiveSession, removeSession } = useSessionStore.getState();
      addSession(session);
      setActiveSession(session.id);

      removeSession(session.id);

      expect(useSessionStore.getState().activeSessionId).toBeNull();
    });

    it("does not clear activeSessionId when a different session is removed", () => {
      const s1 = createSession({ name: "s1" });
      const s2 = createSession({ name: "s2" });
      const { addSession, setActiveSession, removeSession } = useSessionStore.getState();
      addSession(s1);
      addSession(s2);
      setActiveSession(s1.id);

      removeSession(s2.id);

      expect(useSessionStore.getState().activeSessionId).toBe(s1.id);
    });
  });

  describe("updateSession", () => {
    it("updates session fields via partial merge", () => {
      const session = createSession({ name: "original" });
      const { addSession, updateSession } = useSessionStore.getState();
      addSession(session);

      updateSession(session.id, { name: "updated" });

      expect(useSessionStore.getState().sessions.get(session.id)?.name).toBe("updated");
    });

    it("preserves fields not included in the update", () => {
      const session = createSession({
        name: "original",
        workerIds: [crypto.randomUUID(), crypto.randomUUID()],
      });
      const { addSession, updateSession } = useSessionStore.getState();
      addSession(session);

      updateSession(session.id, { name: "renamed" });

      const stored = useSessionStore.getState().sessions.get(session.id);
      expect(stored?.workerIds).toEqual(session.workerIds);
    });

    it("does nothing for a non-existent session", () => {
      const { updateSession } = useSessionStore.getState();
      // Should not throw
      updateSession("non-existent", { name: "nope" });
      expect(useSessionStore.getState().sessions.size).toBe(0);
    });
  });

  describe("hydrateSessions", () => {
    it("adds every session the store does not have, in one update", () => {
      const listener = vi.fn();
      const unsubscribe = useSessionStore.subscribe((state) => state.sessions, listener);
      const s1 = createSession({ name: "restored-1" });
      const s2 = createSession({ name: "restored-2" });

      useSessionStore.getState().hydrateSessions([s1, s2]);
      unsubscribe();

      expect([...useSessionStore.getState().sessions.keys()]).toEqual([s1.id, s2.id]);
      expect(listener).toHaveBeenCalledOnce();
    });

    it("keeps a session the store already holds instead of the persisted copy", () => {
      const live = createSession({ name: "live", workerIds: [crypto.randomUUID()] });
      useSessionStore.getState().addSession(live);

      useSessionStore.getState().hydrateSessions([{ ...live, name: "persisted", workerIds: [] }]);

      expect(useSessionStore.getState().sessions.get(live.id)).toEqual(live);
    });
  });

  describe("removeWorkerFromSession", () => {
    it("removes exactly that worker from the session", () => {
      const [keep, drop] = [crypto.randomUUID(), crypto.randomUUID()];
      const session = createSession({ workerIds: [keep, drop] });
      useSessionStore.getState().addSession(session);

      useSessionStore.getState().removeWorkerFromSession(session.id, drop);

      expect(useSessionStore.getState().sessions.get(session.id)?.workerIds).toEqual([keep]);
    });

    it("is a no-op for a worker the session does not list", () => {
      const worker = crypto.randomUUID();
      const session = createSession({ workerIds: [worker] });
      useSessionStore.getState().addSession(session);

      useSessionStore.getState().removeWorkerFromSession(session.id, crypto.randomUUID());

      expect(useSessionStore.getState().sessions.get(session.id)?.workerIds).toEqual([worker]);
    });

    it("is a no-op for an unknown session", () => {
      useSessionStore.getState().removeWorkerFromSession(crypto.randomUUID(), crypto.randomUUID());
      expect(useSessionStore.getState().sessions.size).toBe(0);
    });
  });

  describe("setActiveSession", () => {
    it("sets the active session", () => {
      const session = createSession();
      const { addSession, setActiveSession } = useSessionStore.getState();
      addSession(session);

      setActiveSession(session.id);

      expect(useSessionStore.getState().activeSessionId).toBe(session.id);
    });

    it("sets active session to null", () => {
      const session = createSession();
      const { addSession, setActiveSession } = useSessionStore.getState();
      addSession(session);
      setActiveSession(session.id);

      setActiveSession(null);

      expect(useSessionStore.getState().activeSessionId).toBeNull();
    });
  });
});
