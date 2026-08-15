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

function resultLabel(ok: boolean | null): "OK" | "Error" | "Pending" {
  if (ok === true) return "OK";
  if (ok === false) return "Error";
  return "Pending";
}

function turnStatusLabel(status: string | null): "Completed" | "Failed" | "In Progress" {
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
 * Renders the deterministic "Causal Record" section: seq range, turn
 * count, diff stat, any commits already made in range, and a tool-call
 * table (turn, tool name, target, ok/err) — every value read directly
 * off `context`/`diffStat`, no free text, no model involvement. Empty
 * `context.turns` renders the honest "Causal Record Unavailable For
 * This Range" message instead of an empty table — never a fabricated
 * "no changes were made" claim, which would be a positive assertion
 * this function has no way to actually verify.
 */
export function renderCausalRecordSection(context: ShipContext, diffStat: DiffStat): string {
  const lines: string[] = ["## Causal Record", ""];

  const turnCount = context.turns.length;
  const omittedNote =
    context.omittedTurnCount > 0
      ? ` (${context.omittedTurnCount} Earlier ${pluralize(context.omittedTurnCount, "Turn")} Omitted)`
      : "";
  lines.push(
    `**Seq Range:** \`${context.seqFrom}..${context.seqTo}\` — ${turnCount} ${pluralize(turnCount, "Turn")}${omittedNote}`,
  );
  lines.push(
    `**Diff:** ${diffStat.filesChanged} ${pluralize(diffStat.filesChanged, "File")} Changed, +${diffStat.insertions}/-${diffStat.deletions}`,
  );
  for (const commit of context.commits) {
    lines.push(`**Commit:** \`${commit.sha.slice(0, 12)}\` On \`${commit.branch}\``);
  }
  lines.push("");

  if (turnCount === 0) {
    lines.push("_Causal Record Unavailable For This Range — No Recorded Agent Turns._");
    return lines.join("\n");
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
    { model, maxTokens: 768, system, messages: [{ role: "user", content: user }] },
    signal,
  )) {
    if (delta.toolUse) continue; // tools were never offered; defensive, not expected.
    text += delta.content;
  }
  return stripUnknownSeqCitations(text.trim(), input.context);
}

// ── Compose ───────────────────────────────────────────────────────────

/**
 * Composes the final ship body: the AI prose section (when present and
 * non-empty) followed by the deterministic Causal Record — the shape fed
 * to `git_stage_commit`'s trailer-bearing message is untouched by this;
 * this is specifically the `ship_compare_url` `body` (see `useShip.ts`).
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
  const sections: string[] = [];
  if (aiProse != null && aiProse.trim().length > 0) {
    sections.push(aiProse.trim());
  }
  sections.push(renderCausalRecordSection(context, diffStat));
  return sections.join("\n\n---\n\n");
}
