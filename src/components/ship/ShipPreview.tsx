import type { CSSProperties } from "react";
import { Pill, type PillTone } from "#components/ui/Pill";
import type { AiProseState } from "#hooks/useShip";
import {
  emptyRecordMessage,
  renderTruncationNote,
  resultLabel,
  turnStatusLabel,
} from "#lib/ship-causal";
import type { CausalTurn, ShipContext, ShipPreflight, StagingMode } from "#store/types";

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
  /** The causal record for this ship range — `null` while `ship_context` is still loading or failed (best-effort; never blocks the rest of the preview). */
  readonly context: ShipContext | null;
  readonly aiProse: string | null;
  readonly onAiProseChange: (prose: string) => void;
  readonly aiProseState: AiProseState;
  readonly onRegenerateProse: () => void;
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

// ── Causal Record (code-generated — see #lib/ship-causal) ────────────

const causalMutedStyle: CSSProperties = {
  fontFamily: "var(--font-body)",
  fontSize: "0.75rem",
  color: "oklch(0.55 0.04 220)",
  fontStyle: "italic",
};

const causalTableWrapStyle: CSSProperties = {
  maxHeight: 220,
  overflowY: "auto",
  border: "1px solid oklch(0.14 0.03 220)",
  borderRadius: 8,
};

const causalTableStyle: CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontFamily: "var(--font-mono)",
  fontSize: "0.6875rem",
};

const causalHeadCellStyle: CSSProperties = {
  textAlign: "left",
  padding: "6px 10px",
  color: "oklch(0.55 0.04 220)",
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  fontSize: "0.625rem",
  borderBottom: "1px solid oklch(0.14 0.03 220)",
  position: "sticky",
  top: 0,
  background: "oklch(0.06 0.02 220)",
};

const causalCellStyle: CSSProperties = {
  padding: "5px 10px",
  color: "oklch(0.82 0.04 220)",
  borderBottom: "1px solid oklch(0.11 0.02 220)",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  maxWidth: 220,
};

function resultTone(ok: boolean | null): PillTone {
  if (ok === true) return "success";
  if (ok === false) return "danger";
  return "neutral";
}

/** Every tool call across every turn, flattened into `{ turnLabel, name, target, ok }` rows for the table — one DOM row per call, matching `renderCausalRecordSection`'s markdown table shape. */
function causalTableRows(
  turns: readonly CausalTurn[],
): Array<{ key: string; turnLabel: string; name: string; target: string; ok: boolean | null }> {
  const rows: Array<{
    key: string;
    turnLabel: string;
    name: string;
    target: string;
    ok: boolean | null;
  }> = [];
  turns.forEach((turn, turnIndex) => {
    const turnLabel = `${turnIndex + 1} (${turnStatusLabel(turn.status)})`;
    turn.toolCalls.forEach((call, callIndex) => {
      rows.push({
        key: `${turn.turnId}-${callIndex}`,
        turnLabel,
        name: call.name,
        target: call.target ?? "—",
        ok: call.ok,
      });
    });
  });
  return rows;
}

interface CausalRecordSectionProps {
  readonly context: ShipContext | null;
}

/**
 * The deterministic, code-generated Causal Record: seq range, turn
 * count, and a tool-call table (turn, tool, target, result) read
 * directly off `ShipContext` — no free text rendered here, matching
 * `#lib/ship-causal`'s `renderCausalRecordSection` (the markdown
 * counterpart that actually ships in the PR body — both share
 * `emptyRecordMessage`/`renderTruncationNote` so the two never drift on
 * wording). `context == null` (still loading, or `ship_context` failed)
 * and a genuinely empty range both render an honest muted message rather
 * than a table — the two are visually distinct so a user isn't left
 * wondering whether "no rows" means "still loading" or "nothing was
 * recorded". A genuinely empty range further distinguishes "this worker
 * did nothing" from "this worker's activity used the webview chat path,
 * invisible to this query" (`emptyRecordMessage`, review NIT-4) — never
 * one message papering over both.
 */
function CausalRecordSection({ context }: CausalRecordSectionProps): React.ReactElement {
  if (context == null) {
    return <span style={causalMutedStyle}>Loading Causal Record…</span>;
  }

  if (context.turns.length === 0) {
    return <span style={causalMutedStyle}>{emptyRecordMessage(context)}</span>;
  }

  const rows = causalTableRows(context.turns);
  const truncationNote = renderTruncationNote(context);

  return (
    <>
      <div style={monoRowStyle}>
        <span>
          {context.seqFrom}..{context.seqTo}
        </span>
        <span style={{ color: "oklch(0.45 0.03 220)" }}>{"·"}</span>
        <span>
          {context.turns.length} Turn{context.turns.length === 1 ? "" : "s"}
        </span>
      </div>
      {truncationNote != null && <span style={causalMutedStyle}>{truncationNote}</span>}
      {rows.length > 0 && (
        <div style={causalTableWrapStyle}>
          <table style={causalTableStyle}>
            <thead>
              <tr>
                <th style={causalHeadCellStyle}>Turn</th>
                <th style={causalHeadCellStyle}>Tool</th>
                <th style={causalHeadCellStyle}>Target</th>
                <th style={causalHeadCellStyle}>Result</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.key}>
                  <td style={causalCellStyle}>{row.turnLabel}</td>
                  <td style={causalCellStyle}>{row.name}</td>
                  <td style={{ ...causalCellStyle, maxWidth: 260 }} title={row.target}>
                    {row.target}
                  </td>
                  <td style={causalCellStyle}>
                    <Pill tone={resultTone(row.ok)} size="sm">
                      {resultLabel(row.ok)}
                    </Pill>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
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
  context,
  aiProse,
  onAiProseChange,
  aiProseState,
  onRegenerateProse,
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

      <div style={sectionStyle}>
        <span style={labelStyle}>What Changed / Why (AI-Generated, Editable)</span>
        <textarea
          value={aiProse ?? ""}
          onChange={(e) => onAiProseChange(e.target.value)}
          style={textareaStyle}
          aria-label="AI-Generated Pull Request Description"
          spellCheck={true}
          placeholder="Click Generate To Draft A Summary From The Causal Record Below — Optional, Editable, Never Required To Ship."
        />
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Pill
            interactive
            tone="neutral"
            size="sm"
            disabled={aiProseState === "generating" || context == null}
            onClick={onRegenerateProse}
          >
            {aiProseState === "generating"
              ? "Generating…"
              : aiProse != null
                ? "Regenerate"
                : "Generate"}
          </Pill>
          {aiProseState === "failed" && (
            <span style={actionReasonStyle}>
              Generation Failed — Shipping With The Causal Record Alone Still Works.
            </span>
          )}
        </div>
      </div>

      <div style={sectionStyle}>
        <span style={labelStyle}>Causal Record</span>
        <CausalRecordSection context={context} />
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
