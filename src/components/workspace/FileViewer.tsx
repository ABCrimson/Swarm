import { use } from "react";
import { basename, type FilePreview, formatBytes, MAX_PREVIEW_BYTES } from "#lib/file-preview";
import { tokenizeJson } from "#lib/syntax-highlight";

/** JSON above this size renders as plain text: one span per coloured token gets expensive. */
const MAX_HIGHLIGHT_CHARS = 256 * 1024;

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
 * with line numbers. JSON files are syntax-highlighted, but only when the
 * tokens reproduce the file exactly — JSONC comments, or anything else
 * the JSON tokenizer does not understand, fall back to plain text rather
 * than showing content that is not in the file.
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
        {basename(selection.path)}
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
      return <TextView text={preview.text} highlight={isJsonPath(path)} />;
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
    <p className={`p-4 text-md ${tone === "error" ? "text-rose" : "text-fg-muted"}`}>{children}</p>
  );
}

function isJsonPath(path: string): boolean {
  return /\.jsonc?$/i.test(path);
}

function TextView({
  text,
  highlight,
}: {
  readonly text: string;
  readonly highlight: boolean;
}): React.ReactElement {
  const lineCount = text.split("\n").length;
  const gutter = Array.from({ length: lineCount }, (_, i) => i + 1).join("\n");
  const tokens = highlight && text.length <= MAX_HIGHLIGHT_CHARS ? tokenizeJson(text) : null;
  const faithful = tokens !== null && tokens.map((t) => t.value).join("") === text;

  return (
    <div className="scroll-area flex flex-1 overflow-auto py-3 font-mono text-md leading-relaxed">
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
    </div>
  );
}
