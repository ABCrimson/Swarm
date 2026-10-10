import type { CSSProperties } from "react";
import { useSyncExternalStore } from "react";
import { Button } from "#components/ui/Button";
import {
  type ApprovalChoice,
  getPendingToolApprovals,
  resolveToolApproval,
  subscribeToolApprovals,
  type ToolApprovalRequest,
} from "#lib/tools";
import { ApprovalArgList, ApprovalBlockedReason, useApprovalReview } from "./ApprovalArgs.tsx";

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

function ApprovalRow({
  request,
  onResolved,
}: {
  readonly request: ToolApprovalRequest;
  readonly onResolved?: () => void;
}): React.ReactElement {
  const review = useApprovalReview(request.tool, request.input);
  // Answering removes this row, so a focused button would drop focus to <body>; hand it back to the chat.
  const answer = (choice: ApprovalChoice, button: HTMLButtonElement): void => {
    const hadFocus = document.activeElement === button;
    resolveToolApproval(request.id, choice);
    if (hadFocus) onResolved?.();
  };
  return (
    <fieldset aria-label={`Approve ${request.tool}`} style={rowStyle}>
      <div style={headingStyle}>
        <strong>{request.tool}</strong>
      </div>
      <ApprovalArgList review={review} />
      <ApprovalBlockedReason review={review} />
      <div style={actionsStyle}>
        <Button
          size="sm"
          variant="primary"
          disabled={review.blocked}
          aria-describedby={review.blocked ? review.reasonId : undefined}
          onClick={(e) => answer("once", e.currentTarget)}
        >
          Allow Once
        </Button>
        {request.sessionAllowed && (
          <Button
            size="sm"
            variant="secondary"
            disabled={review.blocked}
            aria-describedby={review.blocked ? review.reasonId : undefined}
            onClick={(e) => answer("session", e.currentTarget)}
          >
            Allow For Session
          </Button>
        )}
        <Button size="sm" variant="danger" onClick={(e) => answer("deny", e.currentTarget)}>
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
 * expanded once; Deny is always available. An answer given from a focused
 * button calls `onResolved`, which moves focus off the row before it unmounts. Shows the calls made by
 * `workerId`'s turn (and any whose worker is unknown). The tool loop
 * stays paused until each row is answered, so the region is an alert.
 * Renders nothing when no call is waiting.
 */
export function ToolApprovalPrompt({
  workerId,
  onResolved,
}: {
  readonly workerId: string;
  /** Called after a call is answered from a focused button, so the caller can take keyboard focus. */
  readonly onResolved?: () => void;
}): React.ReactElement | null {
  const pending = useSyncExternalStore(subscribeToolApprovals, getPendingToolApprovals);
  const mine = pending.filter(
    (request) => request.workerId === undefined || request.workerId === workerId,
  );
  if (mine.length === 0) return null;
  return (
    <div role="alert" aria-label="Tool Approval" style={promptListStyle}>
      {mine.map((request) => (
        <ApprovalRow key={request.id} request={request} onResolved={onResolved} />
      ))}
    </div>
  );
}
