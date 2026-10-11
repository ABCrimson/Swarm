// The one module that makes a model- or filesystem-controlled string safe to
// show (the SEC-4 escaping contract). Every user-visible path, name, command
// or message goes through `escapeForDisplay`; do not write a second copy.

/** Control, format, line/paragraph separator and default-ignorable characters (bidi, zero-width, tag, variation selector) that must never reach the screen raw. */
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/u;

const NAMED_ESCAPES: Readonly<Record<string, string>> = {
  "\\": "\\\\",
  "\n": "\\n",
  "\r": "\\r",
  "\t": "\\t",
};

/**
 * Makes a model-controlled string safe to show, in one pass so an escape
 * is never escaped again: a backslash becomes `\\`; newline, carriage
 * return and tab become `\n`, `\r`, `\t`; every other control,
 * format, line/paragraph separator or default-ignorable character becomes a visible
 * `\uXXXX` (`\u{XXXXX}` above U+FFFF).
 * Because backslashes are doubled, every escape in the output is
 * unambiguous: a real newline (`\n`) never looks like the two characters
 * backslash and n (`\\n`).
 */
export function escapeForDisplay(value: string): string {
  let out = "";
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    const named = NAMED_ESCAPES[char];
    if (named !== undefined) out += named;
    else if (INVISIBLE.test(char)) {
      const hex = code.toString(16).toUpperCase();
      out += code > 0xffff ? `\\u{${hex}}` : `\\u${hex.padStart(4, "0")}`;
    } else out += char;
  }
  return out;
}
