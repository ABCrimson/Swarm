// agent_session_started / agent_session_exited -> useAgentSessionStore
// setSession / removeSession, with the event bus mocked (same harness as
// useWorkerEvents.test.tsx).

import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAgentSessionEvents } from "#hooks/useAgentSessionEvents";
import type { Capabilities } from "#lib/agent-events";
import { useAgentSessionStore } from "#store/agent-sessions";

type Handler = (e: { payload: unknown }) => void;

const registered = new Map<string, Handler>();

vi.mock("#lib/event-bus", () => ({
  onEvent: (type: string, handler: Handler) => {
    registered.set(type, handler);
    return () => registered.delete(type);
  },
}));

function resetStore(): void {
  for (const [id] of useAgentSessionStore.getState().sessions) {
    useAgentSessionStore.getState().removeSession(id);
  }
}

const CAPABILITIES: Capabilities = {
  partialDeltas: true,
  resume: true,
  nativeCost: true,
  permissionModes: ["default", "dontAsk", "acceptEdits"],
  cancelGranularity: "kill_only",
  interruptMidturn: false,
  worktreeAware: true,
  interactivePermissions: false,
};

describe("useAgentSessionEvents", () => {
  beforeEach(() => {
    resetStore();
    registered.clear();
  });
  afterEach(resetStore);

  it("records a session on agent_session_started", () => {
    const workerId = "11111111-2222-3333-8444-555555555555";

    renderHook(() => useAgentSessionEvents());
    registered.get("agent_session_started")?.({
      payload: {
        workerId,
        provider: "claude_code",
        sessionKey: workerId,
        model: "claude-sonnet-5",
        cwd: "/repo",
        capabilities: CAPABILITIES,
      },
    });

    const session = useAgentSessionStore.getState().sessions.get(workerId);
    expect(session?.provider).toBe("claude_code");
    expect(session?.model).toBe("claude-sonnet-5");
  });

  it("removes the session on agent_session_exited", () => {
    const workerId = "22222222-3333-4444-8555-666666666666";
    useAgentSessionStore.getState().setSession(workerId, {
      workerId,
      provider: "claude_code",
      sessionKey: workerId,
      model: "sonnet",
      cwd: "/repo",
      capabilities: CAPABILITIES,
    });

    renderHook(() => useAgentSessionEvents());
    registered.get("agent_session_exited")?.({ payload: { workerId, exitCode: 0 } });

    expect(useAgentSessionStore.getState().sessions.has(workerId)).toBe(false);
  });
});
