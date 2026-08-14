// ── Provenance threading through the AI tool loop (provenance Phase 5a) ──
//
// AIChat.tsx's doSend calls agent_turn_started once per turn and passes
// the resulting {originWorker: workerId, causeSeq: turnSeq} into
// executeTool for every tool call that turn. This proves that
// attribution actually reaches the IPC layer for every side-effectful
// built-in tool (kill_worker, run_command/worker_input) — spawn_worker
// and write_file are covered in their own dedicated test files
// (tools-spawn-worker.test.ts, tools-file-io.test.ts).

import { beforeEach, describe, expect, it, vi } from "vitest";
import { executeTool, toolRegistry } from "#lib/tools";

const invokeMock = vi.fn();

vi.mock("#lib/tauri", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
  // #lib/tools transitively imports the custom-tools store, which calls
  // isTauri() at module load time — must be present on this mock even
  // though these tests never exercise the custom-tool path.
  isTauri: () => false,
}));

const killWorkerTool = toolRegistry.get("kill_worker");
const runCommandTool = toolRegistry.get("run_command");

beforeEach(() => {
  invokeMock.mockReset();
});

describe("kill_worker tool provenance", () => {
  it("forwards originWorker/causeSeq when called inside an AI turn", async () => {
    invokeMock.mockResolvedValueOnce(undefined);

    await killWorkerTool?.execute(
      { workerId: "w-target" },
      { originWorker: "w-caller", causeSeq: 41 },
    );

    expect(invokeMock).toHaveBeenCalledWith("kill_worker", {
      id: "w-target",
      originWorker: "w-caller",
      causeSeq: 41,
    });
  });

  it("sends undefined originWorker/causeSeq when called with no provenance", async () => {
    invokeMock.mockResolvedValueOnce(undefined);

    await killWorkerTool?.execute({ workerId: "w-target" });

    expect(invokeMock).toHaveBeenCalledWith("kill_worker", {
      id: "w-target",
      originWorker: undefined,
      causeSeq: undefined,
    });
  });
});

describe("run_command tool provenance", () => {
  it("tags source: tool and forwards originWorker/causeSeq", async () => {
    invokeMock.mockResolvedValueOnce(undefined);

    await runCommandTool?.execute(
      { workerId: "w-target", command: "pnpm build" },
      { originWorker: "w-caller", causeSeq: 7 },
    );

    expect(invokeMock).toHaveBeenCalledWith("worker_input", {
      id: "w-target",
      data: "pnpm build\n",
      source: "tool",
      originWorker: "w-caller",
      causeSeq: 7,
    });
  });
});

describe("executeTool forwards provenance to the underlying built-in tool", () => {
  it("passes prov through to kill_worker's execute", async () => {
    invokeMock.mockResolvedValueOnce(undefined);

    await executeTool("kill_worker", { workerId: "w-x" }, { originWorker: "w-y", causeSeq: 3 });

    expect(invokeMock).toHaveBeenCalledWith("kill_worker", {
      id: "w-x",
      originWorker: "w-y",
      causeSeq: 3,
    });
  });
});
