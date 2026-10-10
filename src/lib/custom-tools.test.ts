import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildWorkerSource,
  type CustomToolDef,
  customToolInputSchema,
  customToolIssues,
  customToolToAnthropic,
  hasNoIssues,
  isValidParamName,
  isValidToolName,
  parsePersistedCustomTools,
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

/** Replaces Worker and the Blob-URL statics, keeping `URL` a real constructible class. */
function stubSandbox(): void {
  MockSandboxWorker.instances = [];
  MockSandboxWorker.respond = null;
  vi.stubGlobal("Worker", MockSandboxWorker);
  vi.stubGlobal(
    "URL",
    Object.assign(class extends URL {}, {
      createObjectURL: vi.fn(() => "blob:mock"),
      revokeObjectURL: vi.fn(),
    }),
  );
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

  it("never sends an API-invalid or duplicate parameter name", () => {
    const tool = customToolToAnthropic(
      makeTool({
        params: [
          { id: "a", name: "file path", type: "string", description: "space" },
          { id: "b", name: "path", type: "string", description: "first" },
          { id: "c", name: "path", type: "number", description: "duplicate" },
        ],
      }),
    );
    expect(tool.input_schema).toEqual({
      type: "object",
      properties: { path: { type: "string", description: "first" } },
      required: ["path"],
    });
  });

  it("keeps a __proto__ parameter as an own, serialized property", () => {
    const tool = customToolToAnthropic(
      makeTool({ params: [{ id: "a", name: "__proto__", type: "string", description: "x" }] }),
    );
    expect(JSON.stringify(tool.input_schema)).toBe(
      '{"type":"object","properties":{"__proto__":{"type":"string","description":"x"}},"required":["__proto__"]}',
    );
  });
});

describe("naming rules", () => {
  it("accepts API-conforming tool names and rejects spaces/empty/overlong", () => {
    expect(isValidToolName("lookup_docs")).toBe(true);
    expect(isValidToolName("Tool-2")).toBe(true);
    expect(isValidToolName("Search Docs")).toBe(false);
    expect(isValidToolName("")).toBe(false);
    expect(isValidToolName("a".repeat(65))).toBe(false);
  });

  it("accepts API-conforming parameter names, dots included", () => {
    expect(isValidParamName("file.path")).toBe(true);
    expect(isValidParamName("file path")).toBe(false);
    expect(isValidParamName("ünïcode")).toBe(false);
    expect(isValidParamName("")).toBe(false);
  });

  it("reports invalid names, taken names and duplicate parameters per field", () => {
    const issues = customToolIssues(
      {
        name: "spawn_worker",
        params: [
          { id: "a", name: "bad name", type: "string", description: "" },
          { id: "b", name: "q", type: "string", description: "" },
          { id: "c", name: "q", type: "string", description: "" },
          { id: "d", name: "", type: "string", description: "" },
        ],
      },
      new Set(["spawn_worker"]),
    );
    expect(issues.name).toBe("Name Already In Use By Another Tool.");
    expect([...issues.params.keys()]).toEqual(["a", "b", "c"]);
    expect(issues.params.get("b")).toBe("Duplicate Parameter Name.");
    expect(hasNoIssues(issues)).toBe(false);
    expect(hasNoIssues(customToolIssues(makeTool(), new Set()))).toBe(true);
  });

  it("parsePersistedCustomTools drops only the invalid entries", () => {
    const good = makeTool();
    const badName = makeTool({ name: "Search Docs" });
    const corrupt = { id: "x", name: "ok_tool" };
    const tools = parsePersistedCustomTools([good, badName, corrupt, "junk"]);
    expect(tools.map((tool) => tool.id)).toEqual([good.id]);
  });

  it("parsePersistedCustomTools keeps a legacy tool with a free-text parameter name", () => {
    const legacy = makeTool({
      params: [
        { id: "x", name: "file path", type: "string", description: "" },
        { id: "y", name: "query", type: "string", description: "" },
      ],
    });
    expect(parsePersistedCustomTools([legacy])).toEqual([legacy]);
    // The API never sees the invalid name.
    expect(Object.keys(customToolToAnthropic(legacy).input_schema.properties ?? {})).toEqual([
      "query",
    ]);
  });

  it("parsePersistedCustomTools returns [] for non-array input", () => {
    expect(parsePersistedCustomTools(undefined)).toEqual([]);
    expect(parsePersistedCustomTools({ not: "an array" })).toEqual([]);
  });
});

describe("customToolInputSchema", () => {
  it("requires every sent parameter with its declared JSON type", () => {
    const schema = customToolInputSchema(
      makeTool({
        params: [
          { id: "a", name: "query", type: "string", description: "" },
          { id: "b", name: "limit", type: "number", description: "" },
        ],
      }),
    );
    expect(schema.safeParse({ query: "x", limit: 3 }).success).toBe(true);
    expect(schema.safeParse({ query: "x" }).success).toBe(false);
    expect(schema.safeParse({ query: "x", limit: "3" }).success).toBe(false);
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

  /** Evaluates the generated source against a fake worker global and delivers one message. */
  async function runWorkerSource(script: string, data: unknown): Promise<unknown[]> {
    const posted: unknown[] = [];
    const fakeSelf: { onmessage?: (e: { data: unknown }) => Promise<void> } = {};
    Object.assign(fakeSelf, { postMessage: (message: unknown) => posted.push(message) });
    new Function("self", buildWorkerSource(script))(fakeSelf);
    await fakeSelf.onmessage?.({ data });
    return posted;
  }

  it("posts the awaited return value of the script, called with the message data", async () => {
    expect(await runWorkerSource("await null; return input.x + 1;", { x: 1 })).toEqual([
      { ok: true, result: 2 },
    ]);
  });

  it("posts the thrown error's message when the script throws", async () => {
    expect(await runWorkerSource('throw new Error("boom");', {})).toEqual([
      { ok: false, error: "boom" },
    ]);
  });
});

describe("runCustomTool (sandboxed)", () => {
  beforeEach(stubSandbox);

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
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
    MockSandboxWorker.respond = () => null;
    const pending = runCustomTool(makeTool(), {});
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await pending;
    expect(result.success).toBe(false);
    expect(result.error).toContain("Timed Out After 10s");
    expect(MockSandboxWorker.instances[0]?.terminate).toHaveBeenCalled();
  });

  it("reports a startup failure when the worker errors", async () => {
    const pending = runCustomTool(makeTool(), {});
    MockSandboxWorker.instances[0]?.onerror?.(new ErrorEvent("error", { message: "bad script" }));
    const result = await pending;
    expect(result).toEqual({ success: false, error: "bad script" });
  });
});

describe("custom tools in the shared registry pipeline", () => {
  beforeEach(() => {
    stubSandbox();
    useCustomToolsStore.setState({ customTools: [] });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
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
    expect(tools.filter((t) => t.name === "spawn_worker")).toHaveLength(1);
  });

  it("drops custom tools with API-invalid names and dedupes duplicate custom names", () => {
    useCustomToolsStore.setState({
      customTools: [
        makeTool({ name: "Search Docs" }),
        makeTool({ name: "dup_tool", description: "First." }),
        makeTool({ name: "dup_tool", description: "Second." }),
      ],
    });
    const tools = getAllAnthropicTools();
    expect(tools.length).toBe(toolRegistry.size + 1);
    const dups = tools.filter((t) => t.name === "dup_tool");
    expect(dups).toHaveLength(1);
    expect(dups[0]?.description).toBe("First.");
    expect(tools.some((t) => t.name === "Search Docs")).toBe(false);
  });

  it("executeTool runs a custom tool with validated input", async () => {
    MockSandboxWorker.respond = () => ({ ok: true, result: 42 });
    useCustomToolsStore.setState({ customTools: [makeTool()] });

    expect(await executeTool("lookup_docs", { query: "q" })).toEqual({ success: true, data: 42 });
  });

  it("executeTool rejects custom-tool input that violates its parameters without running the script", async () => {
    useCustomToolsStore.setState({ customTools: [makeTool()] });

    const result = await executeTool("lookup_docs", { query: 7 });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid Input For lookup_docs");
    expect(MockSandboxWorker.instances).toHaveLength(0);
  });

  it("executeTool runs only one of two same-named custom tools", async () => {
    useCustomToolsStore.setState({
      customTools: [
        makeTool({ name: "dup_tool", script: "return 1;" }),
        makeTool({ name: "dup_tool", script: "return 2;" }),
      ],
    });
    MockSandboxWorker.respond = () => ({ ok: true, result: "first" });

    await executeTool("dup_tool", { query: "q" });

    expect(MockSandboxWorker.instances).toHaveLength(1);
    // The mock ignores the script, so read the Worker source to prove the first definition ran.
    const createObjectURL = vi.mocked(URL.createObjectURL);
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    const blob = createObjectURL.mock.lastCall?.[0];
    expect(blob).toBeInstanceOf(Blob);
    const source = await (blob as Blob).text();
    expect(source).toContain("return 1;");
    expect(source).not.toContain("return 2;");
  });

  it("executeTool still reports unknown names when no custom tool matches", async () => {
    expect(await executeTool("does_not_exist", {})).toEqual({
      success: false,
      error: "Unknown Tool: does_not_exist",
    });
  });
});
