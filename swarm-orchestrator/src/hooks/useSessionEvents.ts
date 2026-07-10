import { useEffect } from "react";
import { onEvent } from "#lib/event-bus";
import { useSessionStore } from "#store/sessions";

/**
 * Global session event subscription hook.
 *
 * Must be called once at the app root level. Connects the single
 * ordered event bus to the Zustand session store:
 *
 * - `session_created` -> store.addSession()
 * - `session_deleted` -> store.removeSession()
 *
 * All listeners are cleaned up on unmount — zero event listener leaks.
 */
export function useSessionEvents(): void {
  useEffect(() => {
    const { addSession, removeSession } = useSessionStore.getState();

    const offs = [
      onEvent("session_created", (e) => {
        const p = e.payload as { sessionId: string; name: string };
        const now = new Date().toISOString();
        addSession({
          id: p.sessionId,
          name: p.name,
          workerIds: [],
          createdAt: now,
          updatedAt: now,
        });
      }),
      onEvent("session_deleted", (e) => {
        const p = e.payload as { sessionId: string };
        removeSession(p.sessionId);
      }),
    ];

    return () => {
      for (const off of offs) off();
    };
  }, []);
}
