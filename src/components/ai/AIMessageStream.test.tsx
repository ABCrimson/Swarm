import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AIMessageStream, parseContent } from "#components/ai/AIMessageStream";

describe("parseContent", () => {
  it("splits text, inline code and fenced blocks with any info string and CRLF", () => {
    const raw = "Run `pnpm test`:\r\n```ts title=x.ts\r\nconst a = 1;\r\n```\r\nDone.";
    expect(
      parseContent(raw).map(({ type, content, language }) => ({ type, content, language })),
    ).toEqual([
      { type: "text", content: "Run ", language: undefined },
      { type: "inline_code", content: "pnpm test", language: undefined },
      { type: "text", content: ":\r\n", language: undefined },
      { type: "code_block", content: "const a = 1;", language: "ts" },
      { type: "text", content: "\r\nDone.", language: undefined },
    ]);
  });

  it("renders a still-open trailing fence as code while streaming", () => {
    const segments = parseContent("Here:\n```rust\nfn main() {");
    expect(segments.at(-1)).toMatchObject({
      type: "code_block",
      language: "rust",
      content: "fn main() {",
    });
  });

  it("gives every segment a distinct key offset", () => {
    const starts = parseContent("`a` b `c` ```\nx\n``` d").map((s) => s.start);
    expect(new Set(starts).size).toBe(starts.length);
  });
});

describe("AIMessageStream", () => {
  it("keeps every character of a line with an unterminated quote", () => {
    const { container } = render(
      <AIMessageStream content={"```js\nconst s = 'oops\n```"} isStreaming={false} />,
    );
    expect(container.querySelector("code")?.textContent).toBe("const s = 'oops\n");
  });

  it("treats # as a comment only in hash-comment languages", () => {
    render(<AIMessageStream content={"```rust\n#[derive(Debug)]\n```"} isStreaming={false} />);
    const hash = screen.getByText("#[");
    expect(hash).not.toHaveStyle({ fontStyle: "italic" });
  });

  it("marks a streaming block busy and shows the cursor", () => {
    const { container } = render(<AIMessageStream content="Hi" isStreaming />);
    expect(container.firstElementChild).toHaveAttribute("aria-busy", "true");
    expect(container.querySelector("[aria-hidden='true']")).not.toBeNull();
  });
});
