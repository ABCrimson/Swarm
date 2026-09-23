import { useAtomValue } from "jotai";
import { useEffect } from "react";
import { onEvent } from "#lib/event-bus";
import { clearSnapshots, createSnapshot } from "#lib/snapshots";
import { useSessionStore } from "#store/sessions";
import { appSettingsAtom } from "#store/ui";

/**
 * Owns the snapshot lifecycle; call once, at the app root. Snapshots
 * the active session every Auto-Snapshot Interval minutes (Settings;
 * at least one minute, see `appSettingsAtom`), and deletes a session's
 * snapshots when the session is deleted (`session_deleted`), so
 * `swarm-snapshots.json` does not keep them forever.
 */
export function useAutoSnapshot(): void {
  const intervalMin = useAtomValue(appSettingsAtom).snapshotIntervalMin;

  useEffect(
    () =>
      onEvent("session_deleted", ({ payload }) => {
        clearSnapshots(payload.sessionId).catch((err: unknown) => {
          console.warn("[auto-snapshot] Could not delete the session's snapshots:", err);
        });
      }),
    [],
  );

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
