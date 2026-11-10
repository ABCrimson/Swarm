import { useId } from "react";
import { Pill, type PillTone } from "#components/ui/Pill";
import type { AiProseState, ShipContextState } from "#hooks/useShip";
import { escapeForDisplay } from "#lib/display-escape";
import { pluralize } from "#lib/format";
import {
  emptyRecordMessage,
  renderTruncationNote,
  resultLabel,
  turnStatusLabel,
} from "#lib/ship-causal";
import { DESKTOP_ONLY_REASON, hasCapability } from "#lib/tauri";
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

const SECTION_CLASS = "flex flex-col gap-1.5";
const LABEL_CLASS =
  "font-display text-(length:--text-md) font-semibold tracking-[-0.01em] text-fg-dim";
const MONO_ROW_CLASS =
  "flex items-center gap-1.5 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[0.75rem] text-fg";
/** The branch row wraps whole items; only the branch name, alone on a line too narrow for it, ellipsizes. */
const BRANCH_ROW_CLASS =
  "flex flex-wrap items-center gap-1.5 gap-y-1 font-mono text-[0.75rem] text-fg";
const SEPARATOR_CLASS = "text-fg-dim";
const FILE_LIST_CLASS =
  "m-0 flex max-h-[180px] list-none flex-col gap-1 overflow-y-auto rounded-md border border-surface-2 bg-void px-2.5 py-2 font-mono text-[0.6875rem]";

/**
 * Layout for the two multi-line fields. Everything else (surface, border,
 * text color, the focus ring) comes from the house `.swarm-input` class,
 * so these fields get the same keyboard focus indicator as every other
 * input — no `outline` override.
 */
const TEXTAREA_CLASS =
  "h-auto min-h-[140px] resize-y px-3 py-2.5 font-mono text-[0.75rem] leading-normal";

/** The summary field is prose, so it sets DM Sans; the commit message keeps mono (git wraps it at column width). */
const PROSE_TEXTAREA_CLASS =
  "h-auto min-h-[140px] resize-y px-3 py-2.5 font-body text-(length:--text-md) leading-normal";

const TRAILER_NOTE_CLASS = "font-body text-(length:--text-sm) text-fg-dim";
const BLOCKER_LIST_CLASS =
  "flex flex-col gap-1 rounded-md border border-[oklch(0.68_0.20_25/0.3)] bg-[oklch(0.68_0.20_25/0.10)] px-3 py-2.5";
const BLOCKER_ITEM_CLASS = "font-body text-[0.75rem] text-[oklch(0.80_0.15_25)]";
const ACTIONS_CLASS = "flex flex-col gap-1";
const ACTION_GROUP_CLASS = "flex flex-col gap-0.5";
const ACTION_PLAN_CLASS = "px-0.5 font-mono text-[0.625rem] text-fg-dim";
const ACTION_REASON_CLASS = "px-0.5 font-body text-[0.625rem] text-[oklch(0.60_0.10_70)]";

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
  return `Will Run: ${steps.join(", ")}`;
}

// ── Causal Record (code-generated — see #lib/ship-causal) ────────────

const CAUSAL_MUTED_CLASS = "font-body text-[0.75rem] text-fg-dim italic";
const CAUSAL_TABLE_WRAP_CLASS = "max-h-[220px] overflow-y-auto rounded-md border border-surface-2";
const CAUSAL_TABLE_CLASS = "w-full border-collapse font-mono text-[0.6875rem]";
const CAUSAL_HEAD_CELL_CLASS =
  "sticky top-0 border-surface-2 border-b bg-void px-2.5 py-1.5 text-left font-display text-(length:--text-md) font-semibold tracking-[-0.01em] text-fg-dim";
const CAUSAL_CELL_CLASS =
  "overflow-hidden text-ellipsis whitespace-nowrap border-[oklch(0.11_0.02_220)] border-b px-2.5 py-[5px] text-fg";

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
 * path, invisible to this query" (`emptyRecordMessage`).
 */
function CausalRecordSection({
  context,
  contextState,
  onRetry,
}: CausalRecordSectionProps): React.ReactElement {
  if (contextState === "failed") {
    return (
      <div className="flex items-center gap-2">
        <span role="alert" className={CAUSAL_MUTED_CLASS}>
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
      <span role="status" className={CAUSAL_MUTED_CLASS}>
        Loading Causal Record…
      </span>
    );
  }

  if (context.turns.length === 0) {
    return <span className={CAUSAL_MUTED_CLASS}>{emptyRecordMessage(context)}</span>;
  }

  const rows = causalTableRows(context.turns);
  const truncationNote = renderTruncationNote(context);

  return (
    <>
      <div className={MONO_ROW_CLASS}>
        <span>
          {context.seqFrom}..{context.seqTo},
        </span>
        <span>{pluralize("Turn", context.turns.length)}</span>
      </div>
      {truncationNote != null && <span className={CAUSAL_MUTED_CLASS}>{truncationNote}</span>}
      {rows.length > 0 && (
        <section
          aria-label="Causal Record Tool Calls"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be keyboard-focusable so it can be scrolled without a mouse (WCAG 2.1.1).
          tabIndex={0}
          className={CAUSAL_TABLE_WRAP_CLASS}
        >
          <table className={CAUSAL_TABLE_CLASS}>
            <thead>
              <tr>
                <th className={CAUSAL_HEAD_CELL_CLASS}>Turn</th>
                <th className={CAUSAL_HEAD_CELL_CLASS}>Tool</th>
                <th className={CAUSAL_HEAD_CELL_CLASS}>Target</th>
                <th className={CAUSAL_HEAD_CELL_CLASS}>Result</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.key}>
                  <td className={`${CAUSAL_CELL_CLASS} max-w-[220px]`}>{row.turnLabel}</td>
                  <td className={`${CAUSAL_CELL_CLASS} max-w-[220px]`}>
                    {escapeForDisplay(row.name)}
                  </td>
                  <td
                    className={`${CAUSAL_CELL_CLASS} max-w-[260px]`}
                    title={escapeForDisplay(row.target)}
                  >
                    {escapeForDisplay(row.target)}
                  </td>
                  <td className={`${CAUSAL_CELL_CLASS} max-w-[220px]`}>
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
  const proseReasonId = useId();
  // The summary streams from the webview straight to Anthropic.
  const canGenerateProse = hasCapability("localAiChat");
  const stagingId = useId();
  const fileRows = buildFileRows(preflight);
  const disabled = !preflight.canShip || message.trim() === "";
  const compareDisabled = disabled || !preflight.hostSupportsCompare;

  return (
    <div className="flex flex-col gap-4 p-4">
      {preflight.blockers.length > 0 && (
        <div className={BLOCKER_LIST_CLASS} role="alert">
          {preflight.blockers.map((blocker) => (
            <span key={blocker} className={BLOCKER_ITEM_CLASS}>
              {escapeForDisplay(blocker)}
            </span>
          ))}
        </div>
      )}

      <div className={SECTION_CLASS}>
        <span className={LABEL_CLASS}>Branch</span>
        <div className={BRANCH_ROW_CLASS}>
          {/* The branch name is the one part that gives way: it ellipsizes (the title keeps it whole); the commit pills keep their width. */}
          <Pill
            tone="info"
            size="sm"
            className="min-w-0 font-mono"
            title={escapeForDisplay(preflight.branch)}
          >
            {escapeForDisplay(preflight.branch)}
          </Pill>
          <span className={SEPARATOR_CLASS}>{"→"}</span>
          <span>
            {escapeForDisplay(preflight.baseBranch)}
            {preflight.remote != null && ","}
          </span>
          {preflight.remote != null && (
            <span title={escapeForDisplay(preflight.remote)}>
              {escapeForDisplay(preflight.host ?? preflight.remote)}
            </span>
          )}
          {preflight.ahead > 0 && (
            <Pill tone="warning" size="sm" className="shrink-0">
              {pluralize("Unpushed Commit", preflight.ahead)}
            </Pill>
          )}
          {preflight.behind > 0 && (
            <Pill tone="danger" size="sm" className="shrink-0">
              {`${pluralize("Commit", preflight.behind)} Behind`}
            </Pill>
          )}
        </div>
      </div>

      <div className={SECTION_CLASS}>
        <span className={LABEL_CLASS}>Changes</span>
        <div className={MONO_ROW_CLASS}>
          <span>{pluralize("File", preflight.diffStat.filesChanged)}</span>
          <span className="text-[oklch(0.75_0.16_150)]">{`+${preflight.diffStat.insertions}`}</span>
          <span className="text-[oklch(0.68_0.20_25)]">{`-${preflight.diffStat.deletions}`}</span>
        </div>
        {fileRows.length > 0 && (
          <ul
            className={FILE_LIST_CLASS}
            aria-label="Changed Files"
            // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be keyboard-focusable so it can be scrolled without a mouse (WCAG 2.1.1).
            tabIndex={0}
          >
            {fileRows.map((row) => (
              <li
                key={row.path}
                className={`flex justify-between gap-2 ${row.reason != null ? "text-[oklch(0.60_0.10_70)]" : "text-[oklch(0.80_0.03_220)]"}`}
              >
                <span
                  className="overflow-hidden text-ellipsis whitespace-nowrap"
                  title={escapeForDisplay(row.path)}
                >
                  {escapeForDisplay(row.path)}
                </span>
                {row.reason != null && <span className="font-body">{row.reason}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>

      {preflight.staged.length > 0 && (
        <div className={SECTION_CLASS}>
          <span id={stagingId} className={LABEL_CLASS}>
            Staging Mode
          </span>
          <fieldset aria-labelledby={stagingId} className="m-0 flex min-w-0 gap-2 border-0 p-0">
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
          </fieldset>
        </div>
      )}

      <div className={SECTION_CLASS}>
        <label htmlFor={messageId} className={LABEL_CLASS}>
          Commit Message
        </label>
        <textarea
          id={messageId}
          className={`swarm-input ${TEXTAREA_CLASS}`}
          value={message}
          onChange={(e) => onMessageChange(e.target.value)}
          spellCheck={false}
        />
        <span className={TRAILER_NOTE_CLASS}>
          Trailers Added Automatically: Swarm-Seq-Range (When Determinable), Co-Authored-By (When
          Configured)
        </span>
      </div>

      <div className={SECTION_CLASS}>
        <label htmlFor={proseId} className={LABEL_CLASS}>
          What Changed / Why (AI-Generated, Editable)
        </label>
        <textarea
          id={proseId}
          className={`swarm-input ${PROSE_TEXTAREA_CLASS}`}
          value={aiProse ?? ""}
          onChange={(e) => onAiProseChange(e.target.value)}
          spellCheck={true}
          placeholder={
            canGenerateProse
              ? "Click Generate To Draft A Summary From The Causal Record Below — Optional, Editable, Never Required To Ship."
              : "Write A Summary Here — Optional, Editable, Never Required To Ship."
          }
        />
        <div className="flex items-center gap-2">
          <Pill
            interactive
            tone="neutral"
            size="sm"
            disabled={context == null || !canGenerateProse}
            aria-describedby={canGenerateProse ? undefined : proseReasonId}
            aria-disabled={aiProseState === "generating" || undefined}
            className={aiProseState === "generating" ? "cursor-progress! opacity-50!" : undefined}
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
          {!canGenerateProse && (
            <span id={proseReasonId} className={ACTION_REASON_CLASS}>
              {DESKTOP_ONLY_REASON}
            </span>
          )}
          <span role="status" className="sr-only">
            {aiProseState === "generating"
              ? "Generating Summary…"
              : aiProseState === "ready"
                ? "Summary Generated."
                : ""}
          </span>
          {aiProseState === "failed" && (
            <span role="alert" className={ACTION_REASON_CLASS}>
              Generation Failed — Shipping With The Causal Record Alone Still Works.
              {aiProseError != null && ` ${aiProseError.replace(/\.+$/, "")}.`}
            </span>
          )}
        </div>
      </div>

      <div className={SECTION_CLASS}>
        <span className={LABEL_CLASS}>Causal Record</span>
        <CausalRecordSection
          context={context}
          contextState={contextState}
          onRetry={onRetryContext}
        />
      </div>

      <div className={ACTIONS_CLASS}>
        <div className={ACTION_GROUP_CLASS}>
          <Pill interactive tone="neutral" size="md" disabled={disabled} onClick={onCommitOnly}>
            Commit Only
          </Pill>
          <span className={ACTION_PLAN_CLASS}>{commandPlanFor(mode, false, false)}</span>
        </div>
        <div className={ACTION_GROUP_CLASS}>
          <Pill interactive tone="info" size="md" disabled={disabled} onClick={onCommitAndPush}>
            Commit + Push
          </Pill>
          <span className={ACTION_PLAN_CLASS}>{commandPlanFor(mode, true, false)}</span>
        </div>
        <div className={ACTION_GROUP_CLASS}>
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
            <span className={ACTION_PLAN_CLASS}>{commandPlanFor(mode, true, true)}</span>
          ) : (
            <span className={ACTION_REASON_CLASS}>Compare Links Require A GitHub Remote</span>
          )}
        </div>
      </div>
    </div>
  );
}
