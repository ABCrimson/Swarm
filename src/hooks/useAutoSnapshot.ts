import { useAtomValue } from "jotai";
import { useEffect, useRef } from "react";

import { createSnapshot } from "#lib/snapshots";
import { useSessionStore } from "#store/sessions";
import { appSettingsAtom } from "#store/ui";

/**
 * Hook that automatically creates snapshots of the active session at
 * the interval configured in Settings (Auto-Snapshot Interval). Should
 * be called once at the app root level.
 */
export function useAutoSnapshot(): void {
  const intervalMin = useAtomValue(appSettingsAtom).snapshotIntervalMin;
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    intervalRef.current = setInterval(
      () => {
        const { activeSessionId, sessions } = useSessionStore.getState();
        if (!activeSessionId) return;

        const session = sessions.get(activeSessionId);
        if (!session) return;

        createSnapshot(session).catch((err: unknown) => {
          console.warn("[auto-snapshot] Failed:", err);
        });
      },
      intervalMin * 60 * 1000,
    );

    return () => {
      if (intervalRef.current !== null) {
        clearInterval(intervalRef.current);
      }
    };
  }, [intervalMin]);
}
