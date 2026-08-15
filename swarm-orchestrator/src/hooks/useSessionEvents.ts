import { useEffect } from "react";
import { onEvent } from "#lib/event-bus";
import { useSessionStore } from "#store/sessions";
import { SessionWorkerRemovedPayloadSchema } from "#store/types";

/**
 * Global session event subscription hook.
 *
 * Must be called once at the app root level. Connects the single
 * ordered event bus to the Zustand session store:
 *
 * - `session_created`        -> store.addSession() (merged, see below)
 * - `session_deleted`        -> store.removeSession()
 * - `session_worker_removed` -> store.removeWorkerFromSession()
 *   (`safeParse`'d — an unexpected shape is logged and dropped, never
 *   trusted via `as`, matching `useAgentSessionEvents`'s discipline)
 *
 * All listeners are cleaned up on unmount — zero event listener leaks.
 */
export function useSessionEvents(): void {
  useEffect(() => {
    const { addSession, removeSession, removeWorkerFromSession } = useSessionStore.getState();

    const offs = [
      onEvent("session_created", (e) => {
        const p = e.payload as { sessionId: string; name: string };
        const now = new Date().toISOString();
        // Merge into any record already in the store instead of a blind
        // replace. Rust emits this event as part of `create_session`,
        // so a client-driven creator (applyTemplate, useSessionActions)
        // racing its own IPC response's addSession() against this event
        // is expected, in either order:
        //   - event first: this creates a { workerIds: [] } stub, then
        //     the IPC-response addSession() overwrites it with the
        //     normalized Session — fine, neither has spawned workers yet.
        //   - IPC response first: the store already holds the real
        //     Session (and may already have grown workerIds from
        //     spawns that ran after it) by the time this event lands —
        //     a naive replace here would reset workerIds back to `[]`
        //     and silently drop every worker registered so far.
        // The event payload itself only ever carries { sessionId, name }
        // — anything richer (workerIds, config, real timestamps) comes
        // from whatever's already in the store, if anything is.
        const existing = useSessionStore.getState().sessions.get(p.sessionId);
        addSession({
          ...existing,
          id: p.sessionId,
          name: p.name,
          workerIds: existing?.workerIds ?? [],
          createdAt: existing?.createdAt ?? now,
          updatedAt: existing?.updatedAt ?? now,
        });
      }),
      onEvent("session_deleted", (e) => {
        const p = e.payload as { sessionId: string };
        removeSession(p.sessionId);
      }),
      onEvent("session_worker_removed", (e) => {
        const parsed = SessionWorkerRemovedPayloadSchema.safeParse(e.payload);
        if (!parsed.success) {
          console.error("useSessionEvents: invalid session_worker_removed payload", parsed.error);
          return;
        }
        removeWorkerFromSession(parsed.data.sessionId, parsed.data.workerId);
      }),
    ];

    return () => {
      for (const off of offs) off();
    };
  }, []);
}
