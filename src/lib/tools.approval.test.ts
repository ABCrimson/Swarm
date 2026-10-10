// The five tools that act on the user's machine wait for the user's
// approval before they run: allow once, allow for the session, or deny.
// The gate sits in each tool's own execute, so the registry cannot skip
// it. Invalid input is rejected before any prompt, a denial reaches the
// model as an error result and never touches the backend, stopping a
// turn denies the calls still waiting, and a session grant covers one
// exact call (tool, worker, arguments), never more.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();

vi.mock("#lib/tauri", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
  workerInput: vi.fn().mockResolvedValue(undefined),
  killWorker: vi.fn().mockResolvedValue(undefined),
  isTauri: () => false,
}));
vi.mock("#lib/worker-spawn", () => ({ spawnWorkerFromSpec: vi.fn().mockResolvedValue("w-new") }));

import { killWorker, workerInput } from "#lib/tauri";
import {
  denyPendingToolApprovals,
  executeTool,
  getPendingToolApprovals,
  resetToolApprovals,
  resolveToolApproval,
  toolRegistry,
} from "#lib/tools";
import { spawnWorkerFromSpec } from "#lib/worker-spawn";

const WORKER = "11111111-2222-4333-8444-555555555555";
const OTHER = "66666666-7777-4888-8999-aaaaaaaaaaaa";

const CALLS = [
  ["run_command", { workerId: WORKER, command: "ls" }],
  ["spawn_worker", { name: "Child" }],
  ["write_file", { path: "/home/u/.swarm/x.txt", content: "x" }],
  ["read_file", { path: "/home/u/notes.txt" }],
  ["kill_worker", { workerId: WORKER }],
] as const;

function backendCalls(): number {
  return (
    invokeMock.mock.calls.length +
    vi.mocked(killWorker).mock.calls.length +
    vi.mocked(workerInput).mock.calls.length +
    vi.mocked(spawnWorkerFromSpec).mock.calls.length
  );
}

function firstPendingId(): string {
  return getPendingToolApprovals()[0]?.id ?? "";
}

beforeEach(() => {
  invokeMock.mockReset().mockResolvedValue("file text");
  vi.mocked(killWorker).mockClear();
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

  it("the registry's own execute is gated: a direct call waits and does not act", async () => {
    void toolRegistry.get("read_file")?.execute({ path: "/home/u/a.txt" });
    await vi.waitFor(() => expect(getPendingToolApprovals()).toHaveLength(1));

    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("kill_worker waits for approval when called through the registry", async () => {
    void toolRegistry.get("kill_worker")?.execute({ workerId: WORKER });
    await vi.waitFor(() => expect(getPendingToolApprovals()).toHaveLength(1));

    expect(killWorker).not.toHaveBeenCalled();
    expect(getPendingToolApprovals()[0]).toMatchObject({
      tool: "kill_worker",
      sessionAllowed: true,
    });
  });

  it("allow for session on one path does not approve another path", async () => {
    const a = executeTool("read_file", { path: "/home/u/a.txt" });
    await vi.waitFor(() => expect(getPendingToolApprovals()).toHaveLength(1));
    resolveToolApproval(firstPendingId(), "session");
    expect((await a).success).toBe(true);

    const b = executeTool("read_file", { path: "/home/u/b.txt" });
    await vi.waitFor(() => expect(getPendingToolApprovals()).toHaveLength(1));
    expect(getPendingToolApprovals()[0]?.input).toEqual({ path: "/home/u/b.txt" });
    resolveToolApproval(firstPendingId(), "deny");
    expect((await b).success).toBe(false);
  });

  it("allow for session for worker W does not approve the same call from OTHER", async () => {
    const input = { path: "/home/u/a.txt" };
    const mine = executeTool("read_file", input, { originWorker: WORKER, causeSeq: 1 });
    await vi.waitFor(() => expect(getPendingToolApprovals()).toHaveLength(1));
    resolveToolApproval(firstPendingId(), "session");
    await mine;

    const theirs = executeTool("read_file", input, { originWorker: OTHER, causeSeq: 2 });
    await vi.waitFor(() => expect(getPendingToolApprovals()).toHaveLength(1));
    resolveToolApproval(firstPendingId(), "deny");
    expect((await theirs).success).toBe(false);
  });

  it("an identical later call is auto-approved after allow for session", async () => {
    const prov = { originWorker: WORKER, causeSeq: 1 };
    const first = executeTool("run_command", { workerId: WORKER, command: "ls" }, prov);
    await vi.waitFor(() => expect(getPendingToolApprovals()).toHaveLength(1));
    resolveToolApproval(firstPendingId(), "session");
    await first;

    const again = await executeTool("run_command", { workerId: WORKER, command: "ls" }, prov);

    expect(again.success).toBe(true);
    expect(getPendingToolApprovals()).toHaveLength(0);
    // The same command typed into another worker's terminal is a different decision.
    void executeTool("run_command", { workerId: OTHER, command: "ls" }, prov);
    await vi.waitFor(() => expect(getPendingToolApprovals()).toHaveLength(1));
  });

  it("allow for session answers only its own call: other pending calls stay pending", async () => {
    const a = executeTool("read_file", { path: "/home/u/a.txt" });
    const b = executeTool("read_file", { path: "/home/u/b.txt" });
    const other = executeTool("write_file", { path: "/home/u/.swarm/x", content: "x" });
    await vi.waitFor(() => expect(getPendingToolApprovals()).toHaveLength(3));

    resolveToolApproval(firstPendingId(), "session");

    expect((await a).success).toBe(true);
    expect(getPendingToolApprovals().map((request) => request.tool)).toEqual([
      "read_file",
      "write_file",
    ]);
    resolveToolApproval(firstPendingId(), "deny");
    resolveToolApproval(firstPendingId(), "deny");
    expect((await b).success).toBe(false);
    expect((await other).success).toBe(false);
  });

  it("write_file offers no session grant and a session answer does not grant", async () => {
    const input = { path: "/home/u/.swarm/x.txt", content: "x" };
    const first = executeTool("write_file", input);
    await vi.waitFor(() => expect(getPendingToolApprovals()).toHaveLength(1));
    expect(getPendingToolApprovals()[0]).toMatchObject({ sessionAllowed: false });

    resolveToolApproval(firstPendingId(), "session");
    expect((await first).success).toBe(true);

    void executeTool("write_file", input);
    await vi.waitFor(() => expect(getPendingToolApprovals()).toHaveLength(1));
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
