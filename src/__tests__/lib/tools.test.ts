// ── SWARM Tool description split (Task 8 item 3) ────
//
// Built-in tool descriptions are dual-use: `description` is sent to the
// Anthropic API as the tool-schema description (via `zodToTool`) and reads
// better in natural sentence case, while `uiDescription` is what the Tools
// page (`ToolCard`, via `ToolList`) renders and follows this app's
// Title Case UI convention. This asserts both halves of the split hold for
// every built-in tool, and that the API-bound value never leaks Title Case.

import { describe, expect, it } from "vitest";
import { getAnthropicTools, toolRegistry } from "#lib/tools";

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
