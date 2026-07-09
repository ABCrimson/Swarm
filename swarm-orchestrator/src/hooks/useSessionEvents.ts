import { useEffect } from "react";
import { onSessionCreated, onSessionDeleted } from "#lib/tauri";
import { useSessionStore } from "#store/sessions";

/**
 * Global session event subscription hook.
 *
 * Must be called once at the app root level. Connects Tauri backend
 * session events to the Zustand session store:
 *
 * - `session:created` -> store.addSession()
 * - `session:deleted` -> store.removeSession()
 *
 * All listeners are cleaned up on unmount — zero event listener leaks.
 */
export function useSessionEvents(): void {
  useEffect(() => {
    let cancelled = false;
    const cleanups: Array<() => void> = [];

    const setupListeners = async (): Promise<void> => {
      const { addSession, removeSession } = useSessionStore.getState();

      const unlistenCreated = await onSessionCreated((session) => {
        addSession(session);
      });
      if (cancelled) {
        unlistenCreated();
        return;
      }
      cleanups.push(unlistenCreated);

      const unlistenDeleted = await onSessionDeleted(({ id }) => {
        removeSession(id);
      });
      if (cancelled) {
        unlistenDeleted();
        return;
      }
      cleanups.push(unlistenDeleted);
    };

    void setupListeners();

    return () => {
      cancelled = true;
      for (const cleanup of cleanups) {
        cleanup();
      }
    };
  }, []);
}
