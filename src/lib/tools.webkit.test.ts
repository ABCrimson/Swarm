// @vitest-environment node
// WebKit's `Error.isError` returns false for a DOMException (WebKit bug
// 292727); `failure()` must still surface its message. Node environment:
// jsdom's DOMException belongs to a different realm than `Error`.

import { afterEach, describe, expect, it, vi } from "vitest";
import { invoke } from "#lib/tauri";
import { executeTool } from "#lib/tools";

vi.mock(import("#lib/tauri"), async (importOriginal) => ({
  ...(await importOriginal()),
  invoke: vi.fn(),
}));

afterEach(() => {
  vi.mocked(invoke).mockReset();
});

describe("failure() on WebKit", () => {
  it("reports a DOMException by its message, not 'AbortError: ...'", async () => {
    using _isError = vi.spyOn(Error, "isError").mockReturnValue(false);
    vi.mocked(invoke).mockRejectedValue(new DOMException("backend gone", "AbortError"));

    const result = await executeTool("get_metrics", {});

    expect(result).toEqual({ success: false, error: "backend gone" });
  });
});
