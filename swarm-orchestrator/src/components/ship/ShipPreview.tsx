import type { CSSProperties } from "react";
import { Pill } from "#components/ui/Pill";
import type { ShipPreflight, StagingMode } from "#store/types";

interface ShipPreviewProps {
  readonly preflight: ShipPreflight;
  readonly message: string;
  readonly onMessageChange: (message: string) => void;
  readonly mode: StagingMode;
  readonly onModeChange: (mode: StagingMode) => void;
  readonly busy: boolean;
  readonly onCommitOnly: () => void;
  readonly onCommitAndPush: () => void;
  readonly onCommitPushAndOpenCompare: () => void;
}

const sectionStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
};

const labelStyle: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "0.6875rem",
  color: "oklch(0.55 0.04 220)",
  textTransform: "uppercase",
  letterSpacing: "0.08em",
};

const monoRowStyle: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "0.75rem",
  color: "oklch(0.82 0.04 220)",
  display: "flex",
  alignItems: "center",
  gap: 6,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const fileListStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  maxHeight: 180,
  overflowY: "auto",
  fontFamily: "var(--font-mono)",
  fontSize: "0.6875rem",
  padding: "8px 10px",
  background: "oklch(0.06 0.02 220)",
  border: "1px solid oklch(0.14 0.03 220)",
  borderRadius: 8,
};

const textareaStyle: CSSProperties = {
  width: "100%",
  minHeight: 140,
  padding: "10px 12px",
  borderRadius: 8,
  border: "1px solid oklch(0.28 0.05 220)",
  background: "oklch(0.08 0.02 220)",
  color: "oklch(0.88 0.03 220)",
  fontFamily: "var(--font-mono)",
  fontSize: "0.75rem",
  lineHeight: 1.5,
  resize: "vertical",
  outline: "none",
  boxSizing: "border-box",
};

const trailerNoteStyle: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "0.625rem",
  color: "oklch(0.50 0.04 220)",
};

const blockerListStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  padding: "10px 12px",
  borderRadius: 8,
  background: "oklch(0.68 0.20 25 / 0.10)",
  border: "1px solid oklch(0.68 0.20 25 / 0.3)",
};

const blockerItemStyle: CSSProperties = {
  fontFamily: "var(--font-body)",
  fontSize: "0.75rem",
  color: "oklch(0.80 0.15 25)",
};

const actionsStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
};

const actionGroupStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 2,
};

const actionPlanStyle: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "0.625rem",
  color: "oklch(0.50 0.04 220)",
  padding: "0 2px",
};

const actionReasonStyle: CSSProperties = {
  fontFamily: "var(--font-body)",
  fontSize: "0.625rem",
  color: "oklch(0.60 0.10 70)",
  padding: "0 2px",
};

/** Deduplicated union of `staged`/`unstaged`/`untracked` paths, annotated with each file's skip reason (if any). */
function buildFileRows(preflight: ShipPreflight): Array<{ path: string; reason: string | null }> {
  const skipped = new Map(preflight.skipped.map((s) => [s.path, s.reason]));
  const seen = new Set<string>();
  const rows: Array<{ path: string; reason: string | null }> = [];
  for (const path of [...preflight.staged, ...preflight.unstaged, ...preflight.untracked]) {
    if (seen.has(path)) continue;
    seen.add(path);
    rows.push({ path, reason: skipped.get(path) ?? null });
  }
  return rows;
}

/**
 * The literal, non-abbreviated argv sequence a *specific* action will
 * run — never a blanket plan shared across all three buttons, so
 * "Commit Only" never shows a `git push` line it isn't about to
 * execute (DIRECTIVE F4).
 */
function commandPlanFor(mode: StagingMode, includePush: boolean, includeCompare: boolean): string {
  const steps =
    mode === "all" ? ["git add -- <files>", "git commit"] : ["git commit (already-staged index)"];
  if (includePush) steps.push("git push -u origin <branch>");
  if (includeCompare) steps.push("open compare page");
  return `Will Run: ${steps.join(" · ")}`;
}

/**
 * The confirm step of the ship flow: branch/base/remote summary,
 * ahead/behind, diff stat + per-file rows (including Skipped), the
 * editable commit message, and the three ship actions — each labeled
 * with its own literal command plan. Commit Only / Commit + Push are
 * disabled until `preflight.canShip`, the message is non-empty, and
 * not `busy`; the compare action additionally requires
 * `preflight.hostSupportsCompare` (DIRECTIVE F7 — a non-GitHub remote
 * disables *only* that one action, never the other two).
 */
export function ShipPreview({
  preflight,
  message,
  onMessageChange,
  mode,
  onModeChange,
  busy,
  onCommitOnly,
  onCommitAndPush,
  onCommitPushAndOpenCompare,
}: ShipPreviewProps): React.ReactElement {
  const fileRows = buildFileRows(preflight);
  const messageEmpty = message.trim().length === 0;
  const disabled = !preflight.canShip || busy || messageEmpty;
  const compareDisabled = disabled || !preflight.hostSupportsCompare;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, padding: 16 }}>
      {preflight.blockers.length > 0 && (
        <div style={blockerListStyle} role="alert">
          {preflight.blockers.map((blocker) => (
            <span key={blocker} style={blockerItemStyle}>
              {blocker}
            </span>
          ))}
        </div>
      )}

      <div style={sectionStyle}>
        <span style={labelStyle}>Branch</span>
        <div style={monoRowStyle}>
          <Pill tone="info" size="sm">
            {preflight.branch}
          </Pill>
          <span style={{ color: "oklch(0.45 0.03 220)" }}>{"→"}</span>
          <span>{preflight.baseBranch}</span>
          {preflight.remote != null && (
            <>
              <span style={{ color: "oklch(0.45 0.03 220)" }}>{"·"}</span>
              <span title={preflight.remote}>{preflight.host ?? preflight.remote}</span>
            </>
          )}
          {preflight.ahead > 0 && (
            <Pill tone="warning" size="sm">
              {preflight.ahead === 1 ? "1 Unpushed Commit" : `${preflight.ahead} Unpushed Commits`}
            </Pill>
          )}
          {preflight.behind > 0 && (
            <Pill tone="danger" size="sm">
              {preflight.behind === 1 ? "1 Commit Behind" : `${preflight.behind} Commits Behind`}
            </Pill>
          )}
        </div>
      </div>

      <div style={sectionStyle}>
        <span style={labelStyle}>Changes</span>
        <div style={monoRowStyle}>
          <span>{preflight.diffStat.filesChanged} File(s)</span>
          <span
            style={{ color: "oklch(0.75 0.16 150)" }}
          >{`+${preflight.diffStat.insertions}`}</span>
          <span style={{ color: "oklch(0.68 0.20 25)" }}>{`-${preflight.diffStat.deletions}`}</span>
        </div>
        {fileRows.length > 0 && (
          <div style={fileListStyle}>
            {fileRows.map((row) => (
              <div
                key={row.path}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  gap: 8,
                  color: row.reason != null ? "oklch(0.60 0.10 70)" : "oklch(0.80 0.03 220)",
                }}
              >
                <span
                  style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                  title={row.path}
                >
                  {row.path}
                </span>
                {row.reason != null && <span>{row.reason}</span>}
              </div>
            ))}
          </div>
        )}
      </div>

      {preflight.staged.length > 0 && (
        <div style={sectionStyle}>
          <span style={labelStyle}>Staging Mode</span>
          <div style={{ display: "flex", gap: 8 }}>
            <Pill
              interactive
              tone={mode === "all" ? "info" : "neutral"}
              size="sm"
              onClick={() => onModeChange("all")}
              aria-pressed={mode === "all"}
            >
              All Changes
            </Pill>
            <Pill
              interactive
              tone={mode === "staged" ? "info" : "neutral"}
              size="sm"
              onClick={() => onModeChange("staged")}
              aria-pressed={mode === "staged"}
            >
              Already Staged
            </Pill>
          </div>
        </div>
      )}

      <div style={sectionStyle}>
        <span style={labelStyle}>Commit Message</span>
        <textarea
          value={message}
          onChange={(e) => onMessageChange(e.target.value)}
          style={textareaStyle}
          aria-label="Commit Message"
          spellCheck={false}
        />
        <span style={trailerNoteStyle}>
          Trailers Added Automatically: Swarm-Seq-Range (When Determinable), Co-Authored-By (When
          Configured)
        </span>
      </div>

      <div style={actionsStyle}>
        <div style={actionGroupStyle}>
          <Pill interactive tone="neutral" size="md" disabled={disabled} onClick={onCommitOnly}>
            Commit Only
          </Pill>
          <span style={actionPlanStyle}>{commandPlanFor(mode, false, false)}</span>
        </div>
        <div style={actionGroupStyle}>
          <Pill interactive tone="info" size="md" disabled={disabled} onClick={onCommitAndPush}>
            Commit + Push
          </Pill>
          <span style={actionPlanStyle}>{commandPlanFor(mode, true, false)}</span>
        </div>
        <div style={actionGroupStyle}>
          <Pill
            interactive
            tone="success"
            size="md"
            disabled={compareDisabled}
            onClick={onCommitPushAndOpenCompare}
          >
            Commit + Push + Open Compare Page
          </Pill>
          {preflight.hostSupportsCompare ? (
            <span style={actionPlanStyle}>{commandPlanFor(mode, true, true)}</span>
          ) : (
            <span style={actionReasonStyle}>Compare Links Require A GitHub Remote</span>
          )}
        </div>
      </div>
    </div>
  );
}
