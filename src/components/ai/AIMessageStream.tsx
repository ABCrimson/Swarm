import type { CSSProperties } from "react";
import { useDeferredValue } from "react";

interface AIMessageStreamProps {
  /** The raw (possibly still streaming) text content. */
  readonly content: string;
  /** Whether more text is still arriving — shows the cursor and marks the block busy. */
  readonly isStreaming: boolean;
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
  overflowWrap: "anywhere",
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
};

const langLabelStyle: CSSProperties = {
  display: "block",
  marginBottom: 6,
  fontSize: 11,
  color: "oklch(0.62 0.08 205)",
  textTransform: "uppercase",
  letterSpacing: "0.05em",
  fontFamily: "var(--font-body, 'DM Sans Variable', system-ui, sans-serif)",
};

const TOKEN_COLORS = {
  string: "oklch(0.82 0.18 140)",
  comment: "oklch(0.62 0.03 220)",
  number: "oklch(0.82 0.19 70)",
  keyword: "oklch(0.72 0.20 290)",
} as const;

// ── Keyword Highlighting ────────────────────────────

const CODE_KEYWORDS = new Set([
  // JavaScript / TypeScript
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
  // Rust
  "fn",
  "mut",
  "pub",
  "struct",
  "impl",
  "use",
  "mod",
  "match",
  // Python
  "def",
  "self",
  "None",
  "True",
  "False",
  "yield",
  "lambda",
]);

/** Languages whose line comments start with `#`; everywhere else `#` is code (`#[derive]`, `#fff`, `#include`). */
const HASH_COMMENT_LANGUAGES = new Set([
  "python",
  "py",
  "sh",
  "bash",
  "zsh",
  "shell",
  "console",
  "yaml",
  "yml",
  "toml",
  "ruby",
  "rb",
  "r",
  "perl",
  "dockerfile",
  "powershell",
  "ps1",
  "ini",
  "conf",
]);

/**
 * One code line as highlighted spans. Rust lifetimes (`'a`) are matched
 * before single-quoted strings so they don't swallow the rest of the line.
 */
function highlightCodeLine(line: string, language: string | undefined): React.ReactNode[] {
  const hashComments = language !== undefined && HASH_COMMENT_LANGUAGES.has(language);
  // An unterminated quote runs to the end of the line as one token, so no
  // match is retried from every quote; the trailing `.` alternative still
  // guarantees every other character (a lone backtick) lands in some token.
  const tokenPattern = hashComments
    ? /(\/\/.*$|(?:^|(?<=\s))#.*$|"(?:[^"\\]|\\.)*"?|'[A-Za-z_]\w*\b(?!')|'(?:[^'\\]|\\.)*'?|`[^`]*`|\b\w+\b|\d+\.?\d*|[^\w\s"'`]+|\s+|.)/g
    : /(\/\/.*$|"(?:[^"\\]|\\.)*"?|'[A-Za-z_]\w*\b(?!')|'(?:[^'\\]|\\.)*'?|`[^`]*`|\b\w+\b|\d+\.?\d*|[^\w\s"'`]+|\s+|.)/g;
  const tokens: React.ReactNode[] = [];
  let index = 0;

  for (const [token] of line.matchAll(tokenPattern)) {
    const key = index++;
    let color: string | undefined;
    if (token.startsWith("//") || (hashComments && token.startsWith("#"))) {
      color = TOKEN_COLORS.comment;
    } else if (/^(["`]|'.*'$)/.test(token) && token.length > 1) {
      color = TOKEN_COLORS.string;
    } else if (/^\d+\.?\d*$/.test(token)) {
      color = TOKEN_COLORS.number;
    } else if (CODE_KEYWORDS.has(token)) {
      color = TOKEN_COLORS.keyword;
    }
    tokens.push(
      <span
        key={key}
        style={
          color
            ? { color, fontStyle: color === TOKEN_COLORS.comment ? "italic" : undefined }
            : undefined
        }
      >
        {token}
      </span>,
    );
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

/**
 * A fenced code block: any info string (` ```ts title=x `, ` ```c++ `),
 * LF or CRLF, and — while a reply is still streaming — an unclosed
 * trailing fence, which renders as code instead of raw backticks.
 */
const CODE_FENCE = /```([^\n`]*)\r?\n([\s\S]*?)(?:```|$)/g;
const INLINE_CODE = /`([^`\n]+)`/g;

function parseInlineCode(text: string, baseOffset: number): ParsedSegment[] {
  const segments: ParsedSegment[] = [];
  let last = 0;
  for (const match of text.matchAll(INLINE_CODE)) {
    if (match.index > last) {
      segments.push({
        type: "text",
        content: text.slice(last, match.index),
        start: baseOffset + last,
      });
    }
    segments.push({
      type: "inline_code",
      content: match[1] ?? "",
      start: baseOffset + match.index,
    });
    last = match.index + match[0].length;
  }
  if (last < text.length) {
    segments.push({ type: "text", content: text.slice(last), start: baseOffset + last });
  }
  return segments;
}

export function parseContent(raw: string): ParsedSegment[] {
  const segments: ParsedSegment[] = [];
  let last = 0;
  for (const match of raw.matchAll(CODE_FENCE)) {
    if (match.index > last) segments.push(...parseInlineCode(raw.slice(last, match.index), last));
    segments.push({
      type: "code_block",
      content: (match[2] ?? "").replace(/\r?\n$/, ""),
      language: match[1]?.trim().split(/\s+/)[0]?.toLowerCase() || undefined,
      start: match.index,
    });
    last = match.index + match[0].length;
  }
  if (last < raw.length) segments.push(...parseInlineCode(raw.slice(last), last));
  return segments;
}

function CodeBlock({ segment }: { readonly segment: ParsedSegment }): React.ReactElement {
  const lines: { readonly key: number; readonly text: string }[] = [];
  let offset = segment.start;
  for (const text of segment.content.split(/\r?\n/)) {
    lines.push({ key: offset, text });
    offset += text.length + 1;
  }
  return (
    <pre
      // biome-ignore lint/a11y/noNoninteractiveTabindex: a horizontally scrollable block must be keyboard-focusable so it can be scrolled without a mouse (WCAG 2.1.1); WebKit (WKWebView, WebKitGTK) does not focus scroll containers natively.
      tabIndex={0}
      style={codeBlockStyle}
    >
      {segment.language && <span style={langLabelStyle}>{segment.language}</span>}
      <code>
        {lines.map((line) => (
          <span key={line.key}>
            {highlightCodeLine(line.text, segment.language)}
            {"\n"}
          </span>
        ))}
      </code>
    </pre>
  );
}

// ── Component ───────────────────────────────────────

/**
 * Renders (streaming) AI text with lightweight markdown: fenced code
 * blocks with OKLCH keyword highlighting and inline code. While
 * streaming it shows a blinking cursor (a `motion-safe` class, so it
 * honours reduced motion) and is `aria-busy`; `useDeferredValue` keeps
 * input responsive while text arrives quickly.
 */
export function AIMessageStream({
  content,
  isStreaming,
}: AIMessageStreamProps): React.ReactElement {
  const deferredContent = useDeferredValue(content);
  const segments = parseContent(deferredContent);

  return (
    <div style={containerStyle} aria-busy={isStreaming || undefined}>
      {segments.map((segment) => {
        switch (segment.type) {
          case "code_block":
            return <CodeBlock key={`seg-${segment.start}`} segment={segment} />;
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
      {isStreaming && (
        <span
          className="motion-safe:animate-[cursor-blink_1s_step-end_infinite]"
          style={cursorStyle}
          aria-hidden="true"
        />
      )}
    </div>
  );
}
