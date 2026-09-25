import { readTextFile, stat } from "@tauri-apps/plugin-fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  basename,
  childPath,
  formatBytes,
  loadFilePreview,
  MAX_PREVIEW_BYTES,
} from "#lib/file-preview";

vi.mock("@tauri-apps/plugin-fs", () => ({ readTextFile: vi.fn(), stat: vi.fn() }));

const statOk = (size: number) =>
  vi.mocked(stat).mockResolvedValue({ size } as Awaited<ReturnType<typeof stat>>);

beforeEach(() => {
  vi.mocked(stat).mockReset();
  vi.mocked(readTextFile).mockReset();
});

describe("loadFilePreview", () => {
  it("returns the text of an ordinary file", async () => {
    statOk(12);
    vi.mocked(readTextFile).mockResolvedValue("hello world\n");

    await expect(loadFilePreview("/p/a.txt")).resolves.toEqual({
      kind: "text",
      text: "hello world\n",
    });
  });

  it("refuses an oversized file before reading it", async () => {
    statOk(MAX_PREVIEW_BYTES + 1);

    await expect(loadFilePreview("/p/big.log")).resolves.toEqual({
      kind: "too-large",
      bytes: MAX_PREVIEW_BYTES + 1,
    });
    expect(readTextFile).not.toHaveBeenCalled();
  });

  // The desktop capability grants read_text_file but not stat.
  it("still refuses an oversized file when stat is not permitted", async () => {
    vi.mocked(stat).mockRejectedValue("fs.stat not allowed");
    vi.mocked(readTextFile).mockResolvedValue("x".repeat(MAX_PREVIEW_BYTES + 5));

    await expect(loadFilePreview("/p/big.log")).resolves.toMatchObject({ kind: "too-large" });
  });

  it("detects a binary file by a NUL byte near the start", async () => {
    statOk(64);
    vi.mocked(readTextFile).mockResolvedValue("PNG\0\u0001\u0002");

    await expect(loadFilePreview("/p/logo.png")).resolves.toEqual({ kind: "binary" });
  });

  it("resolves a read failure to an error instead of rejecting", async () => {
    statOk(10);
    vi.mocked(readTextFile).mockRejectedValue("forbidden path: /etc/shadow");

    await expect(loadFilePreview("/etc/shadow")).resolves.toEqual({
      kind: "error",
      message: "forbidden path: /etc/shadow",
    });
  });
});

describe("path helpers", () => {
  it.for([
    ["C:\\code\\app", "src", "C:\\code\\app\\src"],
    ["C:\\", "src", "C:\\src"],
    ["/home/me/app", "src", "/home/me/app/src"],
    ["/", "etc", "/etc"],
  ] as const)("joins %s + %s as %s", ([dir, name, expected]) => {
    expect(childPath(dir, name)).toBe(expected);
  });

  it.for([
    ["C:\\code\\app\\main.rs", "main.rs"],
    ["/home/me/app/", "app"],
    ["plain.txt", "plain.txt"],
  ] as const)("takes the basename of %s", ([path, expected]) => {
    expect(basename(path)).toBe(expected);
  });

  it.for([
    [512, "512 Bytes"],
    [2048, "2.0 KB"],
    [3.5 * 1024 * 1024, "3.5 MB"],
  ] as const)("formats %d bytes as %s", ([bytes, expected]) => {
    expect(formatBytes(bytes)).toBe(expected);
  });
});
