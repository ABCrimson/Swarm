import { useEffect } from "react";
import { onEvent } from "#lib/event-bus";
import { type AgentTranscriptEvent, useAgentSessionStore } from "#store/agent-sessions";

/** Every transcript event type; the `satisfies` keeps the list exhaustive. */
const TRANSCRIPT_TYPES = Object.keys({
  agent_turn_delta: true,
  agent_block: true,
  agent_tool_call: true,
  agent_tool_result: true,
  agent_permission_request: true,
  agent_turn_settled: true,
} as const satisfies Record<AgentTranscriptEvent["type"], true>) as AgentTranscriptEvent["type"][];

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
 * Payloads arrive already validated by `#lib/event-bus`. Call exactly
 * once, at the app root (`App.tsx`); every listener is removed on unmount.
 */
export function useAgentSessionEvents(): void {
  useEffect(() => {
    const { setSession, removeSession, applyEvent } = useAgentSessionStore.getState();

    const offs = [
      onEvent("agent_session_started", ({ payload }) => setSession(payload.workerId, payload)),
      onEvent("agent_session_exited", ({ payload }) => removeSession(payload.workerId)),
      ...TRANSCRIPT_TYPES.map((type) =>
        onEvent(type, (e) =>
          applyEvent({ type, seq: e.seq, payload: e.payload } as AgentTranscriptEvent),
        ),
      ),
    ];

    return () => {
      for (const off of offs) off();
    };
  }, []);
}
