import { readTextFile } from "@tauri-apps/plugin-fs";
import { useEffect, useState } from "react";
import type { HighlightToken } from "#lib/syntax-highlight";
import { tokenizeJson } from "#lib/syntax-highlight";

/** Props for the read-only file viewer. */
interface FileViewerProps {
  /** Absolute path of the file to display. */
  readonly filePath: string | null;
}

/** Determines if a file should use JSON syntax highlighting. */
function isJsonFile(path: string): boolean {
  return path.endsWith(".json") || path.endsWith(".jsonc");
}

/** Extracts the filename from a full path. */
function basename(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] ?? path;
}

/**
 * Read-only file content viewer with syntax highlighting for JSON files.
 *
 * Uses Tauri `readTextFile()` to load file contents. Renders with line
 * numbers and monospace OKLCH styling. JSON files get token-level
 * colour highlighting via `tokenizeJson()`.
 */
export function FileViewer({ filePath }: FileViewerProps): React.ReactElement {
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!filePath) {
      setContent(null);
      setError(null);
      return;
    }

    const currentPath = filePath;
    const controller = new AbortController();

    async function loadFile(): Promise<void> {
      setLoading(true);
      setError(null);
      try {
        const text = await readTextFile(currentPath);
        if (controller.signal.aborted) return;
        setContent(text);
      } catch (err) {
        if (!controller.signal.aborted) {
          setError(String(err));
          setContent(null);
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }

    void loadFile();
    return () => controller.abort();
  }, [filePath]);

  // Empty state
  if (!filePath) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          height: "100%",
          fontFamily: "var(--font-body)",
          fontSize: "0.875rem",
          color: "oklch(0.45 0.04 220)",
        }}
      >
        Select A File To View
      </div>
    );
  }

  // Loading
  if (loading) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          height: "100%",
          fontFamily: "var(--font-body)",
          fontSize: "0.8125rem",
          color: "oklch(0.55 0.04 220)",
        }}
      >
        Loading...
      </div>
    );
  }

  // Error
  if (error) {
    return (
      <div
        style={{
          padding: 16,
          fontFamily: "var(--font-body)",
          fontSize: "0.8125rem",
          color: "oklch(0.72 0.20 10)",
        }}
      >
        Error: {error}
      </div>
    );
  }

  const lines = (content ?? "").split("\n");
  const isJson = isJsonFile(filePath);
  const jsonTokens = isJson && content ? tokenizeJson(content) : null;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        background: "oklch(0.08 0.02 220)",
      }}
    >
      {/* File header */}
      <div
        style={{
          padding: "8px 16px",
          borderBottom: "1px solid oklch(0.22 0.04 220)",
          fontFamily: "var(--font-mono)",
          fontSize: "0.75rem",
          color: "oklch(0.65 0.04 220)",
          background: "oklch(0.10 0.03 220 / 0.6)",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {basename(filePath)}
      </div>

      {/* Content area */}
      <div
        style={{
          flex: 1,
          overflow: "auto",
          padding: "12px 0",
        }}
      >
        {isJson && jsonTokens ? (
          <JsonHighlightedView tokens={jsonTokens} />
        ) : (
          <PlainTextView lines={lines} />
        )}
      </div>
    </div>
  );
}

function PlainTextView({ lines }: { readonly lines: string[] }): React.ReactElement {
  const gutterWidth = String(lines.length).length;

  return (
    <pre
      style={{
        margin: 0,
        fontFamily: "var(--font-mono)",
        fontSize: "0.8125rem",
        lineHeight: 1.6,
      }}
    >
      {lines.map((line, i) => (
        <div
          key={`ln-${String(i)}`}
          style={{
            display: "flex",
            padding: "0 16px",
          }}
        >
          <span
            style={{
              display: "inline-block",
              width: `${gutterWidth + 1}ch`,
              textAlign: "right",
              paddingRight: "16px",
              color: "oklch(0.35 0.03 220)",
              userSelect: "none",
              flexShrink: 0,
            }}
          >
            {i + 1}
          </span>
          <span style={{ color: "oklch(0.82 0.04 220)" }}>{line}</span>
        </div>
      ))}
    </pre>
  );
}

function JsonHighlightedView({
  tokens,
}: {
  readonly tokens: HighlightToken[];
}): React.ReactElement {
  // Reconstruct the JSON with tokens and add line numbers
  const fullText = tokens.map((t) => t.value).join("");
  const lines = fullText.split("\n");
  const gutterWidth = String(lines.length).length;

  // Build per-line token arrays
  const lineTokens: HighlightToken[][] = [[]];
  let currentLine = 0;
  for (const token of tokens) {
    const parts = token.value.split("\n");
    for (let p = 0; p < parts.length; p++) {
      if (p > 0) {
        currentLine++;
        lineTokens[currentLine] = [];
      }
      if (parts[p].length > 0) {
        lineTokens[currentLine].push({
          type: token.type,
          value: parts[p],
          color: token.color,
        });
      }
    }
  }

  return (
    <pre
      style={{
        margin: 0,
        fontFamily: "var(--font-mono)",
        fontSize: "0.8125rem",
        lineHeight: 1.6,
      }}
    >
      {lineTokens.map((tokens, i) => (
        <div
          key={`jln-${String(i)}`}
          style={{
            display: "flex",
            padding: "0 16px",
          }}
        >
          <span
            style={{
              display: "inline-block",
              width: `${gutterWidth + 1}ch`,
              textAlign: "right",
              paddingRight: "16px",
              color: "oklch(0.35 0.03 220)",
              userSelect: "none",
              flexShrink: 0,
            }}
          >
            {i + 1}
          </span>
          <span>
            {tokens.map((token, j) => (
              <span key={`tk-${String(j)}`} style={{ color: token.color }}>
                {token.value}
              </span>
            ))}
          </span>
        </div>
      ))}
    </pre>
  );
}
