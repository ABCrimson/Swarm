import { enableMapSet } from "immer";
import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import { immer } from "zustand/middleware/immer";
import type { Session } from "#store/types";

// Required for immer producers that mutate native Map instances (below).
enableMapSet();

/** Reactive state slice for the session registry. */
interface SessionStoreState {
  readonly sessions: Map<string, Session>;
  readonly activeSessionId: string | null;
}

/** Mutation actions for managing sessions in the store. */
interface SessionStoreActions {
  readonly addSession: (session: Session) => void;
  readonly removeSession: (id: string) => void;
  readonly removeWorkerFromSession: (sessionId: string, workerId: string) => void;
  readonly setActiveSession: (id: string | null) => void;
  readonly updateSession: (id: string, updates: Partial<Session>) => void;
}

/**
 * Zustand store for SWARM orchestration sessions.
 *
 * Uses immer for immutable updates and `subscribeWithSelector`
 * for fine-grained subscriptions.
 */
export const useSessionStore = create<SessionStoreState & SessionStoreActions>()(
  subscribeWithSelector(
    immer((set) => ({
      sessions: new Map(),
      activeSessionId: null,

      addSession(session) {
        set((s) => {
          s.sessions.set(session.id, session);
        });
      },

      removeSession(id) {
        set((s) => {
          s.sessions.delete(id);
          if (s.activeSessionId === id) s.activeSessionId = null;
        });
      },

      removeWorkerFromSession(sessionId, workerId) {
        set((s) => {
          const session = s.sessions.get(sessionId);
          if (!session) return;
          session.workerIds = session.workerIds.filter((id) => id !== workerId);
        });
      },

      setActiveSession(id) {
        set((s) => {
          s.activeSessionId = id;
        });
      },

      updateSession(id, updates) {
        set((s) => {
          const session = s.sessions.get(id);
          if (session) Object.assign(session, updates);
        });
      },
    })),
  ),
);
