import { useEffect } from "react";
import { onEvent } from "#lib/event-bus";
import { listSessions } from "#lib/tauri";
import { useSessionStore } from "#store/sessions";
import type { Session } from "#store/types";

/** The session events that can contradict a not-yet-applied startup snapshot. */
type SnapshotEdit =
  | { readonly kind: "deleted"; readonly sessionId: string }
  | { readonly kind: "worker_added"; readonly sessionId: string; readonly workerId: string }
  | { readonly kind: "worker_removed"; readonly sessionId: string; readonly workerId: string };

/**
 * Applies `edits`, in arrival order, to the sessions of a startup snapshot.
 * A session the store does not hold yet cannot take the live event, so the
 * snapshot copy takes it instead; sessions the store already holds are left
 * alone by `hydrateSessions`, so edits to them are harmless.
 */
function applyEditsToSnapshot(
  snapshot: readonly Session[],
  edits: readonly SnapshotEdit[],
): Session[] {
  const byId = new Map(snapshot.map((session) => [session.id, session]));
  for (const edit of edits) {
    const session = byId.get(edit.sessionId);
    if (!session) continue;
    if (edit.kind === "deleted") {
      byId.delete(edit.sessionId);
    } else if (edit.kind === "worker_added") {
      if (!session.workerIds.includes(edit.workerId)) {
        byId.set(session.id, { ...session, workerIds: [...session.workerIds, edit.workerId] });
      }
    } else {
      byId.set(session.id, {
        ...session,
        workerIds: session.workerIds.filter((id) => id !== edit.workerId),
      });
    }
  }
  return [...byId.values()];
}

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
 * The snapshot is sequenced against those events: the ones that land before
 * it resolves are applied to the store immediately and also recorded, then
 * replayed over the snapshot before it is hydrated. A session deleted, or a
 * worker added or removed, in that window therefore wins over the stale
 * snapshot instead of being undone by it. Events after hydration, and every
 * event when the restore fails, are applied immediately and recorded nowhere.
 * Unmounting before the snapshot resolves discards it.
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

    // Non-null while the snapshot is in flight; null once it settled or the
    // hook unmounted.
    let pendingEdits: SnapshotEdit[] | null = [];

    void listSessions().then(
      (snapshot) => {
        if (pendingEdits === null) return;
        const edits = pendingEdits;
        pendingEdits = null;
        hydrateSessions(applyEditsToSnapshot(snapshot, edits));
      },
      (err: unknown) => {
        pendingEdits = null;
        console.error("useSessionEvents: could not restore persisted sessions", err);
      },
    );

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
      onEvent("session_deleted", ({ payload }) => {
        pendingEdits?.push({ kind: "deleted", sessionId: payload.sessionId });
        removeSession(payload.sessionId);
      }),
      onEvent("session_worker_added", ({ payload }) => {
        pendingEdits?.push({ kind: "worker_added", ...payload });
        addWorkerToSession(payload.sessionId, payload.workerId);
      }),
      onEvent("session_worker_removed", ({ payload }) => {
        pendingEdits?.push({ kind: "worker_removed", ...payload });
        removeWorkerFromSession(payload.sessionId, payload.workerId);
      }),
    ];

    return () => {
      pendingEdits = null;
      for (const off of offs) off();
    };
  }, []);
}
