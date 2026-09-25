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
  /** Inserts or replaces one session. */
  readonly addSession: (session: Session) => void;
  /**
   * Adds every session not already in the store, in one update — the
   * startup restore of the backend's persisted sessions. An entry the
   * store already holds (created or grown this run) is newer than the
   * persisted copy and is kept as is.
   */
  readonly hydrateSessions: (sessions: readonly Session[]) => void;
  readonly removeSession: (id: string) => void;
  /**
   * Appends `workerId` to a session's `workerIds` unless it is already
   * there: the `session_add_worker` result and its `session_worker_added`
   * event both land here, in either order.
   */
  readonly addWorkerToSession: (sessionId: string, workerId: string) => void;
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

      hydrateSessions(sessions) {
        set((s) => {
          for (const session of sessions) {
            if (!s.sessions.has(session.id)) s.sessions.set(session.id, session);
          }
        });
      },

      removeSession(id) {
        set((s) => {
          s.sessions.delete(id);
          if (s.activeSessionId === id) s.activeSessionId = null;
        });
      },

      addWorkerToSession(sessionId, workerId) {
        set((s) => {
          const session = s.sessions.get(sessionId);
          if (session && !session.workerIds.includes(workerId)) session.workerIds.push(workerId);
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
