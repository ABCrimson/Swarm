import { useEffect } from "react";
import {
  AgentSessionExitedPayloadSchema,
  AgentSessionStartedPayloadSchema,
} from "#lib/agent-events";
import { onEvent } from "#lib/event-bus";
import { useAgentSessionStore } from "#store/agent-sessions";

/**
 * Global agent-session event subscription hook (Phase 3) — mirrors
 * `#hooks/useWorkerEvents`'s pattern exactly, one level up: where that
 * hook bridges `worker_*` events onto `useWorkerStore`, this one
 * bridges `agent_session_started`/`agent_session_exited` onto
 * `useAgentSessionStore`.
 *
 * - `agent_session_started` -> store.setSession() (`safeParse`'d — an
 *   unexpected shape is logged and dropped, never trusted via `as`)
 * - `agent_session_exited`  -> store.removeSession()
 *
 * Must be called exactly once at the app root level (see `App.tsx`,
 * alongside `useWorkerEvents`). All listeners are cleaned up on
 * unmount.
 */
export function useAgentSessionEvents(): void {
  useEffect(() => {
    const { setSession, removeSession } = useAgentSessionStore.getState();

    const offs = [
      onEvent("agent_session_started", (e) => {
        const parsed = AgentSessionStartedPayloadSchema.safeParse(e.payload);
        if (!parsed.success) {
          console.error(
            "useAgentSessionEvents: invalid agent_session_started payload",
            parsed.error,
          );
          return;
        }
        setSession(parsed.data.workerId, parsed.data);
      }),
      onEvent("agent_session_exited", (e) => {
        const parsed = AgentSessionExitedPayloadSchema.safeParse(e.payload);
        if (!parsed.success) {
          console.error(
            "useAgentSessionEvents: invalid agent_session_exited payload",
            parsed.error,
          );
          return;
        }
        removeSession(parsed.data.workerId);
      }),
    ];

    return () => {
      for (const off of offs) off();
    };
  }, []);
}
