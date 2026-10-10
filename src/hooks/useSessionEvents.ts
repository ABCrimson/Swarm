import { useEffect } from "react";
import { onEvent } from "#lib/event-bus";
import { listSessions } from "#lib/tauri";
import { useSessionStore } from "#store/sessions";

/**
 * Global session sync. Must be called once, at the app root.
 *
 * On mount it restores the sessions the backend persisted (`sessions.json`,
 * reloaded at backend startup) into the store — without this, the session
 * list and history search would only ever show sessions created in the
 * current run. It then keeps the store in step with the ordered event bus:
 *
 * - `session_created`        -> store.addSession() (merged, see below)
 * - `session_deleted`        -> store.removeSession()
 * - `session_worker_added`   -> store.addWorkerToSession() (idempotent)
 * - `session_worker_removed` -> store.removeWorkerFromSession()
 *
 * Payloads arrive already validated by `#lib/event-bus`. All listeners
 * are removed on unmount.
 */
export function useSessionEvents(): void {
  useEffect(() => {
    const {
      addSession,
      addWorkerToSession,
      hydrateSessions,
      removeSession,
      removeWorkerFromSession,
    } = useSessionStore.getState();

    void listSessions().then(hydrateSessions, (err: unknown) => {
      console.error("useSessionEvents: could not restore persisted sessions", err);
    });

    const offs = [
      onEvent("session_created", ({ payload: { sessionId, name } }) => {
        const now = new Date().toISOString();
        // Merge into any record already in the store instead of a blind
        // replace. Rust emits this event as part of `create_session`, so
        // a client-side creator (`applyTemplate`, `#lib/session-lifecycle`)
        // racing its own IPC response's addSession() against this event
        // is expected, in either order:
        //   - event first: this creates a { workerIds: [] } stub, then
        //     the IPC-response addSession() overwrites it with the
        //     normalized Session — fine, neither has spawned workers yet.
        //   - IPC response first: the store already holds the real
        //     Session (and may already have grown workerIds from spawns
        //     that ran after it) by the time this event lands — a naive
        //     replace here would reset workerIds back to `[]` and
        //     silently drop every worker registered so far.
        const existing = useSessionStore.getState().sessions.get(sessionId);
        addSession({
          ...existing,
          id: sessionId,
          name,
          workerIds: existing?.workerIds ?? [],
          createdAt: existing?.createdAt ?? now,
          updatedAt: existing?.updatedAt ?? now,
        });
      }),
      onEvent("session_deleted", ({ payload }) => removeSession(payload.sessionId)),
      onEvent("session_worker_added", ({ payload }) =>
        addWorkerToSession(payload.sessionId, payload.workerId),
      ),
      onEvent("session_worker_removed", ({ payload }) =>
        removeWorkerFromSession(payload.sessionId, payload.workerId),
      ),
    ];

    return () => {
      for (const off of offs) off();
    };
  }, []);
}
