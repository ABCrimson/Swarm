// Provenance threading through the AI tool loop: `#lib/ai-chat` calls
// agent_turn_started once per turn and passes the resulting
// {originWorker, causeSeq} into executeTool for every tool call that
// turn. These tests prove that attribution reaches the IPC layer for
// the side-effectful built-ins kill_worker and run_command, and that
// malformed model input never reaches it at all. spawn_worker and
// write_file have their own files (tools.spawn-worker.test.ts,
// tools.file-io.test.ts).

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("#lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#lib/tauri")>()),
  killWorker: vi.fn().mockResolvedValue(undefined),
  workerInput: vi.fn().mockResolvedValue(undefined),
}));

import { killWorker, workerInput } from "#lib/tauri";
import { executeTool, grantToolCallForSession, resetToolApprovals } from "#lib/tools";

const TARGET = "11111111-2222-4333-8444-555555555555";
const CALLER = "66666666-7777-4888-8999-aaaaaaaaaaaa";

beforeEach(() => {
  vi.mocked(killWorker).mockClear();
  vi.mocked(workerInput).mockClear();
  resetToolApprovals();
  // The approval step has its own tests (tools.approval.test.ts): grant
  // exactly the calls below.
  grantToolCallForSession("kill_worker", { workerId: TARGET }, CALLER);
  grantToolCallForSession("kill_worker", { workerId: TARGET });
  grantToolCallForSession("run_command", { workerId: TARGET, command: "pnpm build" }, CALLER);
  grantToolCallForSession("run_command", { workerId: TARGET, command: "ls" });
});

describe("kill_worker", () => {
  it("forwards originWorker/causeSeq when called inside an AI turn", async () => {
    const result = await executeTool(
      "kill_worker",
      { workerId: TARGET },
      { originWorker: CALLER, causeSeq: 41 },
    );

    expect(result).toEqual({ success: true, data: { killed: TARGET } });
    expect(killWorker).toHaveBeenCalledExactlyOnceWith(TARGET, {
      originWorker: CALLER,
      causeSeq: 41,
    });
  });

  it("passes no provenance when called outside a turn", async () => {
    await executeTool("kill_worker", { workerId: TARGET });

    expect(killWorker).toHaveBeenCalledExactlyOnceWith(TARGET, undefined);
  });

  it.each([[{}], [{ workerId: "w-target" }], [{ workerId: 42 }], [null]])(
    "rejects malformed input %j without calling the backend",
    async (input) => {
      const result = await executeTool("kill_worker", input);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Invalid Input For kill_worker");
      expect(killWorker).not.toHaveBeenCalled();
    },
  );
});

describe("run_command", () => {
  it("types the command plus Enter, tagged source: tool, with the turn's provenance", async () => {
    const result = await executeTool(
      "run_command",
      { workerId: TARGET, command: "pnpm build" },
      { originWorker: CALLER, causeSeq: 7 },
    );

    expect(result).toEqual({ success: true, data: { sent: "pnpm build" } });
    expect(workerInput).toHaveBeenCalledExactlyOnceWith(TARGET, "pnpm build\n", "tool", {
      originWorker: CALLER,
      causeSeq: 7,
    });
  });

  it.each([
    [{ workerId: TARGET }],
    [{ workerId: TARGET, command: "" }],
    [{ workerId: TARGET, command: { rm: "-rf" } }],
  ])("never types anything into the PTY for malformed input %j", async (input) => {
    const result = await executeTool("run_command", input);

    expect(result.success).toBe(false);
    expect(workerInput).not.toHaveBeenCalled();
  });

  it("surfaces a backend rejection as a failed result", async () => {
    vi.mocked(workerInput).mockRejectedValueOnce("Worker Not Found");

    expect(await executeTool("run_command", { workerId: TARGET, command: "ls" })).toEqual({
      success: false,
      error: "Worker Not Found",
    });
  });
});
