// ── spawn_worker AI tool routing (fix wave) ──────────
//
// The spawn_worker tool used to hand-roll invoke("spawn_worker", ...)
// with an unvalidated `as string` cast, bypassing both the Zod
// validation and the store bookkeeping that every other spawn path
// gets via spawnWorkerFromSpec. This proves it's routed through
// spawnWorkerFromSpec instead, and degrades truthfully (not a crash)
// when that returns null (no Tauri IPC bridge).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toolRegistry } from "#lib/tools";

const spawnWorkerFromSpecMock = vi.fn();

vi.mock("#lib/worker-spawn", () => ({
  spawnWorkerFromSpec: (...args: unknown[]) => spawnWorkerFromSpecMock(...args),
}));

const spawnWorkerTool = toolRegistry.get("spawn_worker");

describe("spawn_worker tool", () => {
  beforeEach(() => {
    spawnWorkerFromSpecMock.mockReset();
  });
  afterEach(() => {
    spawnWorkerFromSpecMock.mockReset();
  });

  it("is registered", () => {
    expect(spawnWorkerTool).toBeDefined();
  });

  it("routes through spawnWorkerFromSpec instead of a hand-rolled invoke() call", async () => {
    spawnWorkerFromSpecMock.mockResolvedValueOnce("worker-abc");

    const result = await spawnWorkerTool?.execute({ name: "Research Agent" });

    expect(spawnWorkerFromSpecMock).toHaveBeenCalledWith({ name: "Research Agent" });
    expect(result?.success).toBe(true);
    expect(result?.data).toEqual({ id: "worker-abc" });
  });

  it("defaults the name to Worker when omitted", async () => {
    spawnWorkerFromSpecMock.mockResolvedValueOnce("worker-def");

    await spawnWorkerTool?.execute({});

    expect(spawnWorkerFromSpecMock).toHaveBeenCalledWith({ name: "Worker" });
  });

  it("reports a truthful error instead of crashing when there is no Tauri IPC bridge", async () => {
    spawnWorkerFromSpecMock.mockResolvedValueOnce(null);

    const result = await spawnWorkerTool?.execute({ name: "Agent" });

    expect(result?.success).toBe(false);
    expect(result?.error).toBeDefined();
  });

  it("surfaces a thrown error truthfully", async () => {
    spawnWorkerFromSpecMock.mockRejectedValueOnce(new Error("Registry Full"));

    const result = await spawnWorkerTool?.execute({ name: "Agent" });

    expect(result?.success).toBe(false);
    expect(result?.error).toContain("Registry Full");
  });
});
