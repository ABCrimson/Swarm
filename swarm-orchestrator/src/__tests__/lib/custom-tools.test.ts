import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildWorkerSource,
  type CustomToolDef,
  customToolToAnthropic,
  runCustomTool,
} from "#lib/custom-tools";
import { executeTool, getAllAnthropicTools, toolRegistry } from "#lib/tools";
import { useCustomToolsStore } from "#store/custom-tools";

function makeTool(overrides?: Partial<CustomToolDef>): CustomToolDef {
  return {
    id: crypto.randomUUID(),
    name: "lookup_docs",
    description: "Searches the local docs index.",
    params: [
      { id: "p1", name: "query", type: "string", description: "Search query" },
      { id: "p2", name: "", type: "string", description: "unnamed — must be skipped" },
    ],
    script: "return input.query;",
    ...overrides,
  };
}

/**
 * Worker mock speaking the sandbox protocol: `respond` scripts the reply
 * (or silence, to exercise the timeout path).
 */
class MockSandboxWorker {
  static respond:
    | ((input: unknown) => { ok: boolean; result?: unknown; error?: string } | null)
    | null = null;
  static instances: MockSandboxWorker[] = [];

  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: ErrorEvent) => void) | null = null;
  terminate = vi.fn();

  constructor() {
    MockSandboxWorker.instances.push(this);
  }

  postMessage(input: unknown): void {
    const reply = MockSandboxWorker.respond?.(input);
    if (reply) {
      queueMicrotask(() => this.onmessage?.({ data: reply } as MessageEvent));
    }
  }
}

describe("customToolToAnthropic", () => {
  it("produces the Anthropic tool shape with named params required", () => {
    const tool = customToolToAnthropic(makeTool());
    expect(tool.name).toBe("lookup_docs");
    expect(tool.description).toBe("Searches the local docs index.");
    expect(tool.input_schema).toEqual({
      type: "object",
      properties: { query: { type: "string", description: "Search query" } },
      required: ["query"],
    });
  });

  it("handles a tool with no params", () => {
    const tool = customToolToAnthropic(makeTool({ params: [] }));
    expect(tool.input_schema).toEqual({ type: "object", properties: {}, required: [] });
  });
});

describe("buildWorkerSource", () => {
  it("embeds the script as the body of an async function receiving input", () => {
    const src = buildWorkerSource("return input.x + 1;");
    expect(src).toContain("return input.x + 1;");
    expect(src).toContain("self.onmessage");
    expect(src).toContain("self.postMessage({ ok: true, result })");
    expect(src).toContain("self.postMessage({ ok: false");
  });
});

describe("runCustomTool (sandboxed)", () => {
  beforeEach(() => {
    MockSandboxWorker.instances = [];
    MockSandboxWorker.respond = null;
    vi.stubGlobal("Worker", MockSandboxWorker);
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => "blob:mock"),
      revokeObjectURL: vi.fn(),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("resolves success with the script's return value", async () => {
    MockSandboxWorker.respond = () => ({ ok: true, result: "docs text" });
    const result = await runCustomTool(makeTool(), { query: "q" });
    expect(result).toEqual({ success: true, data: "docs text" });
    expect(MockSandboxWorker.instances[0]?.terminate).toHaveBeenCalled();
  });

  it("resolves failure when the script throws", async () => {
    MockSandboxWorker.respond = () => ({ ok: false, error: "boom" });
    const result = await runCustomTool(makeTool(), {});
    expect(result).toEqual({ success: false, error: "boom" });
  });

  it("terminates and reports a Title-Cased timeout when the script hangs", async () => {
    vi.useFakeTimers();
    MockSandboxWorker.respond = () => null; // never replies
    const pending = runCustomTool(makeTool(), {});
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await pending;
    expect(result.success).toBe(false);
    expect(result.error).toContain("Timed Out After 10s");
    expect(MockSandboxWorker.instances[0]?.terminate).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("reports a startup failure when the worker errors", async () => {
    MockSandboxWorker.respond = null;
    const pending = runCustomTool(makeTool(), {});
    MockSandboxWorker.instances[0]?.onerror?.(new ErrorEvent("error", { message: "bad script" }));
    const result = await pending;
    expect(result).toEqual({ success: false, error: "bad script" });
  });
});

describe("custom tools in the shared registry pipeline", () => {
  beforeEach(() => {
    useCustomToolsStore.setState({ customTools: [], hydrated: true });
  });

  it("getAllAnthropicTools appends persisted custom tools after built-ins", () => {
    useCustomToolsStore.setState({ customTools: [makeTool()] });
    const tools = getAllAnthropicTools();
    expect(tools.length).toBe(toolRegistry.size + 1);
    expect(tools.at(-1)?.name).toBe("lookup_docs");
  });

  it("drops a custom tool whose name collides with a built-in", () => {
    useCustomToolsStore.setState({ customTools: [makeTool({ name: "spawn_worker" })] });
    const tools = getAllAnthropicTools();
    expect(tools.length).toBe(toolRegistry.size);
    expect(tools.filter((t) => t.name === "spawn_worker").length).toBe(1);
  });

  it("executeTool falls back to custom tools for unknown registry names", async () => {
    MockSandboxWorker.respond = () => ({ ok: true, result: 42 });
    vi.stubGlobal("Worker", MockSandboxWorker);
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => "blob:mock"),
      revokeObjectURL: vi.fn(),
    });

    useCustomToolsStore.setState({ customTools: [makeTool()] });
    const result = await executeTool("lookup_docs", { query: "q" });
    expect(result).toEqual({ success: true, data: 42 });

    vi.unstubAllGlobals();
  });

  it("executeTool still reports unknown names when no custom tool matches", async () => {
    const result = await executeTool("does_not_exist", {});
    expect(result).toEqual({ success: false, error: "Unknown Tool: does_not_exist" });
  });

  it("store saveTool inserts then updates by id; deleteTool removes", () => {
    const tool = makeTool();
    useCustomToolsStore.getState().saveTool(tool);
    expect(useCustomToolsStore.getState().customTools).toHaveLength(1);

    useCustomToolsStore.getState().saveTool({ ...tool, description: "Updated." });
    const tools = useCustomToolsStore.getState().customTools;
    expect(tools).toHaveLength(1);
    expect(tools[0].description).toBe("Updated.");

    useCustomToolsStore.getState().deleteTool(tool.id);
    expect(useCustomToolsStore.getState().customTools).toHaveLength(0);
  });
});
