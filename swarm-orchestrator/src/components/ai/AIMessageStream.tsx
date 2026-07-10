// ── AIMessageStream ─────────────────────────────────
// Renders streaming AI response incrementally with markdown-like
// code block rendering, OKLCH syntax highlighting, and cursor animation.
// Uses React 19 useDeferredValue for responsive UI during rapid updates.

import type { CSSProperties } from "react";
import { useDeferredValue } from "react";

interface AIMessageStreamProps {
  /** The raw streaming text content. */
  readonly content: string;
  /** Whether the stream is still active. */
  readonly isStreaming: boolean;
  /** Cancel handler — shown as a button during streaming. */
  readonly onCancel?: () => void;
}

// ── Inline Styles (OKLCH) ───────────────────────────

const containerStyle: CSSProperties = {
  position: "relative",
  padding: "12px 16px",
  borderRadius: 8,
  background: "oklch(0.14 0.03 220 / 0.6)",
  backdropFilter: "blur(12px) saturate(1.5)",
  border: "1px solid oklch(0.22 0.04 220)",
  color: "oklch(0.88 0.03 220)",
  fontFamily: "var(--font-body, 'DM Sans Variable', system-ui, sans-serif)",
  fontSize: 14,
  lineHeight: 1.7,
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  overflowWrap: "break-word",
};

const codeBlockStyle: CSSProperties = {
  display: "block",
  padding: "12px 14px",
  margin: "8px 0",
  borderRadius: 6,
  background: "oklch(0.08 0.02 220)",
  border: "1px solid oklch(0.20 0.03 220)",
  fontFamily: "var(--font-mono, 'JetBrains Mono Variable', 'Fira Code', monospace)",
  fontSize: 13,
  lineHeight: 1.6,
  overflowX: "auto",
  color: "oklch(0.82 0.04 220)",
  tabSize: 2,
};

const inlineCodeStyle: CSSProperties = {
  padding: "2px 6px",
  borderRadius: 4,
  background: "oklch(0.12 0.02 220)",
  fontFamily: "var(--font-mono, 'JetBrains Mono Variable', 'Fira Code', monospace)",
  fontSize: "0.9em",
  color: "oklch(0.78 0.18 205)",
};

const cursorStyle: CSSProperties = {
  display: "inline-block",
  width: 2,
  height: "1.2em",
  background: "oklch(0.78 0.18 205)",
  marginLeft: 2,
  verticalAlign: "text-bottom",
  animation: "cursor-blink 1s step-end infinite",
};

const cancelButtonStyle: CSSProperties = {
  position: "absolute",
  top: 8,
  right: 8,
  padding: "4px 10px",
  borderRadius: 6,
  background: "oklch(0.18 0.04 10 / 0.8)",
  border: "1px solid oklch(0.35 0.10 10)",
  color: "oklch(0.82 0.15 10)",
  fontSize: 12,
  cursor: "pointer",
  transition: "background 0.15s ease",
};

const langLabelStyle: CSSProperties = {
  display: "block",
  marginBottom: 6,
  fontSize: 11,
  color: "oklch(0.55 0.08 205)",
  textTransform: "uppercase",
  letterSpacing: "0.05em",
  fontFamily: "var(--font-body, 'DM Sans Variable', system-ui, sans-serif)",
};

// ── Keyword Highlighting ────────────────────────────

const CODE_KEYWORDS = new Set([
  "const",
  "let",
  "var",
  "function",
  "return",
  "if",
  "else",
  "for",
  "while",
  "import",
  "export",
  "from",
  "async",
  "await",
  "class",
  "new",
  "this",
  "try",
  "catch",
  "throw",
  "finally",
  "switch",
  "case",
  "break",
  "default",
  "type",
  "interface",
  "enum",
  "extends",
  "implements",
  "readonly",
  "true",
  "false",
  "null",
  "undefined",
  "void",
  "never",
  "fn",
  "let",
  "mut",
  "pub",
  "struct",
  "impl",
  "use",
  "mod",
  "match",
  "def",
  "self",
  "None",
  "True",
  "False",
  "yield",
  "lambda",
]);

function highlightCodeLine(line: string): React.ReactNode[] {
  const tokens: React.ReactNode[] = [];
  // Simple word-boundary tokenizer for keyword highlighting
  const regex = /(\b\w+\b|"[^"]*"|'[^']*'|`[^`]*`|\/\/.*$|#.*$|\d+\.?\d*|[^\w\s"'`]+|\s+)/g;
  let key = 0;

  for (const match of line.matchAll(regex)) {
    const token = match[0];
    key++;

    // String literals
    if (
      (token.startsWith('"') && token.endsWith('"')) ||
      (token.startsWith("'") && token.endsWith("'")) ||
      (token.startsWith("`") && token.endsWith("`"))
    ) {
      tokens.push(
        <span key={key} style={{ color: "oklch(0.82 0.18 140)" }}>
          {token}
        </span>,
      );
      continue;
    }

    // Comments
    if (token.startsWith("//") || token.startsWith("#")) {
      tokens.push(
        <span key={key} style={{ color: "oklch(0.55 0.03 220)", fontStyle: "italic" }}>
          {token}
        </span>,
      );
      continue;
    }

    // Numbers
    if (/^\d+\.?\d*$/.test(token)) {
      tokens.push(
        <span key={key} style={{ color: "oklch(0.82 0.19 70)" }}>
          {token}
        </span>,
      );
      continue;
    }

    // Keywords
    if (CODE_KEYWORDS.has(token)) {
      tokens.push(
        <span key={key} style={{ color: "oklch(0.72 0.20 290)" }}>
          {token}
        </span>,
      );
      continue;
    }

    tokens.push(<span key={key}>{token}</span>);
  }

  return tokens;
}

// ── Content Parser ──────────────────────────────────

interface ParsedSegment {
  readonly type: "text" | "code_block" | "inline_code";
  readonly content: string;
  readonly language?: string;
  /** Offset of this segment's start within the raw source string — stable React key. */
  readonly start: number;
}

function parseContent(raw: string): ParsedSegment[] {
  const segments: ParsedSegment[] = [];
  const codeBlockRegex = /```(\w*)\n([\s\S]*?)```/g;
  let lastIndex = 0;

  for (const blockMatch of raw.matchAll(codeBlockRegex)) {
    // Text before code block
    const matchIndex = blockMatch.index ?? 0;
    if (matchIndex > lastIndex) {
      const textBefore = raw.slice(lastIndex, matchIndex);
      parseInlineCode(textBefore, segments, lastIndex);
    }

    segments.push({
      type: "code_block",
      content: blockMatch[2],
      language: blockMatch[1] || undefined,
      start: matchIndex,
    });

    lastIndex = matchIndex + blockMatch[0].length;
  }

  // Remaining text after last code block
  if (lastIndex < raw.length) {
    parseInlineCode(raw.slice(lastIndex), segments, lastIndex);
  }

  return segments;
}

function parseInlineCode(text: string, segments: ParsedSegment[], baseOffset: number): void {
  const inlineRegex = /`([^`]+)`/g;
  let lastIdx = 0;

  for (const inlineMatch of text.matchAll(inlineRegex)) {
    const matchIndex = inlineMatch.index ?? 0;
    if (matchIndex > lastIdx) {
      segments.push({
        type: "text",
        content: text.slice(lastIdx, matchIndex),
        start: baseOffset + lastIdx,
      });
    }
    segments.push({
      type: "inline_code",
      content: inlineMatch[1],
      start: baseOffset + matchIndex,
    });
    lastIdx = matchIndex + inlineMatch[0].length;
  }

  if (lastIdx < text.length) {
    segments.push({ type: "text", content: text.slice(lastIdx), start: baseOffset + lastIdx });
  }
}

// ── Component ───────────────────────────────────────

/**
 * Renders streaming AI content with markdown-like formatting.
 *
 * - Code blocks with OKLCH syntax highlighting
 * - Inline code with monospace styling
 * - Animated cursor at end of streaming text
 * - Cancel button visible during active streams
 * - Uses `useDeferredValue` to keep UI responsive during rapid updates
 */
export function AIMessageStream({
  content,
  isStreaming,
  onCancel,
}: AIMessageStreamProps): React.ReactElement {
  // Defer the content to prevent jank during rapid streaming
  const deferredContent = useDeferredValue(content);

  const segments = parseContent(deferredContent);

  return (
    <div style={containerStyle}>
      {isStreaming && onCancel && (
        <button
          type="button"
          onClick={onCancel}
          style={cancelButtonStyle}
          aria-label="Cancel streaming"
        >
          Cancel
        </button>
      )}

      {segments.map((segment) => {
        switch (segment.type) {
          case "code_block": {
            let lineOffset = segment.start;
            return (
              <pre key={`seg-${segment.start}`} style={codeBlockStyle}>
                {segment.language && <span style={langLabelStyle}>{segment.language}</span>}
                <code>
                  {segment.content.split("\n").map((line) => {
                    const lineKey = lineOffset;
                    lineOffset += line.length + 1;
                    return (
                      <span key={`line-${lineKey}`}>
                        {highlightCodeLine(line)}
                        {"\n"}
                      </span>
                    );
                  })}
                </code>
              </pre>
            );
          }

          case "inline_code":
            return (
              <code key={`seg-${segment.start}`} style={inlineCodeStyle}>
                {segment.content}
              </code>
            );

          default:
            return <span key={`seg-${segment.start}`}>{segment.content}</span>;
        }
      })}

      {isStreaming && <span style={cursorStyle} aria-hidden="true" />}
    </div>
  );
}
