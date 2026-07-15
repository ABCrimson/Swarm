import { describe, expect, it } from "vitest";
import { commandMatchScore, rankCommands } from "#lib/command-ranking";

const COMMANDS = [
  { id: "nav:dashboard", label: "Go To Dashboard", keywords: ["navigate", "home"] },
  { id: "nav:tools", label: "Go To Tools", keywords: ["navigate", "custom", "builder"] },
  { id: "nav:workers", label: "Go To Workers", keywords: ["navigate", "agents"] },
  { id: "ui:toggle-sidebar", label: "Toggle Sidebar", keywords: ["panel", "collapse"] },
] as const;

/** Frecency stub: Dashboard is by far the most-used command. */
const frecency = (id: string): number => (id === "nav:dashboard" ? 1000 : 0);

describe("commandMatchScore", () => {
  it("returns a neutral positive score for an empty query", () => {
    expect(commandMatchScore(COMMANDS[0], "")).toBe(1);
    expect(commandMatchScore(COMMANDS[0], "   ")).toBe(1);
  });

  it("returns 0 when a token matches nothing", () => {
    expect(commandMatchScore(COMMANDS[1], "xyzzy")).toBe(0);
  });

  it("requires every token to match (AND semantics)", () => {
    expect(commandMatchScore(COMMANDS[1], "go tools")).toBeGreaterThan(0);
    expect(commandMatchScore(COMMANDS[1], "go xyzzy")).toBe(0);
  });

  it("scores label word-starts above keyword matches", () => {
    const labelHit = commandMatchScore(COMMANDS[1], "tools");
    const keywordHit = commandMatchScore(COMMANDS[1], "builder");
    expect(labelHit).toBeGreaterThan(keywordHit);
  });
});

describe("rankCommands", () => {
  it("keeps pure frecency order for an empty query", () => {
    const ranked = rankCommands(COMMANDS, "", frecency);
    expect(ranked).toHaveLength(COMMANDS.length);
    expect(ranked[0].id).toBe("nav:dashboard");
  });

  it("puts the relevant match first even against a frecency giant (the 'tools' bug)", () => {
    const ranked = rankCommands(COMMANDS, "tools", frecency);
    expect(ranked[0].id).toBe("nav:tools");
    // Dashboard doesn't match "tools" at all — it must be filtered out,
    // not merely demoted.
    expect(ranked.some((c) => c.id === "nav:dashboard")).toBe(false);
  });

  it("filters non-matches and keeps matches ordered by relevance", () => {
    const ranked = rankCommands(COMMANDS, "go", frecency);
    expect(ranked.map((c) => c.id)).toEqual(
      expect.arrayContaining(["nav:dashboard", "nav:tools", "nav:workers"]),
    );
    expect(ranked.some((c) => c.id === "ui:toggle-sidebar")).toBe(false);
  });

  it("breaks relevance ties by frecency", () => {
    const ranked = rankCommands(COMMANDS, "go to", frecency);
    // All three "Go To ..." commands tie on relevance; Dashboard's
    // frecency puts it first.
    expect(ranked[0].id).toBe("nav:dashboard");
  });
});
