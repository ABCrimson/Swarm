import { exists, readTextFile, remove, rename, writeTextFile } from "@tauri-apps/plugin-fs";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BaseDirectory, readScopedTextFile, writeScopedTextFile } from "#lib/fs";

const APP_DATA = { baseDir: BaseDirectory.AppData };
const RENAME_OPTIONS = {
  oldPathBaseDir: BaseDirectory.AppData,
  newPathBaseDir: BaseDirectory.AppData,
};

beforeEach(() => {
  for (const fn of [exists, readTextFile, remove, rename, writeTextFile]) vi.mocked(fn).mockReset();
  vi.mocked(toast.error).mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("writeScopedTextFile", () => {
  it.each([
    ["Windows", "C:\\Users\\me\\Documents\\session.json"],
    ["Windows, forward slashes", "D:/Exports/session.json"],
    ["UNC", "\\\\server\\share\\session.json"],
    ["POSIX", "/home/me/session.json"],
  ])("writes a dialog-picked %s path in place, with no temp sibling", async (_, path) => {
    await writeScopedTextFile(path, "{}");

    expect(writeTextFile).toHaveBeenCalledExactlyOnceWith(path, "{}");
    expect(rename).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it("writes an app-owned relative path atomically through a temp file", async () => {
    await writeScopedTextFile("exports/session.json", "{}");

    expect(writeTextFile).toHaveBeenCalledExactlyOnceWith(
      "exports/session.json.tmp",
      "{}",
      APP_DATA,
    );
    expect(rename).toHaveBeenCalledExactlyOnceWith(
      "exports/session.json.tmp",
      "exports/session.json",
      RENAME_OPTIONS,
    );
  });

  it("retries a rename that fails for a moment, never deleting the target", async () => {
    vi.useFakeTimers();
    vi.mocked(rename)
      .mockRejectedValueOnce(new Error("The process cannot access the file"))
      .mockRejectedValueOnce(new Error("The process cannot access the file"))
      .mockResolvedValueOnce(undefined);

    const write = writeScopedTextFile("state.json", "{}");
    await vi.advanceTimersByTimeAsync(50);
    expect(rename).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(100);
    await write;

    expect(rename).toHaveBeenCalledTimes(3);
    expect(remove).not.toHaveBeenCalled();
  });

  it("gives up after three renames: removes only the temp file and throws", async () => {
    vi.useFakeTimers();
    const denied = new Error("Access is denied.");
    vi.mocked(rename).mockRejectedValue(denied);
    vi.mocked(remove).mockResolvedValue(undefined);

    const write = writeScopedTextFile("state.json", "{}");
    const assertion = expect(write).rejects.toBe(denied);
    await vi.advanceTimersByTimeAsync(150);
    await assertion;

    expect(rename).toHaveBeenCalledTimes(3);
    expect(remove).toHaveBeenCalledExactlyOnceWith("state.json.tmp", APP_DATA);
  });

  it("turns a disk-full failure into a Title Case error and a toast", async () => {
    const enospc = new Error("No space left on device (os error 28)");
    vi.mocked(writeTextFile).mockRejectedValue(enospc);

    const err = await writeScopedTextFile("/home/me/session.json", "{}").catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe(
      'Disk Full: Cannot Write "/home/me/session.json". Free Up Disk Space And Try Again.',
    );
    expect((err as Error).cause).toBe(enospc);
    expect(toast.error).toHaveBeenCalledOnce();
  });

  it("re-throws any other write failure unchanged", async () => {
    const forbidden = "forbidden path: C:\\secret.json";
    vi.mocked(writeTextFile).mockRejectedValue(forbidden);

    await expect(writeScopedTextFile("C:\\secret.json", "{}")).rejects.toBe(forbidden);
    expect(toast.error).not.toHaveBeenCalled();
  });
});

describe("readScopedTextFile", () => {
  it("resolves null for a missing file", async () => {
    vi.mocked(exists).mockResolvedValue(false);

    await expect(readScopedTextFile("missing.json")).resolves.toBeNull();
    expect(readTextFile).not.toHaveBeenCalled();
  });

  it("reads an existing file", async () => {
    vi.mocked(exists).mockResolvedValue(true);
    vi.mocked(readTextFile).mockResolvedValue("{}");

    await expect(readScopedTextFile("C:\\session.json")).resolves.toBe("{}");
    expect(readTextFile).toHaveBeenCalledExactlyOnceWith("C:\\session.json", APP_DATA);
  });
});
