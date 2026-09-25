import type { CSSProperties } from "react";
import { type HighlightToken, tokenizeJson } from "#lib/syntax-highlight";

/** Pairs each token with its character offset in the source — a stable, data-derived React key. */
function keyByOffset(tokens: readonly HighlightToken[]): (HighlightToken & { key: number })[] {
  const keyed: (HighlightToken & { key: number })[] = [];
  let offset = 0;
  for (const token of tokens) {
    keyed.push({ ...token, key: offset });
    offset += token.value.length;
  }
  return keyed;
}

const baseStyle: CSSProperties = {
  margin: 0,
  fontFamily: "var(--font-mono, 'JetBrains Mono Variable', monospace)",
  whiteSpace: "pre-wrap",
  overflowWrap: "anywhere",
};

/** Pretty-printed JSON with OKLCH syntax colors (`#lib/syntax-highlight`). */
export function HighlightedJson({
  data,
  style,
}: {
  readonly data: unknown;
  readonly style?: CSSProperties;
}): React.ReactElement {
  const tokens = keyByOffset(tokenizeJson(JSON.stringify(data, null, 2) ?? "undefined"));
  return (
    <pre style={{ ...baseStyle, ...style }}>
      {tokens.map((token) => (
        <span key={token.key} style={{ color: token.color }}>
          {token.value}
        </span>
      ))}
    </pre>
  );
}
