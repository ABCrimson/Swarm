import { act, render, screen } from "@testing-library/react";
import { Suspense } from "react";
import { describe, expect, it } from "vitest";
import { FileViewer } from "#components/workspace/FileViewer";
import type { FilePreview } from "#lib/file-preview";

async function renderPreview(path: string, preview: FilePreview) {
  const selection = { path, preview: Promise.resolve(preview) };
  // `use()` suspends once; awaiting act flushes the resolved promise.
  const { container } = await act(async () =>
    render(
      <Suspense fallback={<p>Loading</p>}>
        <FileViewer selection={selection} />
      </Suspense>,
    ),
  );
  const [gutter, code] = container.querySelectorAll("pre");
  return { gutter, code };
}

describe("FileViewer", () => {
  it("shows the file name and the text with line numbers", async () => {
    const { gutter, code } = await renderPreview("C:\\proj\\notes.txt", {
      kind: "text",
      text: "one\ntwo\nthree",
    });

    expect(screen.getByText("notes.txt")).toHaveAttribute("title", "C:\\\\proj\\\\notes.txt");
    expect(gutter?.textContent).toBe("1\n2\n3");
    expect(gutter).toHaveAttribute("aria-hidden", "true");
    expect(code?.textContent).toBe("one\ntwo\nthree");
  });

  // Trojan Source: a right-to-left override in the path must show as an escape,
  // in the header and in the tooltip, never as an invisible reordering.
  it("escapes bidi controls in the header and its tooltip", async () => {
    await renderPreview("/proj/a\u202Eb.js", { kind: "text", text: "x" });

    expect(screen.getByText("a\\u202Eb.js")).toBeInTheDocument();
    expect(screen.getByTitle("/proj/a\\u202Eb.js")).toHaveTextContent("a\\u202Eb.js");
  });

  // Regression: the JSON tokenizer dropped comment characters and
  // rewrote `:` spacing, so the viewer showed text that is not in the file.
  it.for([
    ["tsconfig.jsonc", '{\n  // strict mode\n  "strict": true /* yes */\n}\n'],
    ["min.json", '{"a":1,"b":[true,null]}'],
    ["pretty.json", '{\n  "name": "swarm",\n  "private": true\n}\n'],
  ] as const)("shows %s exactly as it is on disk", async ([name, text]) => {
    const { code } = await renderPreview(`/proj/${name}`, { kind: "text", text });

    expect(code?.textContent).toBe(text);
  });

  it("highlights JSON the tokenizer reproduces exactly", async () => {
    const { code } = await renderPreview("/proj/pretty.json", {
      kind: "text",
      text: '{\n  "name": "swarm"\n}',
    });

    expect(code?.querySelectorAll("span").length).toBeGreaterThan(1);
  });

  it("does not render a DOM row per line", async () => {
    const text = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join("\n");
    const { gutter, code } = await renderPreview("/proj/big.log", { kind: "text", text });

    expect(gutter?.childElementCount).toBe(0);
    expect(code?.childElementCount).toBe(0);
  });

  it.for([
    [{ kind: "binary" }, "Binary File — Not Shown"],
    [{ kind: "too-large", bytes: 5 * 1024 * 1024 }, /File Too Large To Preview \(5\.0 MB/],
    [{ kind: "error", message: "forbidden path" }, "Could Not Read This File: forbidden path"],
  ] as const)("explains a %o preview", async ([preview, message]) => {
    await renderPreview("/proj/file.bin", preview);

    expect(screen.getByText(message)).toBeInTheDocument();
  });
});
