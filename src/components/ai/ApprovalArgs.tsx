import type { CSSProperties } from "react";
import { Fragment, useId, useState } from "react";
import { Button } from "#components/ui/Button";
import { escapeForDisplay } from "#lib/display-escape";

// What an approval surface shows of a call: every input field as escaped,
// labelled data, and the gate on Allow: while any shortened value has not been
// expanded with Show All, `useApprovalReview` reports `blocked`. Both approval
// surfaces (the webview tool prompt and the agent permission row) take the
// gate from here, so a change to the rule lands on both.

const argsStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "fit-content(40%) minmax(0, 1fr)",
  gap: "2px 12px",
  margin: "4px 0 0",
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  fontSize: 12,
  lineHeight: 1.5,
  color: "oklch(0.88 0.03 220)",
  whiteSpace: "pre-wrap",
  overflowWrap: "anywhere",
};

const labelStyle: CSSProperties = { margin: 0, color: "oklch(0.7 0.04 220)" };

const valueStyle: CSSProperties = { margin: 0 };

const reasonStyle: CSSProperties = {
  margin: "6px 0 0",
  fontSize: 12,
  color: "oklch(0.78 0.1 75)",
};

const showAllStyle: CSSProperties = { marginLeft: 8 };

/** Values longer than this are cut until the user asks for the rest. */
const TRUNCATE_AT = 500;

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
 * order: each label escaped here, each raw value escaped at render time. Per-tool extras
 * (the byte size of `write_file` content) are added beside the fields,
 * never in place of them.
 */
function approvalArgs(tool: string, input: unknown): ReadonlyArray<ApprovalArg> {
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
      label: escapeForDisplay(humanize(key)),
      value: typeof value === "string" ? value : canonicalJson(value),
      truncatable: !neverTruncated(tool, key),
    });
  }
  return args;
}

function isTruncated(arg: ApprovalArg): boolean {
  return arg.truncatable && arg.value.length > TRUNCATE_AT;
}

/** Where to cut a raw value: never between the halves of a surrogate pair. */
function cutPoint(raw: string): number {
  const last = raw.charCodeAt(TRUNCATE_AT - 1);
  return last >= 0xd800 && last <= 0xdbff ? TRUNCATE_AT - 1 : TRUNCATE_AT;
}

function ArgValue({
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

/** The approval gate for one call: its fields, which long values are still unseen, and the Show All state. */
interface ApprovalReview {
  readonly args: ReadonlyArray<ApprovalArg>;
  /** Shortened values the user has not yet expanded. */
  readonly unseen: ReadonlyArray<ApprovalArg>;
  /** Allow stays off while this is true. */
  readonly blocked: boolean;
  /** The id of the reason text; point `aria-describedby` at it while blocked. */
  readonly reasonId: string;
  readonly showing: ReadonlySet<string>;
  toggle(key: string): void;
}

/** Tracks which shortened values are expanded and which have been seen; `blocked` clears once every one has been expanded. */
export function useApprovalReview(tool: string, input: unknown): ApprovalReview {
  const [showing, setShowing] = useState<ReadonlySet<string>>(new Set());
  const [seen, setSeen] = useState<ReadonlySet<string>>(new Set());
  const reasonId = useId();
  const args = approvalArgs(tool, input);
  const unseen = args.filter((arg) => isTruncated(arg) && !seen.has(arg.key));
  const toggle = (key: string): void => {
    setShowing((prev) =>
      prev.has(key) ? prev.difference(new Set([key])) : prev.union(new Set([key])),
    );
    setSeen((prev) => prev.union(new Set([key])));
  };
  return { args, unseen, blocked: unseen.length > 0, reasonId, showing, toggle };
}

/** Every field of the call as escaped, labelled data. */
export function ApprovalArgList({
  review,
}: {
  readonly review: ApprovalReview;
}): React.ReactElement {
  return (
    <dl style={argsStyle}>
      {review.args.map((arg) => (
        <Fragment key={arg.key}>
          <dt style={labelStyle}>{arg.label}</dt>
          <ArgValue
            arg={arg}
            showing={review.showing.has(arg.key)}
            onToggle={() => review.toggle(arg.key)}
          />
        </Fragment>
      ))}
    </dl>
  );
}

/** Why Allow is off; renders nothing once every shortened value has been expanded. */
export function ApprovalBlockedReason({
  review,
}: {
  readonly review: ApprovalReview;
}): React.ReactElement | null {
  if (!review.blocked) return null;
  return (
    <p id={review.reasonId} style={reasonStyle}>
      Allow is off until you have used Show All on every shortened value (
      {review.unseen.map((arg) => arg.label).join(", ")}).
    </p>
  );
}
