// ── JSON / JSONC Syntax Highlighter ─────────
// Splits JSON text into colored tokens. Lossless: the token values
// joined back together are exactly the input, so a viewer shows the
// file as it is on disk, comments and invalid text included.

/** CSS color per token type: the design token where one matches, else an OKLCH literal. */
const TOKEN_COLORS = {
  key: "var(--color-plasma)",
  string: "var(--color-lime)",
  number: "var(--color-amber)",
  boolean: "oklch(0.72 0.20 290)",
  null: "oklch(0.72 0.20 290)",
  brace: "oklch(0.66 0.04 220)",
  colon: "var(--color-fg-dim)",
  comma: "var(--color-fg-dim)",
  /** `//` and `/* *\/` comments (JSONC: tsconfig.json, biome.jsonc). */
  comment: "oklch(0.62 0.02 220)",
  whitespace: "oklch(0 0 0 / 0)",
  /** Anything that is not JSON, e.g. `NaN` or trailing garbage: shown as is. */
  plain: "var(--color-fg)",
} as const;

/** A token category. */
export type TokenType = keyof typeof TOKEN_COLORS;

/** One highlighted token and its CSS color (a design-token var() or an OKLCH literal). */
export interface HighlightToken {
  readonly type: TokenType;
  readonly value: string;
  readonly color: string;
}

/**
 * One alternative per token type, tried in order at every position
 * (sticky + global, so `matchAll` walks the input without gaps). A
 * string directly followed by `:` is a key. An unterminated string or
 * block comment runs to the end of its line or of the input.
 */
const TOKEN_PATTERN = new RegExp(
  [
    String.raw`(?<whitespace>\s+)`,
    String.raw`(?<comment>//[^\n]*|/\*[\s\S]*?(?:\*/|$))`,
    String.raw`(?<key>"(?:[^"\\\n]|\\.)*"(?=\s*:))`,
    String.raw`(?<string>"(?:[^"\\\n]|\\.)*"?)`,
    String.raw`(?<number>-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)`,
    String.raw`(?<boolean>(?:true|false)\b)`,
    String.raw`(?<null>null\b)`,
    String.raw`(?<brace>[{}[\]])`,
    "(?<colon>:)",
    "(?<comma>,)",
    String.raw`(?<plain>[^\s{}[\]:,"/]+|[\s\S])`,
  ].join("|"),
  "gy",
);

const TOKEN_TYPES = Object.keys(TOKEN_COLORS) as TokenType[];

/**
 * Tokenizes JSON or JSONC text for rendering: keys, strings, numbers,
 * booleans, `null`, structure, comments, whitespace, and a `plain`
 * token for anything else.
 */
export function tokenizeJson(input: string): HighlightToken[] {
  return input
    .matchAll(TOKEN_PATTERN)
    .map((match): HighlightToken => {
      const type = TOKEN_TYPES.find((t) => match.groups?.[t] !== undefined) ?? "plain";
      return { type, value: match[0], color: TOKEN_COLORS[type] };
    })
    .toArray();
}
