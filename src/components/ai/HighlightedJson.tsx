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

const BASE = "m-0 font-mono wrap-anywhere whitespace-pre-wrap";

/**
 * Pretty-printed JSON with OKLCH syntax colors (`#lib/syntax-highlight`). Each
 * token's color is computed per token, so it travels as `--token-color` for the
 * `text-(--token-color)` class to read. `className` adds utilities to the `<pre>`;
 * `style` stays for a caller that still passes an inline style.
 */
export function HighlightedJson({
  data,
  className,
  style,
}: {
  readonly data: unknown;
  readonly className?: string;
  readonly style?: CSSProperties;
}): React.ReactElement {
  const tokens = keyByOffset(tokenizeJson(JSON.stringify(data, null, 2) ?? "undefined"));
  return (
    <pre className={className ? `${BASE} ${className}` : BASE} style={style}>
      {tokens.map((token) => (
        <span
          key={token.key}
          className="text-(--token-color)"
          style={{ "--token-color": token.color } as CSSProperties}
        >
          {token.value}
        </span>
      ))}
    </pre>
  );
}
