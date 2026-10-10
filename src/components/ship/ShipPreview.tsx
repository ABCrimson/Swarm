import { type CSSProperties, useId } from "react";
import { escapeForDisplay } from "#components/ai/ApprovalArgs";
import { Pill, type PillTone } from "#components/ui/Pill";
import type { AiProseState, ShipContextState } from "#hooks/useShip";
import { pluralize } from "#lib/format";
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
  readonly onCommitOnly: () => void;
  readonly onCommitAndPush: () => void;
  readonly onCommitPushAndOpenCompare: () => void;
  /** The causal record for this ship range — `null` until `contextState` is `"ready"` (best-effort; never blocks the rest of the preview). */
  readonly context: ShipContext | null;
  readonly contextState: ShipContextState;
  readonly onRetryContext: () => void;
  readonly aiProse: string | null;
  readonly onAiProseChange: (prose: string) => void;
  readonly aiProseState: AiProseState;
  /** Why the last generation failed, appended to the failure line; `null` when unknown. */
  readonly aiProseError: string | null;
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
  color: "var(--color-text-dim)",
  textTransform: "uppercase",
  letterSpacing: "0.08em",
};

const monoRowStyle: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "0.75rem",
  color: "var(--color-text)",
  display: "flex",
  alignItems: "center",
  gap: 6,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const separatorStyle: CSSProperties = { color: "oklch(0.45 0.03 220)" };

const fileListStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  maxHeight: 180,
  overflowY: "auto",
  fontFamily: "var(--font-mono)",
  fontSize: "0.6875rem",
  padding: "8px 10px",
  background: "var(--color-void)",
  border: "1px solid oklch(0.14 0.03 220)",
  borderRadius: 8,
};

/**
 * Layout for the two multi-line fields. Everything else (surface, border,
 * text color, the focus ring) comes from the house `.swarm-input` class,
 * so these fields get the same keyboard focus indicator as every other
 * input — no inline `outline` override.
 */
const textareaStyle: CSSProperties = {
  height: "auto",
  minHeight: 140,
  padding: "10px 12px",
  fontFamily: "var(--font-mono)",
  fontSize: "0.75rem",
  lineHeight: 1.5,
  resize: "vertical",
};

const trailerNoteStyle: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "0.625rem",
  color: "var(--color-fg-dim)",
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
  color: "var(--color-fg-dim)",
  padding: "0 2px",
};

const actionReasonStyle: CSSProperties = {
  fontFamily: "var(--font-body)",
  fontSize: "0.625rem",
  color: "oklch(0.60 0.10 70)",
  padding: "0 2px",
};

interface FileRow {
  readonly path: string;
  readonly reason: string | null;
}

/** Deduplicated union of `staged`/`unstaged`/`untracked` paths, annotated with each file's skip reason (if any). */
function buildFileRows(preflight: ShipPreflight): FileRow[] {
  const skipped = new Map(preflight.skipped.map((s) => [s.path, s.reason]));
  const paths = new Set([...preflight.staged, ...preflight.unstaged, ...preflight.untracked]);
  return [...paths].map((path) => ({ path, reason: skipped.get(path) ?? null }));
}

/**
 * The literal argv sequence one *specific* action will run — never a
 * blanket plan shared across all three buttons, so "Commit Only" never
 * shows a `git push` line it isn't about to execute.
 */
function commandPlanFor(mode: StagingMode, includePush: boolean, includeCompare: boolean): string {
  const steps =
    mode === "all" ? ["git add -- <files>", "git commit"] : ["git commit (Already-Staged Index)"];
  if (includePush) steps.push("git push -u origin <branch>");
  if (includeCompare) steps.push("Open Compare Page");
  return `Will Run: ${steps.join(" · ")}`;
}

// ── Causal Record (code-generated — see #lib/ship-causal) ────────────

const causalMutedStyle: CSSProperties = {
  fontFamily: "var(--font-body)",
  fontSize: "0.75rem",
  color: "var(--color-text-dim)",
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
  color: "var(--color-text-dim)",
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  fontSize: "0.625rem",
  borderBottom: "1px solid oklch(0.14 0.03 220)",
  position: "sticky",
  top: 0,
  background: "var(--color-void)",
};

const causalCellStyle: CSSProperties = {
  padding: "5px 10px",
  color: "var(--color-text)",
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

interface CausalTableRow {
  readonly key: string;
  readonly turnLabel: string;
  readonly name: string;
  readonly target: string;
  readonly ok: boolean | null;
}

/** Every tool call across every turn, one row per call — the same shape as `renderCausalRecordSection`'s markdown table. */
function causalTableRows(turns: readonly CausalTurn[]): CausalTableRow[] {
  return turns.flatMap((turn, turnIndex) => {
    const turnLabel = `${turnIndex + 1} (${turnStatusLabel(turn.status)})`;
    return turn.toolCalls.map((call, callIndex) => ({
      key: `${turn.turnId}-${callIndex}`,
      turnLabel,
      name: call.name,
      target: call.target ?? "—",
      ok: call.ok,
    }));
  });
}

interface CausalRecordSectionProps {
  readonly context: ShipContext | null;
  readonly contextState: ShipContextState;
  readonly onRetry: () => void;
}

/**
 * The deterministic, code-generated Causal Record: seq range, turn
 * count, and a tool-call table (turn, tool, target, result) read
 * directly off `ShipContext` — no free text rendered here, matching
 * `#lib/ship-causal`'s `renderCausalRecordSection` (the markdown
 * counterpart that actually ships in the PR body — both share
 * `emptyRecordMessage`/`renderTruncationNote` so the two never drift on
 * wording). Loading, a failed load (with a retry) and a genuinely empty
 * range each render their own message, so "no rows" never leaves a user
 * wondering whether the record is still coming, could not be read, or
 * holds nothing. A genuinely empty range further distinguishes "this
 * worker did nothing" from "this worker's activity used the webview chat
 * path, invisible to this query" (`emptyRecordMessage`, review NIT-4).
 */
function CausalRecordSection({
  context,
  contextState,
  onRetry,
}: CausalRecordSectionProps): React.ReactElement {
  if (contextState === "failed") {
    return (
      <div className="flex items-center gap-2">
        <span role="alert" style={causalMutedStyle}>
          Causal Record Could Not Be Loaded.
        </span>
        <Pill interactive tone="neutral" size="sm" onClick={onRetry}>
          Retry
        </Pill>
      </div>
    );
  }

  if (context == null) {
    return (
      <span role="status" style={causalMutedStyle}>
        Loading Causal Record…
      </span>
    );
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
        <span style={separatorStyle}>{"·"}</span>
        <span>{pluralize("Turn", context.turns.length)}</span>
      </div>
      {truncationNote != null && <span style={causalMutedStyle}>{truncationNote}</span>}
      {rows.length > 0 && (
        <section
          aria-label="Causal Record Tool Calls"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be keyboard-focusable so it can be scrolled without a mouse (WCAG 2.1.1).
          tabIndex={0}
          style={causalTableWrapStyle}
        >
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
        </section>
      )}
    </>
  );
}

/**
 * The confirm step of the ship flow: branch/base/remote summary,
 * ahead/behind, diff stat + per-file rows (including Skipped), the
 * editable commit message, and the three ship actions — each labeled
 * with its own literal command plan. Commit Only / Commit + Push are
 * disabled until `preflight.canShip` and the message is non-empty; the
 * compare action additionally requires `preflight.hostSupportsCompare`
 * — a non-GitHub remote disables *only* that one action, since the
 * other two never need a compare URL.
 */
export function ShipPreview({
  preflight,
  message,
  onMessageChange,
  mode,
  onModeChange,
  onCommitOnly,
  onCommitAndPush,
  onCommitPushAndOpenCompare,
  context,
  contextState,
  onRetryContext,
  aiProse,
  onAiProseChange,
  aiProseState,
  aiProseError,
  onRegenerateProse,
}: ShipPreviewProps): React.ReactElement {
  const messageId = useId();
  const proseId = useId();
  const fileRows = buildFileRows(preflight);
  const disabled = !preflight.canShip || message.trim() === "";
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
            {escapeForDisplay(preflight.branch)}
          </Pill>
          <span style={separatorStyle}>{"→"}</span>
          <span>{escapeForDisplay(preflight.baseBranch)}</span>
          {preflight.remote != null && (
            <>
              <span style={separatorStyle}>{"·"}</span>
              <span title={escapeForDisplay(preflight.remote)}>
                {escapeForDisplay(preflight.host ?? preflight.remote)}
              </span>
            </>
          )}
          {preflight.ahead > 0 && (
            <Pill tone="warning" size="sm">
              {pluralize("Unpushed Commit", preflight.ahead)}
            </Pill>
          )}
          {preflight.behind > 0 && (
            <Pill tone="danger" size="sm">
              {`${pluralize("Commit", preflight.behind)} Behind`}
            </Pill>
          )}
        </div>
      </div>

      <div style={sectionStyle}>
        <span style={labelStyle}>Changes</span>
        <div style={monoRowStyle}>
          <span>{pluralize("File", preflight.diffStat.filesChanged)}</span>
          <span style={{ color: "oklch(0.75 0.16 150)" }}>
            {`+${preflight.diffStat.insertions}`}
          </span>
          <span style={{ color: "oklch(0.68 0.20 25)" }}>{`-${preflight.diffStat.deletions}`}</span>
        </div>
        {fileRows.length > 0 && (
          <ul
            style={{ ...fileListStyle, listStyle: "none", margin: 0 }}
            aria-label="Changed Files"
            // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be keyboard-focusable so it can be scrolled without a mouse (WCAG 2.1.1).
            tabIndex={0}
          >
            {fileRows.map((row) => (
              <li
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
                  title={escapeForDisplay(row.path)}
                >
                  {escapeForDisplay(row.path)}
                </span>
                {row.reason != null && <span>{row.reason}</span>}
              </li>
            ))}
          </ul>
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
              {mode === "all" && <span aria-hidden="true">✓ </span>}
              All Changes
            </Pill>
            <Pill
              interactive
              tone={mode === "staged" ? "info" : "neutral"}
              size="sm"
              onClick={() => onModeChange("staged")}
              aria-pressed={mode === "staged"}
            >
              {mode === "staged" && <span aria-hidden="true">✓ </span>}
              Already Staged
            </Pill>
          </div>
        </div>
      )}

      <div style={sectionStyle}>
        <label htmlFor={messageId} style={labelStyle}>
          Commit Message
        </label>
        <textarea
          id={messageId}
          className="swarm-input"
          value={message}
          onChange={(e) => onMessageChange(e.target.value)}
          style={textareaStyle}
          spellCheck={false}
        />
        <span style={trailerNoteStyle}>
          Trailers Added Automatically: Swarm-Seq-Range (When Determinable), Co-Authored-By (When
          Configured)
        </span>
      </div>

      <div style={sectionStyle}>
        <label htmlFor={proseId} style={labelStyle}>
          What Changed / Why (AI-Generated, Editable)
        </label>
        <textarea
          id={proseId}
          className="swarm-input"
          value={aiProse ?? ""}
          onChange={(e) => onAiProseChange(e.target.value)}
          style={textareaStyle}
          spellCheck={true}
          placeholder="Click Generate To Draft A Summary From The Causal Record Below — Optional, Editable, Never Required To Ship."
        />
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Pill
            interactive
            tone="neutral"
            size="sm"
            disabled={context == null}
            aria-disabled={aiProseState === "generating" || undefined}
            style={aiProseState === "generating" ? { opacity: 0.5, cursor: "progress" } : undefined}
            onClick={() => {
              if (aiProseState !== "generating") onRegenerateProse();
            }}
          >
            {aiProseState === "generating"
              ? "Generating…"
              : aiProse != null
                ? "Regenerate"
                : "Generate"}
          </Pill>
          <span role="status" className="sr-only">
            {aiProseState === "generating"
              ? "Generating Summary…"
              : aiProseState === "ready"
                ? "Summary Generated."
                : ""}
          </span>
          {aiProseState === "failed" && (
            <span role="alert" style={actionReasonStyle}>
              Generation Failed — Shipping With The Causal Record Alone Still Works.
              {aiProseError != null && ` ${aiProseError}.`}
            </span>
          )}
        </div>
      </div>

      <div style={sectionStyle}>
        <span style={labelStyle}>Causal Record</span>
        <CausalRecordSection
          context={context}
          contextState={contextState}
          onRetry={onRetryContext}
        />
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
