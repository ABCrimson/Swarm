// The four tools that act on the user's machine wait for the user's
// approval before they run: allow once, allow for the session, or deny.
// Invalid input is rejected before any prompt, a denial reaches the model
// as an error result and never touches the backend, and stopping a turn
// denies the calls still waiting.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();

vi.mock("#lib/tauri", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
  workerInput: vi.fn().mockResolvedValue(undefined),
  killWorker: vi.fn().mockResolvedValue(undefined),
  isTauri: () => false,
}));
vi.mock("#lib/worker-spawn", () => ({ spawnWorkerFromSpec: vi.fn().mockResolvedValue("w-new") }));

import { workerInput } from "#lib/tauri";
import {
  denyPendingToolApprovals,
  executeTool,
  getPendingToolApprovals,
  resetToolApprovals,
  resolveToolApproval,
} from "#lib/tools";
import { spawnWorkerFromSpec } from "#lib/worker-spawn";

const WORKER = "11111111-2222-4333-8444-555555555555";
const OTHER = "66666666-7777-4888-8999-aaaaaaaaaaaa";

const CALLS = [
  ["run_command", { workerId: WORKER, command: "ls" }],
  ["spawn_worker", { name: "Child" }],
  ["write_file", { path: "/home/u/.swarm/x.txt", content: "x" }],
  ["read_file", { path: "/home/u/notes.txt" }],
] as const;

function backendCalls(): number {
  return (
    invokeMock.mock.calls.length +
    vi.mocked(workerInput).mock.calls.length +
    vi.mocked(spawnWorkerFromSpec).mock.calls.length
  );
}

function firstPendingId(): string {
  return getPendingToolApprovals()[0]?.id ?? "";
}

beforeEach(() => {
  invokeMock.mockReset().mockResolvedValue("file text");
  vi.mocked(workerInput).mockClear();
  vi.mocked(spawnWorkerFromSpec).mockClear();
});

afterEach(() => {
  resetToolApprovals();
});

describe("tool approval", () => {
  it.each(CALLS)("%s waits for approval and runs once allowed", async (name, input) => {
    const result = executeTool(name, input);
    await vi.waitFor(() => expect(getPendingToolApprovals()).toHaveLength(1));
    expect(getPendingToolApprovals()[0]).toMatchObject({ tool: name });
    expect(backendCalls()).toBe(0);

    resolveToolApproval(firstPendingId(), "once");

    expect((await result).success).toBe(true);
    expect(backendCalls()).toBeGreaterThan(0);
    expect(getPendingToolApprovals()).toHaveLength(0);
  });

  it.each(CALLS)("%s is not run when denied, and says so", async (name, input) => {
    const result = executeTool(name, input);
    await vi.waitFor(() => expect(getPendingToolApprovals()).toHaveLength(1));

    resolveToolApproval(firstPendingId(), "deny");

    expect(await result).toEqual({
      success: false,
      error: `The User Denied ${name}. It Was Not Run.`,
    });
    expect(backendCalls()).toBe(0);
  });

  it("allow once asks again on the next call", async () => {
    const first = executeTool("read_file", { path: "/home/u/a.txt" });
    await vi.waitFor(() => expect(getPendingToolApprovals()).toHaveLength(1));
    resolveToolApproval(firstPendingId(), "once");
    await first;

    const second = executeTool("read_file", { path: "/home/u/b.txt" });
    await vi.waitFor(() => expect(getPendingToolApprovals()).toHaveLength(1));
    resolveToolApproval(firstPendingId(), "deny");
    expect((await second).success).toBe(false);
  });

  it("allow for session releases pending calls of that tool and stops asking for it only", async () => {
    const a = executeTool("read_file", { path: "/home/u/a.txt" });
    const b = executeTool("read_file", { path: "/home/u/b.txt" });
    const other = executeTool("write_file", { path: "/home/u/.swarm/x", content: "x" });
    await vi.waitFor(() => expect(getPendingToolApprovals()).toHaveLength(3));

    resolveToolApproval(firstPendingId(), "session");

    expect((await a).success).toBe(true);
    expect((await b).success).toBe(true);
    expect(getPendingToolApprovals().map((request) => request.tool)).toEqual(["write_file"]);

    // No prompt for the granted tool any more.
    expect((await executeTool("read_file", { path: "/home/u/c.txt" })).success).toBe(true);
    expect(getPendingToolApprovals()).toHaveLength(1);

    resolveToolApproval(firstPendingId(), "deny");
    await other;
  });

  it("rejects invalid input without prompting", async () => {
    const result = await executeTool("run_command", { workerId: "nope", command: "" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid Input For run_command");
    expect(getPendingToolApprovals()).toHaveLength(0);
  });

  it("does not gate the tools that only report", async () => {
    invokeMock.mockResolvedValue({ perWorker: [] });

    expect((await executeTool("get_metrics", {})).success).toBe(true);
    expect(getPendingToolApprovals()).toHaveLength(0);
  });

  it("denying a stopped turn's calls releases only that worker's calls", async () => {
    const mine = executeTool(
      "read_file",
      { path: "/home/u/a.txt" },
      { originWorker: WORKER, causeSeq: 1 },
    );
    const theirs = executeTool(
      "read_file",
      { path: "/home/u/b.txt" },
      { originWorker: OTHER, causeSeq: 2 },
    );
    await vi.waitFor(() => expect(getPendingToolApprovals()).toHaveLength(2));

    denyPendingToolApprovals(WORKER);

    expect((await mine).success).toBe(false);
    expect(getPendingToolApprovals()).toHaveLength(1);
    expect(getPendingToolApprovals()[0]?.workerId).toBe(OTHER);

    resolveToolApproval(firstPendingId(), "once");
    expect((await theirs).success).toBe(true);
  });
});
