// Built-in tool descriptions are dual-use: `description` is the
// model-facing tool-schema text (natural sentence case reads better as an
// instruction), `uiDescription` is what the Tools page renders (Title
// Case, the app's UI convention). Both halves of the split must hold for
// every built-in tool, and the API-bound value must never be Title Case.
// Also: run_command's copy never promises output it does not return, and
// get_metrics validates its input and filters to one worker on request.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "#lib/tauri";
import { executeTool, getAnthropicTools, toolRegistry } from "#lib/tools";

vi.mock(import("#lib/tauri"), async (importOriginal) => ({
  ...(await importOriginal()),
  invoke: vi.fn(),
}));

/** A string is "sentence case" here if it starts with a capital letter and is not itself Title Cased (i.e. at least one significant word after the first stays lowercase). */
function looksSentenceCase(text: string): boolean {
  const words = text.split(/\s+/).filter((w) => /[A-Za-z]/.test(w));
  const capitalizedCount = words.filter((w) => /^[A-Z]/.test(w)).length;
  return /^[A-Z]/.test(text) && capitalizedCount < words.length;
}

/** A string is "Title Case" here if every significant word starts with a capital letter. */
function looksTitleCase(text: string): boolean {
  const words = text.split(/\s+/).filter((w) => /^[A-Za-z]/.test(w));
  return words.length > 0 && words.every((w) => /^[A-Z]/.test(w));
}

describe("built-in tool description split", () => {
  it("gives every built-in tool a sentence-case `description` distinct from its Title Case `uiDescription`", () => {
    for (const tool of toolRegistry.values()) {
      expect(tool.description).not.toBe(tool.uiDescription);
      expect(looksSentenceCase(tool.description)).toBe(true);
      expect(looksTitleCase(tool.uiDescription)).toBe(true);
    }
  });

  it("sends the sentence-case description (not the Title Case UI label) to the Anthropic API via getAnthropicTools()", () => {
    const spawnWorker = toolRegistry.get("spawn_worker");
    expect(spawnWorker).toBeDefined();
    expect(spawnWorker?.description).toBe("Spawn a new worker process. Returns the worker ID.");
    expect(spawnWorker?.uiDescription).toBe("Spawn A New Worker Process. Returns The Worker ID.");

    const anthropicTools = getAnthropicTools();
    const spawnWorkerTool = anthropicTools.find((t) => t.name === "spawn_worker");
    expect(spawnWorkerTool?.description).toBe(spawnWorker?.description);
    expect(spawnWorkerTool?.description).not.toBe(spawnWorker?.uiDescription);
  });
});

describe("run_command copy", () => {
  it("never claims to return the command's output", () => {
    const tool = toolRegistry.get("run_command");
    expect(tool?.description).toContain("output is not returned");
    for (const text of [tool?.description, tool?.uiDescription]) {
      expect(text).not.toMatch(/stdout|stderr|returns? (the |its )?output/i);
    }
  });
});

describe("get_metrics", () => {
  const W1 = "11111111-2222-4333-8444-555555555555";
  const W2 = "66666666-7777-4888-8999-aaaaaaaaaaaa";
  const SNAPSHOT = {
    cpuPercent: 12,
    perWorker: [
      { workerId: W1, cpuPercent: 3 },
      { workerId: W2, cpuPercent: 4 },
    ],
  };

  beforeEach(() => {
    vi.mocked(invoke).mockReset().mockResolvedValue(SNAPSHOT);
  });

  it("returns the whole snapshot without a workerId", async () => {
    const result = await executeTool("get_metrics", {});

    expect(result).toEqual({ success: true, data: SNAPSHOT });
    expect(invoke).toHaveBeenCalledExactlyOnceWith("get_metrics");
  });

  it("returns only the named worker alongside the system figures", async () => {
    const result = await executeTool("get_metrics", { workerId: W2 });

    expect(result).toEqual({
      success: true,
      data: { cpuPercent: 12, worker: { workerId: W2, cpuPercent: 4 } },
    });
  });

  it("reports an unknown worker as an error", async () => {
    const unknown = "99999999-8888-4777-8666-555555555555";

    const result = await executeTool("get_metrics", { workerId: unknown });

    expect(result).toEqual({
      success: false,
      error: `No Running Worker Process With ID ${unknown}.`,
    });
  });

  it.each([[{ workerId: "w-1" }], [{ workerId: 7 }], [null]])(
    "rejects malformed input %j without calling the backend",
    async (input) => {
      const result = await executeTool("get_metrics", input);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Invalid Input For get_metrics");
      expect(invoke).not.toHaveBeenCalled();
    },
  );
});
