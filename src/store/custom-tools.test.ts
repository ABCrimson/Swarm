// The persisted custom-tool registry: hydration from the Tauri settings
// store must never lose a saved tool the current builder would reject a
// parameter of, because every later save rewrites the whole list.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CustomToolDef } from "#lib/custom-tools";
import { settingsStore } from "#lib/lazy-store";
import { getAllAnthropicTools } from "#lib/tools";
import { customToolsReady, useCustomToolsStore } from "#store/custom-tools";

// Seeded in vi.hoisted: the store module reads the settings store at import.
const { legacy, saved } = vi.hoisted(() => {
  const legacy: CustomToolDef = {
    id: "legacy",
    name: "read_notes",
    description: "Saved before parameter names were validated.",
    params: [
      { id: "p1", name: "file path", type: "string", description: "Free-text name" },
      { id: "p2", name: "limit", type: "number", description: "" },
    ],
    script: "return input.limit;",
  };
  return {
    legacy,
    saved: new Map<string, unknown>([["swarm:tools:custom", structuredClone([legacy])]]),
  };
});

vi.mock("#lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#lib/tauri")>()),
  isTauri: () => true,
}));
vi.mock("#lib/lazy-store", () => ({
  settingsStore: {
    get: vi.fn(async (key: string) => saved.get(key)),
    set: vi.fn(async (key: string, value: unknown) => {
      saved.set(key, structuredClone(value));
    }),
    save: vi.fn(async () => {}),
  },
}));

describe("custom tools store", () => {
  beforeEach(async () => {
    await customToolsReady();
  });

  it("keeps a legacy tool with an invalid parameter name through hydration and later saves", async () => {
    expect(useCustomToolsStore.getState().customTools).toEqual([legacy]);

    const added: CustomToolDef = {
      id: "new",
      name: "ping",
      description: "Pings.",
      params: [],
      script: "return 'pong';",
    };
    useCustomToolsStore.getState().saveTool(added);
    await vi.waitFor(() => expect(settingsStore.save).toHaveBeenCalled());

    expect(saved.get("swarm:tools:custom")).toEqual([legacy, added]);
    const sent = getAllAnthropicTools().find((tool) => tool.name === "read_notes");
    expect(Object.keys(sent?.input_schema.properties ?? {})).toEqual(["limit"]);
  });

  it("saveTool inserts then updates by id; deleteTool removes", async () => {
    useCustomToolsStore.setState({ customTools: [] });
    const tool: CustomToolDef = {
      id: "crud",
      name: "lookup_docs",
      description: "Searches the local docs index.",
      params: [],
      script: "return 1;",
    };
    useCustomToolsStore.getState().saveTool(tool);
    await customToolsReady();
    expect(useCustomToolsStore.getState().customTools).toHaveLength(1);

    useCustomToolsStore.getState().saveTool({ ...tool, description: "Updated." });
    await customToolsReady();
    const tools = useCustomToolsStore.getState().customTools;
    expect(tools).toHaveLength(1);
    expect(tools[0]?.description).toBe("Updated.");

    useCustomToolsStore.getState().deleteTool(tool.id);
    await customToolsReady();
    expect(useCustomToolsStore.getState().customTools).toHaveLength(0);
  });
});
