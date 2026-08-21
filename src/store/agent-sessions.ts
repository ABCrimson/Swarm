import { enableMapSet } from "immer";
import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import { immer } from "zustand/middleware/immer";
import type { AgentSessionStartedPayload } from "#lib/agent-events";

// Required for immer producers that mutate native Map instances (below).
enableMapSet();

/**
 * Reactive state slice mirroring the Phase 3 `agent_session_started`/
 * `agent_session_exited` events (`#hooks/useAgentSessionEvents`) — the
 * runtime counterpart to `useWorkerAgentStore`'s spawn-time-only
 * metadata (role/model/systemPrompt). Keyed by worker id: an entry's
 * PRESENCE is what `WorkerAIPanel`/`Workers` use to decide "this worker
 * has a live Claude Code session" (route the chat input through
 * `agentSendTurn` and render `AgentChat` instead of the webview-direct
 * `AIChat`) rather than tracking provider on `Worker` itself, since a
 * worker's PTY and its attached agent session are independent
 * resources (see `docs/architecture.md`'s adapter-layer section).
 */
interface AgentSessionStoreState {
  readonly sessions: Map<string, AgentSessionStartedPayload>;
}

interface AgentSessionStoreActions {
  readonly setSession: (workerId: string, info: AgentSessionStartedPayload) => void;
  readonly removeSession: (workerId: string) => void;
}

export const useAgentSessionStore = create<AgentSessionStoreState & AgentSessionStoreActions>()(
  subscribeWithSelector(
    immer((set) => ({
      sessions: new Map(),

      setSession(workerId, info) {
        set((s) => {
          s.sessions.set(workerId, info);
        });
      },

      removeSession(workerId) {
        set((s) => {
          s.sessions.delete(workerId);
        });
      },
    })),
  ),
);
