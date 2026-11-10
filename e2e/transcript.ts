import type { Locator } from "@playwright/test";
import { expect, type SwarmApp } from "./fixtures.ts";
import type { DomainEventFrame } from "./tauri-ipc.ts";

/**
 * Deterministic event logs in the shapes the Rust core emits
 * (`crates/swarm-core` `DomainEvent`, validated on arrival by
 * `#lib/event-payloads` and `#lib/agent-events`). A log is replayed through
 * `emitEvents`, so the transcript is reduced by the same stores production
 * feeds (`#store/agent-sessions`, `#store/workers`).
 */

/** A fixed epoch, so every rendered timestamp is the same on every run. */
const T0 = Date.parse("2026-11-10T08:00:00Z");

export const AGENT_WORKER = "a0000000-0000-4000-8000-0000000000a1";
export const AGENT_WORKER_NAME = "Lint Fixer";

/** A worker with no provider session: its AI tab is the webview `AIChat`. */
const CHAT_WORKER = "b0000000-0000-4000-8000-0000000000b2";
export const CHAT_WORKER_NAME = "Chat Worker";

/**
 * Opens a worker's AI tab from the Workers list and returns its transcript
 * (the chat's `role="log"` scroller).
 */
export async function openWorkerChat(app: SwarmApp, workerName: string): Promise<Locator> {
  await app.goTo("Workers");
  await app.main.getByRole("tab", { name: "List" }).click();
  await app.main.getByRole("listitem").filter({ hasText: workerName }).getByRole("button").click();
  await app.page.getByRole("tab", { name: "AI Chat" }).click();
  const log = app.page.getByRole("log", { name: /Chat/ });
  await log.waitFor();
  return log;
}

/**
 * Sends each message through the webview chat's composer and waits for its
 * turn to commit (its user bubble is in the log and no bubble is still
 * streaming), so the transcript grows by one user and one assistant message
 * per send. Needs `routeAnthropic`; a message that triggers an approval
 * never commits, so send it with {@link sendChatMessage} instead.
 */
export async function sendChatMessages(
  app: SwarmApp,
  log: Locator,
  messages: readonly string[],
): Promise<void> {
  const sent = log.getByText("You:", { exact: true });
  for (const message of messages) {
    const before = await sent.count();
    await sendChatMessage(app, message);
    await expect(sent).toHaveCount(before + 1);
    await expect(log.locator('[aria-busy="true"]')).toHaveCount(0);
  }
}

/** Types `message` into the webview chat's composer and sends it. */
export async function sendChatMessage(app: SwarmApp, message: string): Promise<void> {
  await app.page.getByRole("textbox", { name: /^Message / }).fill(message);
  await app.page.getByRole("button", { name: "Send", exact: true }).click();
}

/** Claude Code's announced capabilities: interactive permissions, so a request waits for an answer. */
const CLAUDE_CODE_CAPABILITIES = {
  partialDeltas: true,
  resume: true,
  nativeCost: true,
  permissionModes: ["default", "acceptEdits"],
  cancelGranularity: "graceful",
  interruptMidturn: true,
  worktreeAware: true,
  interactivePermissions: true,
};

/** Hands out continuous `seq`s, as the event log does. */
export class EventLog {
  private seq: number;

  constructor(lastSeq = 0) {
    this.seq = lastSeq;
  }

  event(type: string, payload: Record<string, unknown>, originWorker?: string): DomainEventFrame {
    this.seq += 1;
    return {
      seq: this.seq,
      ts: T0 + this.seq * 1000,
      type,
      payload,
      ...(originWorker ? { originWorker } : {}),
    };
  }

  /** A worker and its Claude Code session, ready for turns. */
  agentWorker(workerId = AGENT_WORKER, name = AGENT_WORKER_NAME): DomainEventFrame[] {
    return [
      this.event("worker_spawned", { workerId, name, pid: 4242, isolation: "worktree" }),
      this.event("agent_session_started", {
        workerId,
        provider: "claude_code",
        sessionKey: "sess-0001",
        model: "claude-fable-5-2",
        cwd: "/work/repo",
        capabilities: CLAUDE_CODE_CAPABILITIES,
      }),
    ];
  }

  /** A worker with no provider session (the webview chat's worker). */
  webviewWorker(workerId = CHAT_WORKER, name = CHAT_WORKER_NAME): DomainEventFrame {
    return this.event("worker_spawned", { workerId, name, pid: 4343, isolation: "worktree" });
  }

  /** One assistant text block (a transcript row of its own). */
  text(workerId: string, turnId: string, blockIndex: number, text: string): DomainEventFrame {
    return this.event("agent_block", {
      workerId,
      turnId,
      blockIndex,
      kind: "text",
      content: { type: "text", text },
    });
  }

  /**
   * One finished turn of mixed rows: a thinking block, assistant text, a
   * tool call with its result, a failed tool call, more text, and the
   * settle receipt.
   */
  turn(workerId: string, turnId: string, n: number): DomainEventFrame[] {
    const read = `toolu_${turnId}_read`;
    const bash = `toolu_${turnId}_bash`;
    return [
      this.event("agent_block", {
        workerId,
        turnId,
        blockIndex: 0,
        kind: "thinking",
        content: { type: "thinking", thinking: `Turn ${n}: check the lint output before editing.` },
      }),
      this.text(
        workerId,
        turnId,
        1,
        `Turn ${n}: the linter reports **3 problems** in \`src/lib/format.ts\`. Reading the file first.`,
      ),
      this.event("agent_tool_call", {
        workerId,
        turnId,
        toolUseId: read,
        name: "Read",
        input: { file_path: "src/lib/format.ts", limit: 40 },
      }),
      this.event("agent_tool_result", {
        workerId,
        turnId,
        toolUseId: read,
        isError: false,
        content: 'export function formatBytes(n: number): string {\n  return n + " B";\n}\n',
      }),
      this.event("agent_tool_call", {
        workerId,
        turnId,
        toolUseId: bash,
        name: "Bash",
        input: { command: "pnpm exec biome ci src/lib/format.ts" },
      }),
      this.event("agent_tool_result", {
        workerId,
        turnId,
        toolUseId: bash,
        isError: true,
        content:
          "src/lib/format.ts:2:10 lint/style/useTemplate  FIXABLE\n  × Template literal expected.",
      }),
      this.text(
        workerId,
        turnId,
        4,
        `Turn ${n} done:\n\n- replaced the concatenation with a template literal\n- re-ran the check`,
      ),
      this.event("agent_turn_settled", {
        workerId,
        turnId,
        status: "ok",
        costUsd: 0.0123,
        durationMs: 8400,
        numTurns: 3,
      }),
    ];
  }

  /** A permission request the provider waits on (no `suggestedDecision`). */
  pendingApproval(workerId: string, turnId: string): DomainEventFrame {
    return this.event("agent_permission_request", {
      workerId,
      turnId,
      requestId: `req_${turnId}`,
      tool: "Bash",
      input: { command: "git push origin swarm/lint-fixer" },
      message: "Claude wants to run: git push origin swarm/lint-fixer",
    });
  }
}
