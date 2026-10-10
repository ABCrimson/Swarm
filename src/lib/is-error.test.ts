// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { errorMessage, isError } from "#lib/is-error";

describe("isError", () => {
  it("accepts a DOMException when Error.isError rejects it (WebKit)", () => {
    using _isError = vi.spyOn(Error, "isError").mockReturnValue(false);
    const err = new DOMException("denied", "SecurityError");
    expect(isError(err)).toBe(true);
    expect(errorMessage(err)).toBe("denied");
  });

  it("rejects non-errors", () => {
    expect(isError("boom")).toBe(false);
    expect(isError({ message: "x" })).toBe(false);
  });
});
