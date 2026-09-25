import { open, save } from "@tauri-apps/plugin-dialog";
import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  exportAsJSON,
  exportAsMarkdown,
  exportMetricsCSV,
  parseSessionExport,
  readFromFile,
  saveToFile,
  sessionFileSlug,
} from "#lib/export";
import { type ChatMessage, useMessageHistoryStore } from "#store/message-history";
import type { MetricPoint, Session } from "#store/types";
import { useWorkerStore } from "#store/workers";

const SESSION_ID = "0b6f7a52-5c3e-4d1a-9f0e-2a8b3c4d5e6f";
const WORKER_ID = "11111111-2222-4333-8444-555555555555";

function createSession(overrides?: Partial<Session>): Session {
  return {
    id: SESSION_ID,
    name: "test-session",
    workerIds: [],
    createdAt: "2026-01-15T10:30:00.000Z",
    updatedAt: "2026-01-15T12:00:00.000Z",
    ...overrides,
  };
}

function addWorker(name = "worker-alpha"): void {
  useWorkerStore.getState().addWorker({
    id: WORKER_ID,
    state: "running",
    name,
    startedAt: "2026-01-15T10:30:00.000Z",
  });
}

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: crypto.randomUUID(),
    role: "user",
    content: "Hello",
    timestamp: "2026-01-15T10:31:02.000Z",
    ...overrides,
  };
}

/** Appends display messages to the worker's chat thread. */
function addMessages(...messages: ChatMessage[]): void {
  useMessageHistoryStore.getState().updateThread(WORKER_ID, (thread) => ({
    ...thread,
    messages: [...thread.messages, ...messages],
  }));
}

function resetStores(): void {
  const workerState = useWorkerStore.getState();
  for (const [id] of workerState.workers) {
    workerState.removeWorker(id);
  }
  useMessageHistoryStore.getState().clearAll();
}

beforeEach(resetStores);
afterEach(resetStores);

describe("exportAsMarkdown", () => {
  it("includes the session name as a heading", () => {
    expect(exportAsMarkdown(createSession({ name: "My Session" }))).toContain(
      "# Session: My Session",
    );
  });

  it("includes session ID and timestamps", () => {
    const md = exportAsMarkdown(createSession());

    expect(md).toContain(SESSION_ID);
    expect(md).toContain("**Created:**");
    expect(md).toContain("**Updated:**");
  });

  it("includes worker count", () => {
    expect(
      exportAsMarkdown(createSession({ workerIds: [WORKER_ID, crypto.randomUUID()] })),
    ).toContain("**Workers:** 2");
  });

  it("includes metadata description and tags when present", () => {
    const md = exportAsMarkdown(
      createSession({ metadata: { description: "A test description", tags: ["alpha", "beta"] } }),
    );

    expect(md).toContain("**Description:** A test description");
    expect(md).toContain("**Tags:** alpha, beta");
  });

  it("includes configuration block when present", () => {
    const md = exportAsMarkdown(createSession({ config: { maxWorkers: 5 } }));

    expect(md).toContain("## Configuration");
    expect(md).toContain('"maxWorkers": 5');
  });

  it("renders worker details when workers exist in the store", () => {
    addWorker();
    const md = exportAsMarkdown(createSession({ workerIds: [WORKER_ID] }));

    expect(md).toContain("### worker-alpha");
    expect(md).toContain("**State:** running");
  });

  it("renders each worker's transcript, tool calls and results included", () => {
    addWorker();
    addMessages(
      message({ content: "List the files" }),
      message({
        role: "assistant",
        content: "Listing now.",
        toolCalls: [{ id: "tc-1", name: "list_dir", input: { path: "." }, result: "a.ts\nb.ts" }],
      }),
    );

    const md = exportAsMarkdown(createSession({ workerIds: [WORKER_ID] }));

    expect(md).toContain("#### Messages");
    expect(md).toMatch(/\*\*\[\d{2}:\d{2}:\d{2}\] User:\*\*\n\nList the files/);
    expect(md).toContain("Assistant:**");
    expect(md).toContain('- `list_dir`: {"path":"."}');
    expect(md).toContain("  Result: a.ts\nb.ts");
  });

  it("handles workers not found in the store gracefully", () => {
    const md = exportAsMarkdown(createSession({ workerIds: [WORKER_ID] }));

    expect(md).toContain("### Worker 11111111");
    expect(md).toContain("*Worker Data Not Available*");
  });
});

describe("exportAsJSON", () => {
  it("returns valid JSON with session, workers and exportedAt keys", () => {
    const parsed = JSON.parse(exportAsJSON(createSession({ name: "export-test" })));

    expect(parsed.session).toMatchObject({ id: SESSION_ID, name: "export-test" });
    expect(parsed.workers).toEqual({});
    expect(Number.isNaN(Date.parse(parsed.exportedAt))).toBe(false);
  });

  it("includes each worker's store record and its messages", () => {
    addWorker("w1");
    const hello = message();
    addMessages(hello);

    const parsed = JSON.parse(exportAsJSON(createSession({ workerIds: [WORKER_ID] })));

    expect(parsed.workers[WORKER_ID].worker.name).toBe("w1");
    expect(parsed.workers[WORKER_ID].messages).toEqual([hello]);
  });

  it("sets worker to null when not found in the store", () => {
    const parsed = JSON.parse(exportAsJSON(createSession({ workerIds: [WORKER_ID] })));

    expect(parsed.workers[WORKER_ID]).toEqual({ worker: null, messages: [] });
  });
});

describe("parseSessionExport", () => {
  it("round-trips exportAsJSON's wrapper format", () => {
    const session = createSession({ metadata: { tags: ["x"] } });
    expect(parseSessionExport(exportAsJSON(session))).toEqual(session);
  });

  it("still accepts a bare Session object (the old context-menu export shape)", () => {
    const session = createSession();
    expect(parseSessionExport(JSON.stringify(session))).toEqual(session);
  });

  it("returns null for text that is not JSON", () => {
    expect(parseSessionExport("{ nope")).toBeNull();
  });

  it("returns null for JSON that matches neither shape", () => {
    expect(parseSessionExport(JSON.stringify({ session: { name: 1 } }))).toBeNull();
    expect(parseSessionExport(JSON.stringify([1, 2, 3]))).toBeNull();
  });
});

describe("exportMetricsCSV", () => {
  it("produces CSV with only the header row for no points", () => {
    expect(exportMetricsCSV([])).toBe("time,cpu,memory,workerCount");
  });

  it("produces one row per data point", () => {
    const metrics: MetricPoint[] = [
      { time: 1000, cpu: 50, memory: 60, workerCount: 3 },
      { time: 2000, cpu: 70, memory: 80, workerCount: 5 },
    ];

    expect(exportMetricsCSV(metrics).split("\n")).toEqual([
      "time,cpu,memory,workerCount",
      "1000,50,60,3",
      "2000,70,80,5",
    ]);
  });
});

describe("sessionFileSlug", () => {
  it("lowercases and joins words with dashes", () => {
    expect(sessionFileSlug("  My Big   Session ")).toBe("my-big-session");
  });

  it("strips characters no desktop OS accepts in a filename", () => {
    expect(sessionFileSlug('a<b>c:d"e/f\\g|h?i*j\u0007k')).toBe("abcdefghijk");
  });

  it("trims leading and trailing dots and dashes", () => {
    expect(sessionFileSlug("..Release.")).toBe("release");
    expect(sessionFileSlug("- draft -")).toBe("draft");
  });

  it("falls back when nothing printable is left", () => {
    expect(sessionFileSlug("???")).toBe("session");
  });

  it("never yields a bare Windows device name", () => {
    expect(sessionFileSlug("CON")).toBe("session-con");
    expect(sessionFileSlug("com1")).toBe("session-com1");
    expect(sessionFileSlug("console")).toBe("console");
  });
});

describe("saveToFile / readFromFile", () => {
  it("writes straight to the dialog-chosen absolute path — no .tmp sibling outside the dialog grant", async () => {
    vi.mocked(save).mockResolvedValueOnce("D:\\Exports\\session.json");

    await expect(saveToFile("{}", "session.json", "JSON", "json")).resolves.toBe(
      "D:\\Exports\\session.json",
    );

    expect(save).toHaveBeenCalledWith({
      title: "Export As JSON",
      defaultPath: "session.json",
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    expect(writeTextFile).toHaveBeenCalledExactlyOnceWith("D:\\Exports\\session.json", "{}");
  });

  it("writes nothing when the save dialog is cancelled", async () => {
    vi.mocked(save).mockResolvedValueOnce(null);
    vi.mocked(writeTextFile).mockClear();

    await expect(saveToFile("{}", "session.json", "JSON", "json")).resolves.toBeNull();
    expect(writeTextFile).not.toHaveBeenCalled();
  });

  it("reads the one file the open dialog returns", async () => {
    vi.mocked(open).mockResolvedValueOnce("/home/me/session.json");
    vi.mocked(readTextFile).mockResolvedValueOnce('{"ok":true}');

    await expect(readFromFile("Import Session", "JSON", "json")).resolves.toBe('{"ok":true}');
    expect(readTextFile).toHaveBeenCalledWith("/home/me/session.json");
  });

  it("reads nothing when the open dialog is cancelled", async () => {
    vi.mocked(open).mockResolvedValueOnce(null);
    vi.mocked(readTextFile).mockClear();

    await expect(readFromFile("Import Session", "JSON", "json")).resolves.toBeNull();
    expect(readTextFile).not.toHaveBeenCalled();
  });
});
