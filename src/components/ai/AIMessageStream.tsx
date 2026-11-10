import { useDeferredValue } from "react";

interface AIMessageStreamProps {
  /** The raw (possibly still streaming) text content. */
  readonly content: string;
  /** Whether more text is still arriving — shows the cursor and marks the block busy. */
  readonly isStreaming: boolean;
}

// ── Styles (utilities; literals with no token wait for the Q-9 design direction) ──

const CONTAINER =
  "relative rounded-md border border-border bg-surface-2/60 px-4 py-3 font-sans text-(length:--text-md) leading-[1.7] wrap-anywhere whitespace-pre-wrap text-[oklch(0.88_0.03_220)] backdrop-blur-[12px] backdrop-saturate-150";

const CODE_BLOCK =
  "my-2 block overflow-x-auto rounded-[6px] border border-[oklch(0.20_0.03_220)] bg-surface-0 px-3.5 py-3 font-mono text-[13px] leading-[1.6] text-fg [tab-size:2]";

const INLINE_CODE_CLASS =
  "rounded-sm bg-[oklch(0.12_0.02_220)] px-1.5 py-0.5 font-mono text-[0.9em] text-plasma";

const CURSOR =
  "ml-0.5 inline-block h-[1.2em] w-0.5 bg-plasma align-text-bottom motion-safe:animate-[cursor-blink_1s_step-end_infinite]";

const LANG_LABEL =
  "mb-1.5 block font-display text-(length:--text-md) font-semibold tracking-[-0.01em] text-[oklch(0.62_0.08_205)]";

const TOKEN_CLASSES = {
  string: "text-lime",
  comment: "text-[oklch(0.62_0.03_220)] italic",
  number: "text-amber",
  keyword: "text-[oklch(0.72_0.20_290)]",
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
    let tokenClass: string | undefined;
    if (token.startsWith("//") || (hashComments && token.startsWith("#"))) {
      tokenClass = TOKEN_CLASSES.comment;
    } else if (/^(["`]|'.*'$)/.test(token) && token.length > 1) {
      tokenClass = TOKEN_CLASSES.string;
    } else if (/^\d+\.?\d*$/.test(token)) {
      tokenClass = TOKEN_CLASSES.number;
    } else if (CODE_KEYWORDS.has(token)) {
      tokenClass = TOKEN_CLASSES.keyword;
    }
    tokens.push(
      <span key={key} className={tokenClass}>
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
  readonly language?: string | undefined;
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
      className={CODE_BLOCK}
    >
      {segment.language && <span className={LANG_LABEL}>{segment.language}</span>}
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
    <div className={CONTAINER} aria-busy={isStreaming || undefined}>
      {segments.map((segment) => {
        switch (segment.type) {
          case "code_block":
            return <CodeBlock key={`seg-${segment.start}`} segment={segment} />;
          case "inline_code":
            return (
              <code key={`seg-${segment.start}`} className={INLINE_CODE_CLASS}>
                {segment.content}
              </code>
            );
          default:
            return <span key={`seg-${segment.start}`}>{segment.content}</span>;
        }
      })}
      {isStreaming && <span className={CURSOR} aria-hidden="true" />}
    </div>
  );
}
