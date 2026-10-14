// @vitest-environment node
// WebKit before 318930@main (https://webkit.org/b/321064), which includes the
// WebKit 18.4 floor (ADR-0037), returns false from `Error.isError` for a
// DOMException; the error mapper must keep its message. Node environment:
// jsdom's DOMException belongs to a different realm than `Error`.

import { describe, expect, it, vi } from "vitest";
import { toAiRequestError } from "#lib/anthropic";

vi.mock(import("#lib/tauri"), () => ({ readConfig: vi.fn() }));

describe("toAiRequestError on WebKit", () => {
  it("keeps a DOMException message instead of the generic text", () => {
    using _isError = vi.spyOn(Error, "isError").mockReturnValue(false);

    const mapped = toAiRequestError(new DOMException("socket closed", "NetworkError"));

    expect(mapped.kind).toBe("unknown");
    expect(mapped.message).toBe("socket closed");
  });
});
