import { streamMessage } from "#lib/anthropic";
import type { CausalTurn, DiffStat, ShipContext } from "#store/types";

/**
 * The two-part ship PR body: a DETERMINISTIC, code-generated "Causal
 * Record" section (`renderCausalRecordSection`) the model never writes,
 * plus an OPTIONAL AI-generated "What Changed / Why" prose section
 * (`generateCausalProse`) that may cite `[seq N]` — any citation not
 * actually present in the fetched range is stripped before render
 * (`stripUnknownSeqCitations`). This repo already shipped fabricated
 * telemetry once (the Math.random() charts) — provenance claims in a PR
 * body must be as machine-generated and unforgeable as that fix made
 * chart data. See `docs/architecture.md`'s Ship Chain section for the
 * full design and `src-tauri/crates/swarm-core/src/git/causal.rs` for
 * where `ShipContext` itself comes from.
 *
 * The AI half degrades gracefully by construction: `generateCausalProse`
 * is the ONLY function here that can fail (no API key, network error,
 * refusal) — every other export is pure and synchronous. A caller that
 * catches a `generateCausalProse` rejection and passes `null` as
 * `aiProse` to `composeShipBody` gets exactly the deterministic section
 * alone; nothing here fabricates a substitute for the prose.
 */

// ── Deterministic Causal Record (code-generated, never model-written) ──

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return count === 1 ? singular : plural;
}

/** Exported for `ShipPreview.tsx`'s in-app Causal Record table, which renders the same labeling as this module's markdown output rather than re-deriving it. */
export function resultLabel(ok: boolean | null): "OK" | "Error" | "Pending" {
  if (ok === true) return "OK";
  if (ok === false) return "Error";
  return "Pending";
}

/** Exported for `ShipPreview.tsx` — see `resultLabel`'s doc. */
export function turnStatusLabel(status: string | null): "Completed" | "Failed" | "In Progress" {
  if (status === "ok") return "Completed";
  if (status === "error") return "Failed";
  return "In Progress";
}

/** Markdown-table-cell-safe: escapes `|` and collapses embedded newlines — a tool's `target` is a short path/command string, never expected to need more than this. */
function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function renderToolCallRows(turns: readonly CausalTurn[]): string[] {
  const rows: string[] = [];
  turns.forEach((turn, index) => {
    const turnLabel = `${index + 1} (${turnStatusLabel(turn.status)})`;
    if (turn.toolCalls.length === 0) {
      rows.push(`| ${turnLabel} | — | — | — |`);
      return;
    }
    for (const call of turn.toolCalls) {
      const target = call.target != null ? escapeCell(call.target) : "—";
      rows.push(
        `| ${turnLabel} | ${escapeCell(call.name)} | ${target} | ${resultLabel(call.ok)} |`,
      );
    }
  });
  return rows;
}

/**
 * The single, honest disclosure for "you are not seeing this worker's
 * complete history" — folds BOTH truncation sources into one message
 * (review FIX-1) rather than two separate ones a reader would have to
 * reconcile themselves:
 *
 * - `omittedTurnCount > 0` — `build_ship_context`'s own `MAX_TURNS` (200)
 *   cap dropped older turns from an otherwise-complete fetch; the exact
 *   count is known.
 * - `eventsTruncated` — the SQL-level row fetch itself hit its cap
 *   (`EventLog::events_for_worker_between`'s `limit`) before reaching
 *   every matching row for this worker in range; turns older than
 *   what's visible may exist beyond what `omittedTurnCount` alone can
 *   count, so this case is phrased in terms of what IS shown
 *   (`context.turns.length`) rather than an exact omitted count that
 *   would overstate precision.
 *
 * Exported for `ShipPreview.tsx`'s in-app rendering, so the composed PR
 * body and the UI panel never drift on this wording. `null` when neither
 * condition holds.
 */
export function renderTruncationNote(context: ShipContext): string | null {
  if (context.omittedTurnCount === 0 && !context.eventsTruncated) return null;
  const shown = context.turns.length;
  return `Showing The Most Recent ${shown} ${pluralize(shown, "Turn")} In This Range — Older Turns Omitted.`;
}

/**
 * The honest message for a zero-turn range — two DISTINCT messages,
 * never one blurring both (review NIT-4): a worker with genuinely no
 * recorded activity in range reads differently from a worker whose
 * activity used the webview chat path (`AIChat.tsx`), which
 * `ship_context` structurally cannot see turn-level detail for (see
 * `git::causal`'s module doc on the `agent_turn_started`/`turnId`
 * id-space mismatch) — asserting "did nothing" about the latter would be
 * misleading, not merely imprecise. Exported for `ShipPreview.tsx` — see
 * `renderTruncationNote`'s doc for why this is shared rather than
 * re-derived per call site.
 */
export function emptyRecordMessage(context: ShipContext): string {
  return context.hasUncapturedWebviewActivity
    ? "This Worker's Activity Is Not Captured In The Causal Record (Webview Chat Path)."
    : "Causal Record Unavailable For This Range — No Recorded Agent Turns.";
}

/**
 * Renders the deterministic "Causal Record" section: seq range, turn
 * count, diff stat, any commits already made in range, and a tool-call
 * table (turn, tool name, target, ok/err) — every value read directly
 * off `context`/`diffStat`, no free text, no model involvement. Empty
 * `context.turns` renders one of two honest messages (see
 * `emptyRecordMessage`) instead of an empty table — never a fabricated
 * "no changes were made" claim, which would be a positive assertion this
 * function has no way to actually verify. A truncated fetch (see
 * `renderTruncationNote`) is disclosed alongside whichever branch
 * applies, never silently.
 */
export function renderCausalRecordSection(context: ShipContext, diffStat: DiffStat): string {
  const lines: string[] = ["## Causal Record", ""];

  const turnCount = context.turns.length;
  lines.push(
    `**Seq Range:** \`${context.seqFrom}..${context.seqTo}\` — ${turnCount} ${pluralize(turnCount, "Turn")}`,
  );
  lines.push(
    `**Diff:** ${diffStat.filesChanged} ${pluralize(diffStat.filesChanged, "File")} Changed, +${diffStat.insertions}/-${diffStat.deletions}`,
  );
  for (const commit of context.commits) {
    lines.push(`**Commit:** \`${commit.sha.slice(0, 12)}\` On \`${commit.branch}\``);
  }
  lines.push("");

  const truncationNote = renderTruncationNote(context);

  if (turnCount === 0) {
    lines.push(`_${emptyRecordMessage(context)}_`);
    if (truncationNote != null) {
      lines.push("", `_${truncationNote}_`);
    }
    return lines.join("\n");
  }

  if (truncationNote != null) {
    lines.push(`_${truncationNote}_`, "");
  }

  lines.push("| Turn | Tool | Target | Result |");
  lines.push("|------|------|--------|--------|");
  lines.push(...renderToolCallRows(context.turns));

  return lines.join("\n");
}

// ── Citation validity + stripping (the honesty rule) ────────────────

const SEQ_CITATION_RE = /\s?\[seq\s+(\d+)\]/gi;

function isSeqInRange(seq: number, context: ShipContext): boolean {
  return seq > context.seqFrom && seq <= context.seqTo;
}

/**
 * Strips every `[seq N]` citation in `prose` whose `N` does not fall
 * within `context`'s actual `(seqFrom, seqTo]` range — the honesty gate
 * between whatever the model wrote and what actually renders. Matches
 * the preceding whitespace too, so "the Bash call [seq 42] failed"
 * degrades to "the Bash call failed" rather than leaving a double space.
 * A model citing a seq it was never given (hallucination) or one
 * outside the fetched window is functionally indistinguishable from
 * fabricated provenance — both are removed the same way, unconditionally,
 * never surfaced as a "trust me" citation.
 */
export function stripUnknownSeqCitations(prose: string, context: ShipContext): string {
  const stripped = prose.replace(SEQ_CITATION_RE, (match, seqStr: string) => {
    const seq = Number(seqStr);
    return isSeqInRange(seq, context) ? match : "";
  });
  // A removed citation can leave a doubled space (two citations back to
  // back) or a leading space (a citation was the very first thing in the
  // string) behind — collapsed here rather than left visible. Only the
  // space character is touched, never a newline, so intentional
  // paragraph breaks in the model's prose are untouched.
  return stripped.replace(/ {2,}/g, " ").replace(/^ +/, "");
}

// ── AI prose (optional, degrades gracefully) ─────────────────────────

/** Everything `buildCausalPromptInput`/`generateCausalProse` need — deliberately narrow: no worker id, no config, no file contents. */
export interface CausalProseInput {
  readonly context: ShipContext;
  readonly diffStat: DiffStat;
  readonly branch: string;
  readonly baseBranch: string;
}

function renderTurnForPrompt(turn: CausalTurn, index: number): string {
  const header = `Turn ${index + 1} (${turnStatusLabel(turn.status)}):`;
  if (turn.toolCalls.length === 0) return `${header}\n  (No Tool Calls)`;
  const calls = turn.toolCalls
    .map(
      (c) =>
        `  - [seq ${c.seq}] ${c.name}${c.target != null ? ` (${c.target})` : ""} -> ${resultLabel(c.ok)}`,
    )
    .join("\n");
  return `${header}\n${calls}`;
}

/**
 * Builds the `{system, user}` prompt for the AI prose model —
 * synchronous, pure, and the ONLY place the prompt text is assembled, so
 * this is also the ONE place to audit for the no-secrets-in-prompt
 * guarantee. Reads exclusively from `CausalProseInput`'s own fields:
 * `diffStat`'s three numbers, `branch`/`baseBranch` strings, and each
 * turn's status + tool call `name`/`target`/`ok` — `target` is already
 * an allowlist-extracted, length-capped string by the time it reaches
 * `ShipContext` (see `git::causal::extract_target`'s doc), so no raw
 * tool `input`/`content`/config value/token/`.env` content can reach
 * this function even if it wanted to read one — there is no code path
 * here that reads `readConfig`, a file, or an environment variable at
 * all.
 */
export function buildCausalPromptInput(input: CausalProseInput): { system: string; user: string } {
  const system = [
    'You Write The "What Changed / Why" Section Of A Pull Request Description.',
    "Be concise: 3-6 sentences, or a short bulleted list.",
    "You may cite a specific tool call using the exact notation [seq N], where N is one of the seq numbers listed below in the Turns section — never invent a seq number, never cite one you were not given.",
    'Do not restate the diff stat and do not write your own "Causal Record" section — a separate, code-generated section covers that.',
    "You were only given tool names and short targets, never file contents — do not claim to know file contents you were not shown.",
  ].join(" ");

  const user = [
    `Branch: ${input.branch} -> ${input.baseBranch}`,
    `Diff: ${input.diffStat.filesChanged} files changed, +${input.diffStat.insertions}/-${input.diffStat.deletions}`,
    `Seq range: ${input.context.seqFrom}..${input.context.seqTo}`,
    "",
    "Turns:",
    input.context.turns.length > 0
      ? input.context.turns.map(renderTurnForPrompt).join("\n\n")
      : "(No Recorded Turns In This Range)",
  ].join("\n");

  return { system, user };
}

/**
 * Generates the AI prose section: a single-shot `streamMessage` call
 * (tools omitted — this is prose generation, not an agentic loop),
 * collected into one string and run through `stripUnknownSeqCitations`
 * before being returned. Throws on any failure (no API key configured,
 * network error, refusal) exactly like `streamMessage` does — callers
 * are expected to catch and fall back to `composeShipBody(context,
 * diffStat, null)`, never to retry-until-success or synthesize a
 * placeholder.
 */
export async function generateCausalProse(
  input: CausalProseInput,
  model: string,
  signal?: AbortSignal,
): Promise<string> {
  const { system, user } = buildCausalPromptInput(input);
  let text = "";
  for await (const delta of streamMessage(
    // Low effort: routine summarization. 8K leaves room for adaptive thinking,
    // which counts against max_tokens, before the prose itself.
    { model, maxTokens: 8_000, effort: "low", system, messages: [{ role: "user", content: user }] },
    signal,
  )) {
    if (delta.toolUse) continue; // tools were never offered; defensive, not expected.
    text += delta.content;
  }
  return stripUnknownSeqCitations(text.trim(), input.context);
}

// ── Compose ───────────────────────────────────────────────────────────

/**
 * Composes the final ship body: the deterministic Causal Record FIRST,
 * then the AI prose section (when present and non-empty) — the shape fed
 * to `git_stage_commit`'s trailer-bearing message is untouched by this;
 * this is specifically the `ship_compare_url` `body` (see `useShip.ts`).
 *
 * **Review FIX-2: deterministic-first is a deliberate ordering, not
 * cosmetic.** `stripUnknownSeqCitations` removes an out-of-range `[seq
 * N]` citation, but nothing stops a model from writing its OWN `##
 * Causal Record` heading (plus a fabricated table) inside its prose —
 * which, if the prose rendered first, would appear ABOVE the real
 * section and read as the authoritative one to anyone skimming the PR
 * body. Rendering the real section first removes the ambiguity
 * entirely: the machine-generated truth always leads, whatever the model
 * writes always follows it, so the first "## Causal Record" a reader
 * ever encounters in the composed body is always the real one.
 *
 * `aiProse` should already be stripped (i.e. the return value of
 * `generateCausalProse`, or `null`) — this function does not re-strip,
 * since re-validating already-validated text would just be redundant
 * work on the hot path every keystroke of the editable textarea takes.
 */
export function composeShipBody(
  context: ShipContext,
  diffStat: DiffStat,
  aiProse: string | null,
): string {
  const sections: string[] = [renderCausalRecordSection(context, diffStat)];
  if (aiProse != null && aiProse.trim().length > 0) {
    sections.push(aiProse.trim());
  }
  return sections.join("\n\n---\n\n");
}
