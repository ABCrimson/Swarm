/**
 * The two-part ship PR body: a DETERMINISTIC, code-generated "Causal
 * Record" section (`renderCausalRecordSection`) the model never writes,
 * plus an OPTIONAL AI-generated "What Changed / Why" prose section
 * (`generateCausalProse`) that may cite `[seq N]` — a citation survives
 * only as a single-number `[seq N]` (keyword in any case, no space after the bracket, one plain space before the
 * number, no leading zero) for a tool-call seq listed in the Turns section;
 * every other `[seq ...]` is stripped before render, repeated to a fixed point
 * so removing a nested citation cannot expose one for an unlisted seq
 * (`stripUnknownSeqCitations`). The model never writes the Causal Record, so
 * its provenance claims are machine-generated, and `escapeCell` renders the
 * agent-controlled tool names and targets in it as inert text; the AI prose
 * can only cite `[seq N]` tool calls it was shown. See
 * `docs/architecture.md`'s Ship Chain section for the full design and `crates/swarm-core/src/git/causal.rs` for where
 * `ShipContext` itself comes from.
 *
 * The AI half degrades gracefully by construction: `generateCausalProse`
 * is the ONLY function here that can fail (no API key, network error,
 * refusal) — every other export is pure and synchronous. A caller that
 * catches a `generateCausalProse` rejection and passes `null` as
 * `aiProse` to `composeShipBody` gets exactly the deterministic section
 * alone; nothing here fabricates a substitute for the prose.
 *
 * @module ship-causal
 */

import { streamMessage } from "#lib/anthropic";
import { pluralize } from "#lib/format";
import type { CausalTurn, DiffStat, ShipContext } from "#store/types";

// ── Deterministic Causal Record (code-generated, never model-written) ──

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

/** Markdown-table-cell-safe and inert. A tool's name and target are free-form text the agent controls: every run of control characters (a lone CR included, which GFM reads as a line ending) folds to one space, then backslash, `|`, `<`, `[` and `]` are backslash-escaped (CommonMark escapes any ASCII punctuation; GFM honours `\|` in a cell), so no input adds a row or a cell, opens raw HTML, or forms a link or an image. GitHub's text filters (@-mentions, #-references, bare-URL autolinks) still act on the literal text. */
function escapeCell(value: string): string {
  return value.replaceAll(/\p{Cc}+/gu, " ").replaceAll(/[\\|<[\]]/g, String.raw`\$&`);
}

function renderToolCallRows(turns: readonly CausalTurn[]): string[] {
  return turns.flatMap((turn, index) => {
    const turnLabel = `${index + 1} (${turnStatusLabel(turn.status)})`;
    if (turn.toolCalls.length === 0) return [`| ${turnLabel} | — | — | — |`];
    return turn.toolCalls.map((call) => {
      const target = call.target != null ? escapeCell(call.target) : "—";
      return `| ${turnLabel} | ${escapeCell(call.name)} | ${target} | ${resultLabel(call.ok)} |`;
    });
  });
}

/**
 * The single, honest disclosure for "you are not seeing this worker's
 * complete history" — folds BOTH truncation sources into one message
 * rather than two separate ones a reader would have to
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
  return `Showing The Most Recent ${pluralize("Turn", shown)} In This Range — Older Turns Omitted.`;
}

/**
 * The honest message for a zero-turn range — two DISTINCT messages,
 * never one blurring both: a worker with genuinely no
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
  const turnCount = context.turns.length;
  const lines = [
    "## Causal Record",
    "",
    `**Seq Range:** \`${context.seqFrom}..${context.seqTo}\` — ${pluralize("Turn", turnCount)}`,
    `**Diff:** ${pluralize("File", diffStat.filesChanged)} Changed, +${diffStat.insertions}/-${diffStat.deletions}`,
    ...context.commits.map(
      (commit) => `**Commit:** \`${commit.sha.slice(0, 12)}\` On \`${commit.branch}\``,
    ),
    "",
  ];

  const truncationNote = renderTruncationNote(context);

  if (turnCount === 0) {
    lines.push(`_${emptyRecordMessage(context)}_`);
    if (truncationNote != null) lines.push("", `_${truncationNote}_`);
    return lines.join("\n");
  }

  if (truncationNote != null) lines.push(`_${truncationNote}_`, "");
  lines.push(
    "| Turn | Tool | Target | Result |",
    "|------|------|--------|--------|",
    ...renderToolCallRows(context.turns),
  );
  return lines.join("\n");
}

// ── Citation validity + stripping (the honesty rule) ────────────────

/**
 * Any `[seq ...]` form — `[seq 9999 ]`, `[seq: 9999]`, `[seq 1, 2]`, `[ seq 11]` — with
 * a body that holds no bracket or newline (so it matches the innermost of a nested pair), with at most one plain space
 * on each side (never a newline or tab), so removing a citation can never join two lines or eat a list
 * item's indentation.
 */
const SEQ_CITATION_RE = /( ?)\[([ \t]*)seq\b([^[\]\n]*)\]( ?)/gi;

/**
 * Strips every `[seq ...]` citation in `prose` except the exact form `[seq N]` (keyword in any case; one plain space,
 * decimal `N` without a leading zero, nothing inside the bracket before
 * `seq`) whose `N` is the seq of a tool call listed in `context`'s turns — the
 * same seqs `buildCausalPromptInput` shows the model. That is the honesty
 * gate between whatever the model wrote and what actually renders. A seq
 * the model was never given (hallucination), one that is only somewhere in
 * the fetched range (another worker's event), and a malformed form are
 * functionally indistinguishable from fabricated provenance — all are
 * removed the same way, unconditionally, never surfaced as a "trust me"
 * citation.
 *
 * Stripping repeats until the text stops changing (each pass shortens it, so
 * it terminates): removing a nested citation such as `[seq [seq 1] 9999]`
 * leaves `[seq 9999]`, which the next pass removes too.
 *
 * Spacing is repaired only where a citation was removed: a citation
 * between two words collapses to the single space that separated them
 * ("the Bash call [seq 42] failed" → "the Bash call failed"), one at the
 * start of a line or before punctuation takes its adjacent space with it.
 * Nothing else in the prose is touched — nested-list indentation,
 * indented code and line breaks survive exactly as the model wrote them.
 */
export function stripUnknownSeqCitations(prose: string, context: ShipContext): string {
  const known = new Set(context.turns.flatMap((turn) => turn.toolCalls.map((call) => call.seq)));
  const replacer = (match: string, before: string, lead: string, inner: string, after: string) => {
    const cited = lead === "" ? /^ (0|[1-9]\d*)$/.exec(inner) : null;
    if (cited && known.has(Number(cited[1]))) return match;
    return before && after ? " " : "";
  };
  // Removing a nested citation can expose an outer one, so repeat to a fixed
  // point; it terminates because every replacement shortens the string.
  let current = prose;
  let previous: string;
  do {
    previous = current;
    current = previous.replaceAll(SEQ_CITATION_RE, replacer);
  } while (current !== previous);
  return current;
}

// ── AI prose (optional, degrades gracefully) ─────────────────────────

/** Everything `buildCausalPromptInput`/`generateCausalProse` need — deliberately narrow: no worker id, no config, no file contents. */
export interface CausalProseInput {
  readonly context: ShipContext;
  readonly diffStat: DiffStat;
  readonly branch: string;
  readonly baseBranch: string;
}

/** Folds control characters to a space so agent-controlled text cannot start a forged line in the prompt. */
function oneLine(value: string): string {
  return value.replaceAll(/\p{Cc}+/gu, " ");
}

function renderTurnForPrompt(turn: CausalTurn, index: number): string {
  const header = `Turn ${index + 1} (${turnStatusLabel(turn.status)}):`;
  if (turn.toolCalls.length === 0) return `${header}\n  (No Tool Calls)`;
  const calls = turn.toolCalls
    .map(
      (c) =>
        `  - [seq ${c.seq}] ${oneLine(c.name)}${c.target != null ? ` (${oneLine(c.target)})` : ""} -> ${resultLabel(c.ok)}`,
    )
    .join("\n");
  return `${header}\n${calls}`;
}

/**
 * Builds the `{system, user}` prompt for the AI prose model —
 * synchronous, pure, and the ONLY place the prompt text is assembled, so
 * this is also the ONE place to audit what the prompt can contain. Reads
 * exclusively from `CausalProseInput`'s own fields: `diffStat`'s three
 * numbers, `branch`/`baseBranch` strings, and each turn's status + tool
 * call `name`/`target`/`ok`. `target` is an allowlist-extracted excerpt of
 * the tool input, redacted by `git::causal::extract_target` (recognized
 * token shapes and URL credentials) and length-capped by the time it
 * reaches `ShipContext`; an opaque secret with no recognizable shape can
 * still pass that redaction. Nothing else from a tool `input`/`content`
 * reaches this function, and no code path here reads `readConfig`, a
 * file, `.env` content, or an environment variable.
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
  const parts = await Array.fromAsync(
    streamMessage(
      // Low effort: routine summarization. 8K leaves room for adaptive
      // thinking, which counts against max_tokens, before the prose itself.
      {
        model,
        maxTokens: 8_000,
        effort: "low",
        system,
        messages: [{ role: "user", content: user }],
      },
      signal,
    ),
    // Tools were never offered; a tool-use delta is defensive, not expected.
    (delta) => (delta.toolUse ? "" : delta.content),
  );
  return stripUnknownSeqCitations(parts.join("").trim(), input.context);
}

// ── Compose ───────────────────────────────────────────────────────────

/**
 * Composes the final ship body: the deterministic Causal Record FIRST,
 * then the AI prose section (when present and non-empty) — the shape fed
 * to `git_stage_commit`'s trailer-bearing message is untouched by this;
 * this is specifically the `ship_compare_url` `body` (see `useShip.ts`).
 *
 * **Deterministic-first is a deliberate ordering, not
 * cosmetic.** `stripUnknownSeqCitations` removes every `[seq ...]` citation that is not a listed tool call, but nothing stops a model from writing its OWN `##
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
