import type { CSSProperties } from "react";
import { Button } from "#components/ui/Button";

// What an approval surface shows of a call: every input field as escaped,
// labelled data. Shared by the webview tool prompt and the agent permission row.

export const argsStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "max-content minmax(0, 1fr)",
  gap: "2px 12px",
  margin: "4px 0 0",
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  fontSize: 12,
  lineHeight: 1.5,
  color: "oklch(0.88 0.03 220)",
  whiteSpace: "pre-wrap",
  overflowWrap: "anywhere",
};

export const labelStyle: CSSProperties = { margin: 0, color: "oklch(0.7 0.04 220)" };

const valueStyle: CSSProperties = { margin: 0 };

export const reasonStyle: CSSProperties = {
  margin: "6px 0 0",
  fontSize: 12,
  color: "oklch(0.78 0.1 75)",
};

const showAllStyle: CSSProperties = { marginLeft: 8 };

/** Values longer than this are cut until the user asks for the rest. */
const TRUNCATE_AT = 500;

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

/** JSON with object keys sorted at every depth, so equal values print equally. */
function canonicalJson(value: unknown): string {
  return (
    JSON.stringify(value, (_key, inner: unknown) =>
      typeof inner === "object" && inner !== null && !Array.isArray(inner)
        ? Object.fromEntries(Object.entries(inner).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
        : inner,
    ) ?? String(value)
  );
}

interface ApprovalArg {
  readonly key: string;
  readonly label: string;
  /** The raw value: a string as is, anything else as canonical JSON. */
  readonly value: string;
  /** Whether a long value may be cut behind "Show All". */
  readonly truncatable: boolean;
}

/** `maxLines` becomes `Max Lines`, `workerId` becomes `Worker Id`. */
function humanize(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(
      /(^|\s)(\p{L})/gu,
      (_match, gap: string, letter: string) => gap + letter.toUpperCase(),
    );
}

/** Commands (the webview's `run_command`, Codex's `commandExecution`, Claude Code's `Bash`), file paths and working directories are always shown whole. */
function neverTruncated(tool: string, key: string): boolean {
  return (
    /path|cwd/i.test(key) ||
    (key === "command" && ["run_command", "commandExecution", "Bash"].includes(tool))
  );
}

/**
 * Every field of the validated input that will execute, in parsed key
 * order, as raw labelled values (escaped at render time). Per-tool extras
 * (the byte size of `write_file` content) are added beside the fields,
 * never in place of them.
 */
export function approvalArgs(tool: string, input: unknown): ReadonlyArray<ApprovalArg> {
  const entries: ReadonlyArray<readonly [string, unknown]> =
    typeof input === "object" && input !== null && !Array.isArray(input)
      ? Object.entries(input).filter(([, value]) => value !== undefined)
      : input === undefined
        ? []
        : [["input", input]];
  const args: ApprovalArg[] = [];
  for (const [key, value] of entries) {
    if (tool === "write_file" && key === "content" && typeof value === "string") {
      args.push({
        key: "size",
        label: "Size",
        value: `${new TextEncoder().encode(value).length} bytes`,
        truncatable: false,
      });
    }
    args.push({
      key,
      label: humanize(key),
      value: typeof value === "string" ? value : canonicalJson(value),
      truncatable: !neverTruncated(tool, key),
    });
  }
  return args;
}

export function isTruncated(arg: ApprovalArg): boolean {
  return arg.truncatable && arg.value.length > TRUNCATE_AT;
}

/** Where to cut a raw value: never between the halves of a surrogate pair. */
function cutPoint(raw: string): number {
  const last = raw.charCodeAt(TRUNCATE_AT - 1);
  return last >= 0xd800 && last <= 0xdbff ? TRUNCATE_AT - 1 : TRUNCATE_AT;
}

export function ArgValue({
  arg,
  showing,
  onToggle,
}: {
  readonly arg: ApprovalArg;
  readonly showing: boolean;
  readonly onToggle: () => void;
}): React.ReactElement {
  const long = isTruncated(arg);
  const cut = long && !showing ? cutPoint(arg.value) : arg.value.length;
  // Cut the raw value, then escape it, so an escape is never split.
  const hidden = [...arg.value.slice(cut)].length;
  return (
    <dd style={valueStyle}>
      {escapeForDisplay(arg.value.slice(0, cut))}
      {hidden > 0 && ` … ${hidden} more characters`}
      {long && (
        <Button size="sm" variant="secondary" style={showAllStyle} onClick={onToggle}>
          {showing ? "Show Less" : "Show All"}
        </Button>
      )}
    </dd>
  );
}
