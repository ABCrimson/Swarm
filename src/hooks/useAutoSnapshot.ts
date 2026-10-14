import { useAtomValue } from "jotai";
import { useEffect } from "react";
import { onEvent } from "#lib/event-bus";
import { clearSnapshots, createSnapshot } from "#lib/snapshots";
import { hasCapability, isTauri } from "#lib/tauri";
import { useSessionStore } from "#store/sessions";
import { appSettingsAtom } from "#store/ui";

/**
 * Owns the snapshot lifecycle; call once, at the app root. Snapshots
 * the active session every Auto-Snapshot Interval minutes (Settings;
 * at least one minute, see `appSettingsAtom`), and deletes a session's
 * snapshots when the session is deleted (`session_deleted`), so
 * `swarm-snapshots.json` does not keep them forever. Both are no-ops
 * unless the transport offers local stores and the Tauri bridge is
 * present: snapshots are plugin-store files, read and written without a
 * user action, so a plain-browser preview of the desktop build must not
 * reach for them either.
 */
export function useAutoSnapshot(): void {
  const available = hasCapability("localStores") && isTauri();
  const intervalMin = useAtomValue(appSettingsAtom).snapshotIntervalMin;

  useEffect(() => {
    if (!available) return;
    return onEvent("session_deleted", ({ payload }) => {
      clearSnapshots(payload.sessionId).catch((err: unknown) => {
        console.warn("[auto-snapshot] Could not delete the session's snapshots:", err);
      });
    });
  }, [available]);

  useEffect(() => {
    if (!available) return;
    const timer = setInterval(() => {
      const { activeSessionId, sessions } = useSessionStore.getState();
      const session = activeSessionId === null ? undefined : sessions.get(activeSessionId);
      if (!session) return;
      createSnapshot(session).catch((err: unknown) => {
        console.warn("[auto-snapshot] Failed:", err);
      });
    }, intervalMin * 60_000);
    return () => clearInterval(timer);
  }, [available, intervalMin]);
}
