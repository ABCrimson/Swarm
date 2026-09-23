import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
        workerIds: ["id-1", "id-2"],
      });
      const { addSession, updateSession } = useSessionStore.getState();
      addSession(session);

      updateSession(session.id, { name: "renamed" });

      const stored = useSessionStore.getState().sessions.get(session.id);
      expect(stored?.workerIds).toEqual(["id-1", "id-2"]);
    });

    it("does nothing for a non-existent session", () => {
      const { updateSession } = useSessionStore.getState();
      // Should not throw
      updateSession("non-existent", { name: "nope" });
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
