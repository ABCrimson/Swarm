import { useEffect } from "react";
import * as z from "zod";
import { onEvent } from "#lib/event-bus";
import { listSessions } from "#lib/tauri";
import { useSessionStore } from "#store/sessions";
import { SessionWorkerRemovedPayloadSchema } from "#store/types";

/** `session_created` payload (Rust `SessionCreatedPayload`) — it never carries more than this. */
const SessionCreatedPayloadSchema = z.object({ sessionId: z.uuid(), name: z.string() });

/** `session_deleted` payload (Rust `SessionDeletedPayload`). */
const SessionDeletedPayloadSchema = z.object({ sessionId: z.uuid() });

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
 * - `session_worker_removed` -> store.removeWorkerFromSession()
 *
 * Every payload is `safeParse`d; an unexpected shape is logged and
 * dropped, never trusted via `as`. All listeners are removed on unmount.
 */
export function useSessionEvents(): void {
  useEffect(() => {
    const { addSession, hydrateSessions, removeSession, removeWorkerFromSession } =
      useSessionStore.getState();

    void listSessions().then(hydrateSessions, (err: unknown) => {
      console.error("useSessionEvents: could not restore persisted sessions", err);
    });

    const offs = [
      onEvent("session_created", (e) => {
        const parsed = SessionCreatedPayloadSchema.safeParse(e.payload);
        if (!parsed.success) {
          console.error("useSessionEvents: invalid session_created payload", parsed.error);
          return;
        }
        const { sessionId, name } = parsed.data;
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
      onEvent("session_deleted", (e) => {
        const parsed = SessionDeletedPayloadSchema.safeParse(e.payload);
        if (!parsed.success) {
          console.error("useSessionEvents: invalid session_deleted payload", parsed.error);
          return;
        }
        removeSession(parsed.data.sessionId);
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
