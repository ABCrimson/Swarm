// ── read_file / write_file boundary fix (Phase 0) ───
//
// Prior to this fix, both tools invoked Tauri commands ("read_file",
// "write_file") that were never registered on the Rust side — every
// call failed and the try/catch silently reported {success:false} to
// the model. Both tools now execute over #lib/fs's capability-scoped
// absolute-path helpers instead. These tests prove: real content comes
// back for a readable path, write_file round-trips, and a capability
// rejection surfaces as a truthful, actionable error rather than a
// generic failure.

import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toolRegistry } from "#lib/tools";

const readFileTool = toolRegistry.get("read_file");
const writeFileTool = toolRegistry.get("write_file");

beforeEach(() => {
  vi.mocked(readTextFile).mockReset();
  vi.mocked(writeTextFile).mockReset();
});

describe("read_file tool", () => {
  it("is registered", () => {
    expect(readFileTool).toBeDefined();
  });

  it("returns real file content for a readable path", async () => {
    vi.mocked(readTextFile).mockResolvedValueOnce("hello world\nsecond line");

    const result = await readFileTool?.execute({ path: "/home/user/notes.txt" });

    expect(readTextFile).toHaveBeenCalledWith("/home/user/notes.txt");
    expect(result?.success).toBe(true);
    expect(result?.data).toEqual({
      path: "/home/user/notes.txt",
      content: "hello world\nsecond line",
    });
  });

  it("truncates to maxLines when provided", async () => {
    vi.mocked(readTextFile).mockResolvedValueOnce("a\nb\nc\nd\ne");

    const result = await readFileTool?.execute({ path: "/home/user/notes.txt", maxLines: 2 });

    expect(result?.success).toBe(true);
    const data = result?.data as { content: string } | undefined;
    expect(data?.content).toBe("a\nb");
  });

  it("surfaces a truthful, actionable error when the fs capability scope denies the read", async () => {
    // The real shape tauri-plugin-fs's Error::PathForbidden serializes as
    // (verified against the plugin's error.rs: #[error("forbidden path: {0}")]),
    // not a generic "permission"/"denied" placeholder string.
    vi.mocked(readTextFile).mockRejectedValueOnce(new Error("forbidden path: /etc/passwd"));

    const result = await readFileTool?.execute({ path: "/etc/passwd" });

    expect(result?.success).toBe(false);
    expect(result?.error).toContain("Read Access Is Limited To The App Data And Home Directories");
  });

  it("surfaces a not-found error distinctly from a scope rejection", async () => {
    vi.mocked(readTextFile).mockRejectedValueOnce(
      new Error("No such file or directory (os error 2)"),
    );

    const result = await readFileTool?.execute({ path: "/home/user/missing.txt" });

    expect(result?.success).toBe(false);
    expect(result?.error).toContain("File Not Found");
    expect(result?.error).not.toContain("Access Is Limited");
  });

  it("surfaces an OS-level permission error distinctly from a capability-scope rejection", async () => {
    // A real Windows OS error for a path that IS inside the capability
    // scope (e.g. a locked/ACL-protected file under $APPDATA) — must not
    // be misreported as "Access Is Limited To..." (that claim would be
    // false; the sandbox never rejected this path).
    vi.mocked(readTextFile).mockRejectedValueOnce(new Error("Access is denied (os error 5)"));

    const result = await readFileTool?.execute({ path: "/home/user/locked.txt" });

    expect(result?.success).toBe(false);
    expect(result?.error).toContain("The Operating System Denied Access To");
    expect(result?.error).not.toContain("Access Is Limited To");
  });

  it("rejects malformed input truthfully instead of silently failing", async () => {
    const result = await readFileTool?.execute({});

    expect(result?.success).toBe(false);
    expect(result?.error).toBeDefined();
    expect(readTextFile).not.toHaveBeenCalled();
  });

  it("rejects a non-positive maxLines instead of silently reading zero lines", async () => {
    const result = await readFileTool?.execute({ path: "/home/user/notes.txt", maxLines: 0 });

    expect(result?.success).toBe(false);
    expect(readTextFile).not.toHaveBeenCalled();
  });
});

describe("write_file tool", () => {
  it("is registered", () => {
    expect(writeFileTool).toBeDefined();
  });

  it("round-trips content through the fs plugin", async () => {
    vi.mocked(writeTextFile).mockResolvedValueOnce(undefined);

    const result = await writeFileTool?.execute({
      path: "/home/user/.swarm/out.txt",
      content: "payload",
    });

    expect(writeTextFile).toHaveBeenCalledWith("/home/user/.swarm/out.txt", "payload");
    expect(result?.success).toBe(true);
    expect(result?.data).toEqual({ path: "/home/user/.swarm/out.txt", written: true });
  });

  it("surfaces a truthful, actionable error when the fs capability scope denies the write", async () => {
    vi.mocked(writeTextFile).mockRejectedValueOnce(new Error("forbidden path: /etc/passwd"));

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
    expect(writeTextFile).not.toHaveBeenCalled();
  });
});
