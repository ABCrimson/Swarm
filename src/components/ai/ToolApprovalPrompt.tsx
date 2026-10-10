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
  "\n": "\\n",
  "\r": "\\r",
  "\t": "\\t",
};

/**
 * Makes a model-controlled string safe to show: newlines, carriage
 * returns and tabs become `\n`, `\r`, `\t`; every other control,
 * bidi-override or zero-width character becomes a visible `\uXXXX`.
 */
function escapeForDisplay(value: string): string {
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

interface ApprovalArg {
  readonly label: string;
  readonly value: string;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}

/** The exact arguments of a call, as labelled raw values (escaped at render time). */
function approvalArgs(tool: string, input: unknown): ReadonlyArray<ApprovalArg> {
  const args: Record<string, unknown> =
    typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
  switch (tool) {
    case "write_file": {
      const content = text(args["content"]);
      return [
        { label: "Path", value: text(args["path"]) },
        { label: "Size", value: `${new TextEncoder().encode(content).length} bytes` },
        { label: "Content", value: content },
      ];
    }
    case "run_command":
      return [
        { label: "Worker", value: text(args["workerId"]) },
        { label: "Command", value: text(args["command"]) },
      ];
    case "read_file":
      return [
        { label: "Path", value: text(args["path"]) },
        ...(args["maxLines"] === undefined
          ? []
          : [{ label: "Max Lines", value: text(args["maxLines"]) }]),
      ];
    case "spawn_worker":
      return [{ label: "Name", value: text(args["name"]) }];
    case "kill_worker":
      return [{ label: "Worker", value: text(args["workerId"]) }];
    default:
      return Object.entries(args).map(([label, value]) => ({ label, value: text(value) }));
  }
}

function ArgValue({ value }: { readonly value: string }): React.ReactElement {
  const [showAll, setShowAll] = useState(false);
  const escaped = escapeForDisplay(value);
  const long = escaped.length > TRUNCATE_AT;
  return (
    <dd style={valueStyle}>
      {long && !showAll ? `${escaped.slice(0, TRUNCATE_AT)}...` : escaped}
      {long && (
        <Button
          size="sm"
          variant="secondary"
          style={showAllStyle}
          onClick={() => setShowAll(!showAll)}
        >
          {showAll ? "Show Less" : "Show All"}
        </Button>
      )}
    </dd>
  );
}

function ApprovalRow({ request }: { readonly request: ToolApprovalRequest }): React.ReactElement {
  return (
    <fieldset aria-label={`Approve ${request.tool}`} style={rowStyle}>
      <div style={headingStyle}>
        <strong>{request.tool}</strong>
      </div>
      <dl style={argsStyle}>
        {approvalArgs(request.tool, request.input).map((arg) => (
          <Fragment key={arg.label}>
            <dt style={labelStyle}>{arg.label}</dt>
            <ArgValue value={arg.value} />
          </Fragment>
        ))}
      </dl>
      <div style={actionsStyle}>
        <Button size="sm" variant="primary" onClick={() => resolveToolApproval(request.id, "once")}>
          Allow Once
        </Button>
        {request.sessionAllowed && (
          <Button
            size="sm"
            variant="secondary"
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
 * each showing the tool and its exact arguments as escaped data (never
 * prose built from model strings). Shows the calls made by
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
