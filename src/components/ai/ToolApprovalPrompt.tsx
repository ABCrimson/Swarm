import type { CSSProperties } from "react";
import { useSyncExternalStore } from "react";
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

const summaryStyle: CSSProperties = {
  fontSize: 13,
  lineHeight: 1.5,
  color: "oklch(0.88 0.03 220)",
  overflowWrap: "anywhere",
};

const rowStyle: CSSProperties = { border: 0, margin: 0, padding: 0, minWidth: 0 };

const actionsStyle: CSSProperties = { display: "flex", flexWrap: "wrap", gap: 8, marginTop: 6 };

function ApprovalRow({ request }: { readonly request: ToolApprovalRequest }): React.ReactElement {
  return (
    <fieldset aria-label={`Approve ${request.tool}`} style={rowStyle}>
      <div style={summaryStyle}>
        <strong>{request.tool}</strong>: {request.summary}
      </div>
      <div style={actionsStyle}>
        <Button size="sm" variant="primary" onClick={() => resolveToolApproval(request.id, "once")}>
          Allow Once
        </Button>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => resolveToolApproval(request.id, "session")}
        >
          Allow For Session
        </Button>
        <Button size="sm" variant="danger" onClick={() => resolveToolApproval(request.id, "deny")}>
          Deny
        </Button>
      </div>
    </fieldset>
  );
}

/**
 * The approval prompt for the AI tools that act on the user's machine
 * (`run_command`, `spawn_worker`, `write_file`, `read_file`): one row per
 * call waiting for an answer, oldest first. Shows the calls made by
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
