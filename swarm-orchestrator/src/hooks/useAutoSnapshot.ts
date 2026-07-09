import { useEffect, useRef } from "react";

import { createSnapshot } from "#lib/snapshots";
import { useSessionStore } from "#store/sessions";

/** Auto-snapshot interval: 5 minutes. */
const SNAPSHOT_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Hook that automatically creates snapshots of the active session
 * at a 5-minute interval. Should be called once at the app root level.
 */
export function useAutoSnapshot(): void {
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    intervalRef.current = setInterval(() => {
      const { activeSessionId, sessions } = useSessionStore.getState();
      if (!activeSessionId) return;

      const session = sessions.get(activeSessionId);
      if (!session) return;

      createSnapshot(session).catch((err: unknown) => {
        console.warn("[auto-snapshot] Failed:", err);
      });
    }, SNAPSHOT_INTERVAL_MS);

    return () => {
      if (intervalRef.current !== null) {
        clearInterval(intervalRef.current);
      }
    };
  }, []);
}
