import { describe, expect, it } from "vitest";
import { stripAnsi } from "#lib/ansi";

describe("stripAnsi", () => {
  it("removes SGR colour codes", () => {
    expect(stripAnsi("\u001b[1;31merror\u001b[0m: failed")).toBe("error: failed");
  });

  it("removes cursor movement and erase sequences", () => {
    expect(stripAnsi("\u001b[2K\u001b[1Gdone")).toBe("done");
  });

  it("removes OSC sequences ended by BEL or ST (window titles, hyperlinks)", () => {
    expect(stripAnsi("\u001b]0;title\u0007a\u001b]8;;https://x\u001b\\b")).toBe("ab");
  });

  it("removes 8-bit CSI and two-character ESC sequences", () => {
    expect(stripAnsi("\u009b32mok\u001b=\u001b>\u001b7")).toBe("ok");
  });

  it("normalises CRLF to LF and leaves plain text alone", () => {
    expect(stripAnsi("line 1\r\nline 2\n")).toBe("line 1\nline 2\n");
  });
});
