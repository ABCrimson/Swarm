// Built-in tool descriptions are dual-use: `description` is the
// model-facing tool-schema text (natural sentence case reads better as an
// instruction), `uiDescription` is what the Tools page renders (Title
// Case, the app's UI convention). Both halves of the split must hold for
// every built-in tool, and the API-bound value must never be Title Case.

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
