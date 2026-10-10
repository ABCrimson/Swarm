import { use } from "react";
import { escapeForDisplay } from "#lib/display-escape";
import { basename, type FilePreview, formatBytes, MAX_PREVIEW_BYTES } from "#lib/file-preview";
import { tokenizeJson } from "#lib/syntax-highlight";

/** JSON above this size renders as plain text: one span per coloured token gets expensive. */
const MAX_HIGHLIGHT_CHARS = 256 * 1024;

/** Bidi embedding, override, isolate and mark characters (Trojan Source, CVE-2021-42574): text holding them can display in a different order than it is stored. */
const BIDI_CONTROL = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/u;

/** A file chosen in the tree, with the (possibly still pending) read of its contents. */
export interface FileSelection {
  readonly path: string;
  readonly preview: Promise<FilePreview>;
}

interface FileViewerProps {
  readonly selection: FileSelection;
  /** A newer selection is loading; the current file stays visible, dimmed. */
  readonly pending?: boolean;
}

/**
 * Read-only file viewer: a header with the file name, then the contents
 * with line numbers. `.json` and `.jsonc` files are syntax-highlighted,
 * comments included. The tokenizer is lossless (anything it does not
 * understand becomes a `plain` token); a final check that the tokens join
 * back to the exact file text guards the render, and plain text is shown
 * if it ever fails. Files above `MAX_HIGHLIGHT_CHARS` are also plain text.
 *
 * Suspends on `selection.preview` via `use()`; render it inside a
 * `<Suspense>`. The header and body always come from the same
 * selection, so the old file never shows under the new name.
 *
 * The body is one text node for the gutter and one for the text (or
 * one span per coloured JSON token, with whitespace as bare text), not
 * a DOM row per line, so a large file cannot flood the webview with
 * nodes.
 */
export function FileViewer({ selection, pending = false }: FileViewerProps): React.ReactElement {
  const preview = use(selection.preview);

  return (
    <div
      className="flex h-full flex-col bg-surface-0 transition-opacity data-pending:opacity-60"
      data-pending={pending || undefined}
      aria-busy={pending || undefined}
    >
      <p
        className="truncate border-border border-b bg-surface-1/60 px-4 py-2 font-mono text-fg-muted text-sm"
        title={selection.path}
      >
        {escapeForDisplay(basename(selection.path))}
      </p>
      <PreviewBody path={selection.path} preview={preview} />
    </div>
  );
}

function PreviewBody({
  path,
  preview,
}: {
  readonly path: string;
  readonly preview: FilePreview;
}): React.ReactElement {
  switch (preview.kind) {
    case "error":
      return <Notice tone="error">Could Not Read This File: {preview.message}</Notice>;
    case "binary":
      return <Notice>Binary File — Not Shown</Notice>;
    case "too-large":
      return (
        <Notice>
          File Too Large To Preview ({formatBytes(preview.bytes)}; The Limit Is{" "}
          {formatBytes(MAX_PREVIEW_BYTES)})
        </Notice>
      );
    case "text":
      return <TextView name={basename(path)} text={preview.text} highlight={isJsonPath(path)} />;
  }
}

function Notice({
  children,
  tone = "info",
}: {
  readonly children: React.ReactNode;
  readonly tone?: "info" | "error";
}): React.ReactElement {
  return (
    <p
      role={tone === "error" ? "alert" : "status"}
      className={`p-4 text-md ${tone === "error" ? "text-rose" : "text-fg-muted"}`}
    >
      {children}
    </p>
  );
}

function isJsonPath(path: string): boolean {
  return /\.jsonc?$/i.test(path);
}

function TextView({
  name,
  text,
  highlight,
}: {
  readonly name: string;
  readonly text: string;
  readonly highlight: boolean;
}): React.ReactElement {
  const lineCount = text.split("\n").length;
  const gutter = Array.from({ length: lineCount }, (_, i) => i + 1).join("\n");
  const tokens = highlight && text.length <= MAX_HIGHLIGHT_CHARS ? tokenizeJson(text) : null;
  const faithful = tokens !== null && tokens.map((t) => t.value).join("") === text;

  return (
    <>
      {BIDI_CONTROL.test(text) && (
        <Notice tone="error">
          This File Contains Bidirectional Control Characters — The Text Below May Display In A
          Different Order Than It Is Stored
        </Notice>
      )}
      <section
        aria-label={`Contents Of ${name}`}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be keyboard-focusable so it can be scrolled without a mouse (WCAG 2.1.1).
        tabIndex={0}
        className="scroll-area flex flex-1 overflow-auto py-3 font-mono text-md leading-relaxed"
      >
        <pre
          aria-hidden="true"
          className="sticky left-0 shrink-0 select-none bg-surface-0 pr-4 pl-4 text-right text-fg-dim"
          style={{ minWidth: `${String(lineCount).length + 2}ch` }}
        >
          {gutter}
        </pre>
        <pre className="pr-4 text-fg">
          {faithful
            ? tokens.map((token, i) =>
                token.type === "whitespace" ? (
                  token.value
                ) : (
                  // biome-ignore lint/suspicious/noArrayIndexKey: tokens are positional and never reorder
                  <span key={i} style={{ color: token.color }}>
                    {token.value}
                  </span>
                ),
              )
            : text}
        </pre>
      </section>
    </>
  );
}
