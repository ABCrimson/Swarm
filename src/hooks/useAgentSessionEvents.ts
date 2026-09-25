import { useEffect } from "react";
import type * as z from "zod";
import {
  AgentBlockPayloadSchema,
  AgentPermissionRequestPayloadSchema,
  AgentSessionExitedPayloadSchema,
  AgentSessionStartedPayloadSchema,
  AgentToolCallPayloadSchema,
  AgentToolResultPayloadSchema,
  AgentTurnDeltaPayloadSchema,
  AgentTurnSettledPayloadSchema,
} from "#lib/agent-events";
import { onEvent } from "#lib/event-bus";
import { type AgentTranscriptEvent, useAgentSessionStore } from "#store/agent-sessions";

/** Transcript events and the schema each payload must match. */
const TRANSCRIPT_EVENTS = {
  agent_turn_delta: AgentTurnDeltaPayloadSchema,
  agent_block: AgentBlockPayloadSchema,
  agent_tool_call: AgentToolCallPayloadSchema,
  agent_tool_result: AgentToolResultPayloadSchema,
  agent_permission_request: AgentPermissionRequestPayloadSchema,
  agent_turn_settled: AgentTurnSettledPayloadSchema,
} as const satisfies Record<AgentTranscriptEvent["type"], z.ZodType>;

/**
 * Bridges the `agent_*` event family onto `useAgentSessionStore`, the
 * way `#hooks/useWorkerEvents` bridges `worker_*` onto the worker store:
 *
 * - `agent_session_started` → `setSession`, `agent_session_exited` →
 *   `removeSession`;
 * - every transcript event (deltas, blocks, tool calls and results,
 *   permission requests, turn receipts) → `applyEvent`, so each
 *   session's chat is kept whether or not its `AgentChat` is mounted.
 *
 * Payloads are `safeParse`d at this seam; an unexpected shape is logged
 * and dropped, never trusted via `as`. Call exactly once, at the app
 * root (`App.tsx`); every listener is removed on unmount.
 */
export function useAgentSessionEvents(): void {
  useEffect(() => {
    const { setSession, removeSession, applyEvent } = useAgentSessionStore.getState();

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
      ...(Object.keys(TRANSCRIPT_EVENTS) as AgentTranscriptEvent["type"][]).map((type) =>
        onEvent(type, (e) => {
          const parsed = TRANSCRIPT_EVENTS[type].safeParse(e.payload);
          if (!parsed.success) {
            console.error(`useAgentSessionEvents: invalid ${type} payload`, parsed.error);
            return;
          }
          applyEvent({ type, seq: e.seq, payload: parsed.data } as AgentTranscriptEvent);
        }),
      ),
    ];

    return () => {
      for (const off of offs) off();
    };
  }, []);
}
