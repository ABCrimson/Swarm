// ── JSON Syntax Highlighter (OKLCH) ─────────────────
// Produces spans with inline OKLCH colors for JSON rendering.

/** OKLCH colour palette mapped to JSON token types. */
const TOKEN_COLORS = {
  key: "oklch(0.78 0.18 205)",
  string: "oklch(0.82 0.18 140)",
  number: "oklch(0.82 0.19 70)",
  boolean: "oklch(0.72 0.20 290)",
  null: "oklch(0.72 0.20 290)",
  brace: "oklch(0.55 0.03 220)",
  colon: "oklch(0.45 0.03 220)",
  comma: "oklch(0.45 0.03 220)",
} as const;

/** Discriminated union of JSON token categories. */
export type TokenType = keyof typeof TOKEN_COLORS;

/** A single syntax-highlighted JSON token with its OKLCH colour. */
export interface HighlightToken {
  type: TokenType;
  value: string;
  color: string;
}

/**
 * Tokenizes a JSON string into styled tokens for rendering.
 *
 * Handles keys, strings, numbers, booleans, null, and structural characters.
 * Returns an array of tokens with OKLCH color assignments.
 */
export function tokenizeJson(input: string): HighlightToken[] {
  const tokens: HighlightToken[] = [];
  const len = input.length;
  let i = 0;

  const push = (type: TokenType, value: string) => {
    tokens.push({ type, value, color: TOKEN_COLORS[type] });
  };

  while (i < len) {
    const ch = input[i];

    // Whitespace — preserve for formatting
    if (ch === " " || ch === "\n" || ch === "\r" || ch === "\t") {
      let ws = "";
      while (
        i < len &&
        (input[i] === " " || input[i] === "\n" || input[i] === "\r" || input[i] === "\t")
      ) {
        ws += input[i];
        i++;
      }
      // Whitespace tokens don't need color but must be present for layout
      tokens.push({ type: "brace", value: ws, color: "transparent" });
      continue;
    }

    // Structural characters
    if (ch === "{" || ch === "}" || ch === "[" || ch === "]") {
      push("brace", ch);
      i++;
      continue;
    }

    if (ch === ":") {
      push("colon", ": ");
      i++;
      // Skip optional space after colon
      if (i < len && input[i] === " ") i++;
      continue;
    }

    if (ch === ",") {
      push("comma", ",");
      i++;
      continue;
    }

    // Strings (both keys and values)
    if (ch === '"') {
      let str = '"';
      i++;
      while (i < len && input[i] !== '"') {
        if (input[i] === "\\") {
          str += input[i];
          i++;
          if (i < len) {
            str += input[i];
            i++;
          }
        } else {
          str += input[i];
          i++;
        }
      }
      if (i < len) {
        str += '"';
        i++;
      }

      // Determine if this is a key or a value by looking ahead for ':'
      let lookAhead = i;
      while (lookAhead < len && (input[lookAhead] === " " || input[lookAhead] === "\t")) {
        lookAhead++;
      }

      if (lookAhead < len && input[lookAhead] === ":") {
        push("key", str);
      } else {
        push("string", str);
      }
      continue;
    }

    // Numbers
    if (ch === "-" || (ch >= "0" && ch <= "9")) {
      let num = "";
      while (
        i < len &&
        (input[i] === "-" ||
          input[i] === "+" ||
          input[i] === "." ||
          input[i] === "e" ||
          input[i] === "E" ||
          (input[i] >= "0" && input[i] <= "9"))
      ) {
        num += input[i];
        i++;
      }
      push("number", num);
      continue;
    }

    // Booleans: true / false
    if (input.startsWith("true", i)) {
      push("boolean", "true");
      i += 4;
      continue;
    }
    if (input.startsWith("false", i)) {
      push("boolean", "false");
      i += 5;
      continue;
    }

    // Null
    if (input.startsWith("null", i)) {
      push("null", "null");
      i += 4;
      continue;
    }

    // Fallback — skip unknown character
    i++;
  }

  return tokens;
}

/**
 * Returns OKLCH color for a given token type.
 */
export function getTokenColor(type: TokenType): string {
  return TOKEN_COLORS[type];
}
