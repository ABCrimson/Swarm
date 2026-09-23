import { useAtomValue } from "jotai";
import { useEffect } from "react";
import { createSnapshot } from "#lib/snapshots";
import { useSessionStore } from "#store/sessions";
import { appSettingsAtom } from "#store/ui";

/**
 * Snapshots the active session every Auto-Snapshot Interval minutes
 * (Settings; validated to at least one minute by `appSettingsAtom`).
 * Called once, at the app root.
 */
export function useAutoSnapshot(): void {
  const intervalMin = useAtomValue(appSettingsAtom).snapshotIntervalMin;

  useEffect(() => {
    const timer = setInterval(() => {
      const { activeSessionId, sessions } = useSessionStore.getState();
      const session = activeSessionId === null ? undefined : sessions.get(activeSessionId);
      if (!session) return;
      createSnapshot(session).catch((err: unknown) => {
        console.warn("[auto-snapshot] Failed:", err);
      });
    }, intervalMin * 60_000);
    return () => clearInterval(timer);
  }, [intervalMin]);
}
