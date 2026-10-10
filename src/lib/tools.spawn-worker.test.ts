// spawn_worker routes through spawnWorkerFromSpec — the same validated,
// store-updating path as every other spawn — and threads the calling
// turn's provenance into it, which is what gives the causality graph its
// "spawn" edges.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock(import("#lib/worker-spawn"), () => ({ spawnWorkerFromSpec: vi.fn() }));

import { executeTool, grantToolCallForSession, resetToolApprovals, toolRegistry } from "#lib/tools";
import { spawnWorkerFromSpec } from "#lib/worker-spawn";

describe("spawn_worker tool", () => {
  beforeEach(() => {
    vi.mocked(spawnWorkerFromSpec).mockReset();
    resetToolApprovals();
    // The approval step has its own tests (tools.approval.test.ts): grant
    // exactly the calls below.
    for (const name of ["Research Agent", "Child", "Agent"]) {
      grantToolCallForSession("spawn_worker", { name }, undefined);
      grantToolCallForSession("spawn_worker", { name }, "w-a");
    }
    grantToolCallForSession("spawn_worker", {});
  });

  it("is registered", () => {
    expect(toolRegistry.has("spawn_worker")).toBe(true);
  });

  it("spawns through spawnWorkerFromSpec with the requested name", async () => {
    vi.mocked(spawnWorkerFromSpec).mockResolvedValueOnce("worker-abc");

    const result = await executeTool("spawn_worker", { name: "Research Agent" });

    expect(spawnWorkerFromSpec).toHaveBeenCalledExactlyOnceWith(
      { name: "Research Agent" },
      undefined,
      undefined,
    );
    expect(result).toEqual({ success: true, data: { id: "worker-abc" } });
  });

  it("threads the turn's provenance into the spawn", async () => {
    vi.mocked(spawnWorkerFromSpec).mockResolvedValueOnce("worker-abc");
    const prov = { originWorker: "w-a", causeSeq: 3 };

    await executeTool("spawn_worker", { name: "Child" }, prov);

    expect(spawnWorkerFromSpec).toHaveBeenCalledExactlyOnceWith({ name: "Child" }, undefined, prov);
  });

  it("defaults the name to Worker when omitted", async () => {
    vi.mocked(spawnWorkerFromSpec).mockResolvedValueOnce("worker-def");

    await executeTool("spawn_worker", {});

    expect(spawnWorkerFromSpec).toHaveBeenCalledWith({ name: "Worker" }, undefined, undefined);
  });

  it("reports a truthful error when there is no desktop backend", async () => {
    vi.mocked(spawnWorkerFromSpec).mockResolvedValueOnce(null);

    expect(await executeTool("spawn_worker", { name: "Agent" })).toEqual({
      success: false,
      error: "Spawn Worker Unavailable Outside The Desktop App.",
    });
  });

  it("surfaces a thrown error's message", async () => {
    vi.mocked(spawnWorkerFromSpec).mockRejectedValueOnce(new Error("Registry Full"));

    expect(await executeTool("spawn_worker", { name: "Agent" })).toEqual({
      success: false,
      error: "Registry Full",
    });
  });

  it("rejects a non-string name without spawning", async () => {
    const result = await executeTool("spawn_worker", { name: 5 });

    expect(result.success).toBe(false);
    expect(spawnWorkerFromSpec).not.toHaveBeenCalled();
  });
});
