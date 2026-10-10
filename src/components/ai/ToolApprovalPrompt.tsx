import type { CSSProperties } from "react";
import { Fragment, useState, useSyncExternalStore } from "react";
import { Button } from "#components/ui/Button";
import {
  getPendingToolApprovals,
  resolveToolApproval,
  subscribeToolApprovals,
  type ToolApprovalRequest,
} from "#lib/tools";
import {
  ArgValue,
  approvalArgs,
  argsStyle,
  isTruncated,
  labelStyle,
  reasonStyle,
} from "./ApprovalArgs.tsx";

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

const rowStyle: CSSProperties = { border: 0, margin: 0, padding: 0, minWidth: 0 };

const actionsStyle: CSSProperties = { display: "flex", flexWrap: "wrap", gap: 8, marginTop: 6 };

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
