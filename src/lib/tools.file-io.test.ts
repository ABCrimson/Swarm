// read_file / write_file run through the real Rust commands in
// commands/fs.rs. write_file's side effect — a stamped, persisted
// file_written event — is what lets file writes join the causality
// graph, so it carries the turn's provenance; read_file never does. The
// scope-denial wording asserted below is exactly what FsScopes returns.

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getPendingToolApprovals,
  resetToolApprovals,
  resolveToolApproval,
  subscribeToolApprovals,
  toolRegistry,
} from "#lib/tools";

const invokeMock = vi.fn();

vi.mock("#lib/tauri", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
  // #lib/tools transitively imports the custom-tools store, which calls
  // isTauri() at module load time — must be present on this mock even
  // though these tests never exercise the custom-tool path.
  isTauri: () => false,
}));

const readFileTool = toolRegistry.get("read_file");
const writeFileTool = toolRegistry.get("write_file");

beforeEach(() => {
  invokeMock.mockReset();
  // The approval step has its own tests (tools.approval.test.ts): answer
  // every prompt with "once" so these tests exercise the file commands.
  const unsubscribe = subscribeToolApprovals(() => {
    for (const request of getPendingToolApprovals()) resolveToolApproval(request.id, "once");
  });
  return () => {
    unsubscribe();
    resetToolApprovals();
  };
});

describe("read_file tool", () => {
  it("is registered", () => {
    expect(readFileTool).toBeDefined();
  });

  it("returns real file content for a readable path", async () => {
    invokeMock.mockResolvedValueOnce("hello world\nsecond line");

    const result = await readFileTool?.execute({ path: "/home/user/notes.txt" });

    expect(invokeMock).toHaveBeenCalledWith("read_file", { path: "/home/user/notes.txt" });
    expect(result?.success).toBe(true);
    expect(result?.data).toEqual({
      path: "/home/user/notes.txt",
      content: "hello world\nsecond line",
    });
  });

  it("truncates to maxLines when provided", async () => {
    invokeMock.mockResolvedValueOnce("a\nb\nc\nd\ne");

    const result = await readFileTool?.execute({ path: "/home/user/notes.txt", maxLines: 2 });

    expect(result?.success).toBe(true);
    const data = result?.data as { content: string } | undefined;
    expect(data?.content).toBe("a\nb");
  });

  it("surfaces a truthful, actionable error when the fs scope denies the read", async () => {
    // Exactly the wording commands/fs.rs's FsScopes::check_read returns
    // for a path outside $APPDATA/**, $HOME/** — matching the wording
    // the plugin-fs path already used, so the user-facing message is
    // stable across the migration.
    invokeMock.mockRejectedValueOnce(
      "Read Access Is Limited To The App Data And Home Directories.",
    );

    const result = await readFileTool?.execute({ path: "/etc/passwd" });

    expect(result?.success).toBe(false);
    expect(result?.error).toContain("Read Access Is Limited To The App Data And Home Directories");
  });

  it("surfaces a not-found error distinctly from a scope rejection", async () => {
    invokeMock.mockRejectedValueOnce('File Not Found: "/home/user/missing.txt".');

    const result = await readFileTool?.execute({ path: "/home/user/missing.txt" });

    expect(result?.success).toBe(false);
    expect(result?.error).toContain("File Not Found");
    expect(result?.error).not.toContain("Access Is Limited");
  });

  it("surfaces an OS-level permission error distinctly from a scope rejection", async () => {
    invokeMock.mockRejectedValueOnce(
      'The Operating System Denied Access To "/home/user/locked.txt".',
    );

    const result = await readFileTool?.execute({ path: "/home/user/locked.txt" });

    expect(result?.success).toBe(false);
    expect(result?.error).toContain("The Operating System Denied Access To");
    expect(result?.error).not.toContain("Access Is Limited To");
  });

  it("rejects malformed input truthfully instead of silently failing", async () => {
    const result = await readFileTool?.execute({});

    expect(result?.success).toBe(false);
    expect(result?.error).toBeDefined();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("rejects a non-positive maxLines instead of silently reading zero lines", async () => {
    const result = await readFileTool?.execute({ path: "/home/user/notes.txt", maxLines: 0 });

    expect(result?.success).toBe(false);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("never forwards originWorker/causeSeq — reads are not a stamped side effect", async () => {
    invokeMock.mockResolvedValueOnce("content");

    await readFileTool?.execute(
      { path: "/home/user/notes.txt" },
      { originWorker: "w-1", causeSeq: 5 },
    );

    expect(invokeMock).toHaveBeenCalledWith("read_file", { path: "/home/user/notes.txt" });
  });
});

describe("write_file tool", () => {
  it("is registered", () => {
    expect(writeFileTool).toBeDefined();
  });

  it("round-trips content through the real write_file command", async () => {
    invokeMock.mockResolvedValueOnce(undefined);

    const result = await writeFileTool?.execute({
      path: "/home/user/.swarm/out.txt",
      content: "payload",
    });

    expect(invokeMock).toHaveBeenCalledWith("write_file", {
      path: "/home/user/.swarm/out.txt",
      content: "payload",
      originWorker: undefined,
      causeSeq: undefined,
    });
    expect(result?.success).toBe(true);
    expect(result?.data).toEqual({ path: "/home/user/.swarm/out.txt", written: true });
  });

  it("forwards originWorker/causeSeq when the call happens inside an AI turn", async () => {
    invokeMock.mockResolvedValueOnce(undefined);

    await writeFileTool?.execute(
      { path: "/home/user/.swarm/out.txt", content: "payload" },
      { originWorker: "w-caller", causeSeq: 41 },
    );

    expect(invokeMock).toHaveBeenCalledWith("write_file", {
      path: "/home/user/.swarm/out.txt",
      content: "payload",
      originWorker: "w-caller",
      causeSeq: 41,
    });
  });

  it("surfaces a truthful, actionable error when the fs scope denies the write", async () => {
    invokeMock.mockRejectedValueOnce(
      "Write Access Is Limited To The App Data And .swarm Directories.",
    );

    const result = await writeFileTool?.execute({ path: "/etc/passwd", content: "x" });

    expect(result?.success).toBe(false);
    expect(result?.error).toContain(
      "Write Access Is Limited To The App Data And .swarm Directories",
    );
  });

  it("rejects malformed input truthfully instead of silently failing", async () => {
    const result = await writeFileTool?.execute({ path: "/home/user/out.txt" });

    expect(result?.success).toBe(false);
    expect(result?.error).toBeDefined();
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
