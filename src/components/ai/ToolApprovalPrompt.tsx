import type { CSSProperties } from "react";
import { Fragment, useState, useSyncExternalStore } from "react";
import { Button } from "#components/ui/Button";
import {
  getPendingToolApprovals,
  resolveToolApproval,
  subscribeToolApprovals,
  type ToolApprovalRequest,
} from "#lib/tools";

const promptListStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 8,
  padding: "10px 16px",
  borderTop: "1px solid oklch(0.45 0.12 75)",
  background: "oklch(0.14 0.04 75 / 0.6)",
};

const headingStyle: CSSProperties = {
  fontSize: 13,
  lineHeight: 1.5,
  color: "oklch(0.88 0.03 220)",
};

const argsStyle: CSSProperties = {
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

const labelStyle: CSSProperties = { margin: 0, color: "oklch(0.7 0.04 220)" };

const valueStyle: CSSProperties = { margin: 0 };

const reasonStyle: CSSProperties = {
  margin: "6px 0 0",
  fontSize: 12,
  color: "oklch(0.78 0.1 75)",
};

const showAllStyle: CSSProperties = { marginLeft: 8 };

const rowStyle: CSSProperties = { border: 0, margin: 0, padding: 0, minWidth: 0 };

const actionsStyle: CSSProperties = { display: "flex", flexWrap: "wrap", gap: 8, marginTop: 6 };

/** Values longer than this are cut until the user asks for the rest. */
const TRUNCATE_AT = 500;

/** Control, bidi and zero-width ranges that must never reach the screen raw. */
const INVISIBLE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0000, 0x001f],
  [0x007f, 0x009f],
  [0x061c, 0x061c],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x2069],
  [0xfeff, 0xfeff],
];

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
 * bidi-override or zero-width character becomes a visible `\uXXXX`.
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
    else if (INVISIBLE_RANGES.some(([from, to]) => code >= from && code <= to)) {
      out += `\\u${code.toString(16).toUpperCase().padStart(4, "0")}`;
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

/** Commands and file paths are always shown whole. */
function neverTruncated(tool: string, key: string): boolean {
  return /path/i.test(key) || (tool === "run_command" && key === "command");
}

/**
 * Every field of the validated input that will execute, in parsed key
 * order, as raw labelled values (escaped at render time). Per-tool extras
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
      label: humanize(key),
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

function ApprovalRow({ request }: { readonly request: ToolApprovalRequest }): React.ReactElement {
  const [showing, setShowing] = useState<ReadonlySet<string>>(new Set());
  const [seen, setSeen] = useState<ReadonlySet<string>>(new Set());
  const args = approvalArgs(request.tool, request.input);
  const unseen = args.filter((arg) => isTruncated(arg) && !seen.has(arg.key));
  const blocked = unseen.length > 0;
  const reasonId = `approval-${request.id}-reason`;
  const toggle = (key: string): void => {
    setShowing((prev) =>
      prev.has(key) ? prev.difference(new Set([key])) : prev.union(new Set([key])),
    );
    setSeen((prev) => prev.union(new Set([key])));
  };
  return (
    <fieldset aria-label={`Approve ${request.tool}`} style={rowStyle}>
      <div style={headingStyle}>
        <strong>{request.tool}</strong>
      </div>
      <dl style={argsStyle}>
        {args.map((arg) => (
          <Fragment key={arg.key}>
            <dt style={labelStyle}>{arg.label}</dt>
            <ArgValue arg={arg} showing={showing.has(arg.key)} onToggle={() => toggle(arg.key)} />
          </Fragment>
        ))}
      </dl>
      {blocked && (
        <p id={reasonId} style={reasonStyle}>
          Allow is off until you have used Show All on every shortened value (
          {unseen.map((arg) => arg.label).join(", ")}).
        </p>
      )}
      <div style={actionsStyle}>
        <Button
          size="sm"
          variant="primary"
          disabled={blocked}
          aria-describedby={blocked ? reasonId : undefined}
          onClick={() => resolveToolApproval(request.id, "once")}
        >
          Allow Once
        </Button>
        {request.sessionAllowed && (
          <Button
            size="sm"
            variant="secondary"
            disabled={blocked}
            aria-describedby={blocked ? reasonId : undefined}
            onClick={() => resolveToolApproval(request.id, "session")}
          >
            Allow For Session
          </Button>
        )}
        <Button size="sm" variant="danger" onClick={() => resolveToolApproval(request.id, "deny")}>
          Deny
        </Button>
      </div>
    </fieldset>
  );
}

/**
 * The approval prompt for the AI tools that act on the user's machine
 * (`run_command`, `spawn_worker`, `kill_worker`, `write_file`,
 * `read_file`): one row per call waiting for an answer, oldest first,
 * each showing the tool and every field of its validated input as
 * escaped data (never prose built from model strings). A long value is
 * cut with a count of what is hidden; commands and file paths never are.
 * Allow Once and Allow For Session stay off until each cut value has been
 * expanded once; Deny is always available. Shows the calls made by
 * `workerId`'s turn (and any whose worker is unknown). The tool loop
 * stays paused until each row is answered, so the region is an alert.
 * Renders nothing when no call is waiting.
 */
export function ToolApprovalPrompt({
  workerId,
}: {
  readonly workerId: string;
}): React.ReactElement | null {
  const pending = useSyncExternalStore(subscribeToolApprovals, getPendingToolApprovals);
  const mine = pending.filter(
    (request) => request.workerId === undefined || request.workerId === workerId,
  );
  if (mine.length === 0) return null;
  return (
    <div role="alert" aria-label="Tool Approval" style={promptListStyle}>
      {mine.map((request) => (
        <ApprovalRow key={request.id} request={request} />
      ))}
    </div>
  );
}
