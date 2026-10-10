import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CLAUDE_MODELS } from "#lib/models";
import {
  buildCausalPromptInput,
  composeShipBody,
  emptyRecordMessage,
  generateCausalProse,
  renderCausalRecordSection,
  renderTruncationNote,
  stripUnknownSeqCitations,
} from "#lib/ship-causal";
import type { CausalTurn, DiffStat, ShipContext } from "#store/types";

const mockStreamMessage = vi.fn();
vi.mock(import("#lib/anthropic"), () => ({
  streamMessage: (...args) => mockStreamMessage(...args),
}));

function makeTurn(overrides: Partial<CausalTurn> = {}): CausalTurn {
  return {
    turnId: "t1",
    status: "ok",
    toolCalls: [{ seq: 11, name: "Write", target: "src/lib.rs", ok: true }],
    ...overrides,
  };
}

function makeContext(overrides: Partial<ShipContext> = {}): ShipContext {
  return {
    workerId: "11111111-2222-3333-8444-555555555555",
    seqFrom: 9,
    seqTo: 14,
    turns: [makeTurn()],
    commits: [],
    omittedTurnCount: 0,
    eventsTruncated: false,
    hasUncapturedWebviewActivity: false,
    ...overrides,
  };
}

const diffStat: DiffStat = { filesChanged: 2, insertions: 10, deletions: 3 };

async function* fakeStream(
  deltas: Array<{ content: string; toolUse?: unknown }>,
): AsyncGenerator<{ content: string; toolUse?: unknown }> {
  for (const d of deltas) yield d;
}

beforeEach(() => {
  mockStreamMessage.mockReset();
});

// ── renderCausalRecordSection (deterministic, code-generated) ────────

describe("renderCausalRecordSection", () => {
  it("renders the seq range, turn count, diff stat, and a tool-call table row per call", () => {
    const section = renderCausalRecordSection(makeContext(), diffStat);
    expect(section).toContain("## Causal Record");
    expect(section).toContain("**Seq Range:** `9..14` — 1 Turn");
    expect(section).toContain("**Diff:** 2 Files Changed, +10/-3");
    expect(section).toContain("| 1 (Completed) | Write | src/lib.rs | OK |");
  });

  it("renders a Pending row for a tool call with no observed result", () => {
    const context = makeContext({
      turns: [makeTurn({ toolCalls: [{ seq: 5, name: "Bash", target: "pnpm test", ok: null }] })],
    });
    const section = renderCausalRecordSection(context, diffStat);
    expect(section).toContain("| 1 (Completed) | Bash | pnpm test | Pending |");
  });

  it("renders an Error row and a null target as an em dash", () => {
    const context = makeContext({
      turns: [makeTurn({ toolCalls: [{ seq: 5, name: "Read", target: null, ok: false }] })],
    });
    const section = renderCausalRecordSection(context, diffStat);
    expect(section).toContain("| 1 (Completed) | Read | — | Error |");
  });

  it("includes a commit line when the range already has one", () => {
    const context = makeContext({
      commits: [{ sha: "abcdef1234567890", branch: "swarm/x", seqFrom: 9, seqTo: 13 }],
    });
    const section = renderCausalRecordSection(context, diffStat);
    expect(section).toContain("**Commit:** `abcdef123456` On `swarm/x`");
  });

  it("reports omitted turns honestly rather than silently truncating", () => {
    const context = makeContext({ omittedTurnCount: 7 });
    const section = renderCausalRecordSection(context, diffStat);
    expect(section).toContain(
      "Showing The Most Recent 1 Turn In This Range — Older Turns Omitted.",
    );
  });

  // ── The unified truncation disclosure ──

  it("discloses a SQL-level truncated fetch with the same wording as a turn-level omission", () => {
    const context = makeContext({ eventsTruncated: true });
    const section = renderCausalRecordSection(context, diffStat);
    expect(section).toContain(
      "Showing The Most Recent 1 Turn In This Range — Older Turns Omitted.",
    );
  });

  it("shows no truncation note at all when nothing was omitted or truncated", () => {
    const context = makeContext({ omittedTurnCount: 0, eventsTruncated: false });
    const section = renderCausalRecordSection(context, diffStat);
    expect(section).not.toContain("Older Turns Omitted");
  });

  // ── DIRECTIVE: the empty-range honest degradation ───────────────────
  it("renders the honest unavailable message for a zero-turn range, never a fabricated table", () => {
    const context = makeContext({ turns: [] });
    const section = renderCausalRecordSection(context, diffStat);
    expect(section).toContain(
      "_Causal Record Unavailable For This Range — No Recorded Agent Turns._",
    );
    expect(section).not.toContain("| Turn | Tool | Target | Result |");
    // The diff stat still renders — this is "diff-only body", not an
    // empty one, per the ship-chain plan's degradation rule.
    expect(section).toContain("**Diff:** 2 Files Changed, +10/-3");
  });

  it("escapes markdown table pipes and newlines in a tool name/target", () => {
    const context = makeContext({
      turns: [makeTurn({ toolCalls: [{ seq: 1, name: "Weird|Tool", target: "a\nb", ok: true }] })],
    });
    const section = renderCausalRecordSection(context, diffStat);
    expect(section).toContain("Weird\\|Tool");
    expect(section).toContain("a b");
    expect(section).not.toContain("a\nb |");
  });

  it("folds a lone CR so a tool target cannot forge a table row", () => {
    const context = makeContext({
      turns: [
        makeTurn({
          toolCalls: [
            { seq: 1, name: "Bash", target: "a\r| 9 (Completed) | Write | x | OK |", ok: false },
          ],
        }),
      ],
    });
    const section = renderCausalRecordSection(context, diffStat);
    expect(section).not.toContain("\r");
    for (const line of section.split(/\r\n|\r|\n/)) expect(line.startsWith("| 9")).toBe(false);
  });

  it("escapes backslashes before pipes so a trailing backslash cannot unescape the pipe", () => {
    const context = makeContext({
      turns: [makeTurn({ toolCalls: [{ seq: 1, name: "Bash", target: "x\\| OK", ok: false }] })],
    });
    const section = renderCausalRecordSection(context, diffStat);
    expect(section).toContain(String.raw`x\\\| OK`);
    expect(section).toContain("| Error |");
  });

  // ── "Did nothing" vs. "structurally invisible" ──

  it("renders a DIFFERENT honest message for a webview-chat worker than for one that genuinely did nothing", () => {
    const genuinelyEmpty = makeContext({ turns: [], hasUncapturedWebviewActivity: false });
    const webviewInvisible = makeContext({ turns: [], hasUncapturedWebviewActivity: true });

    const genuinelyEmptySection = renderCausalRecordSection(genuinelyEmpty, diffStat);
    const webviewSection = renderCausalRecordSection(webviewInvisible, diffStat);

    expect(genuinelyEmptySection).toContain(
      "Causal Record Unavailable For This Range — No Recorded Agent Turns.",
    );
    expect(webviewSection).toContain(
      "This Worker's Activity Is Not Captured In The Causal Record (Webview Chat Path).",
    );
    // Never the "did nothing" phrasing for the webview case — that would
    // be misleading, not merely imprecise.
    expect(webviewSection).not.toContain("No Recorded Agent Turns");
  });
});

// ── renderTruncationNote / emptyRecordMessage ──

describe("renderTruncationNote", () => {
  it("returns null when nothing was omitted or truncated", () => {
    expect(renderTruncationNote(makeContext())).toBeNull();
  });

  it("returns the shared disclosure when omittedTurnCount is positive", () => {
    const note = renderTruncationNote(makeContext({ omittedTurnCount: 3 }));
    expect(note).toBe("Showing The Most Recent 1 Turn In This Range — Older Turns Omitted.");
  });

  it("returns the shared disclosure when eventsTruncated is true, even with omittedTurnCount at 0", () => {
    const note = renderTruncationNote(makeContext({ omittedTurnCount: 0, eventsTruncated: true }));
    expect(note).toBe("Showing The Most Recent 1 Turn In This Range — Older Turns Omitted.");
  });
});

describe("emptyRecordMessage", () => {
  it("distinguishes genuinely-empty from webview-invisible", () => {
    expect(emptyRecordMessage(makeContext({ hasUncapturedWebviewActivity: false }))).toBe(
      "Causal Record Unavailable For This Range — No Recorded Agent Turns.",
    );
    expect(emptyRecordMessage(makeContext({ hasUncapturedWebviewActivity: true }))).toBe(
      "This Worker's Activity Is Not Captured In The Causal Record (Webview Chat Path).",
    );
  });
});

// ── stripUnknownSeqCitations (the honesty gate) ──────────────────────

describe("stripUnknownSeqCitations", () => {
  it("keeps a citation whose seq falls within (seqFrom, seqTo]", () => {
    const context = makeContext({ seqFrom: 9, seqTo: 14 });
    const prose = "The Write call [seq 11] updated the file.";
    expect(stripUnknownSeqCitations(prose, context)).toBe(prose);
  });

  it("strips an invented citation not present in the fetched range", () => {
    const context = makeContext({ seqFrom: 9, seqTo: 14 });
    const prose = "This was caused by [seq 9999], a turn we never fetched.";
    const stripped = stripUnknownSeqCitations(prose, context);
    expect(stripped).not.toContain("[seq 9999]");
    expect(stripped).toBe("This was caused by, a turn we never fetched.");
  });

  it("strips a citation at or below seqFrom (exclusive lower bound) and above seqTo", () => {
    const context = makeContext({ seqFrom: 9, seqTo: 14 });
    expect(stripUnknownSeqCitations("[seq 9] boundary", context)).toBe("boundary");
    expect(stripUnknownSeqCitations("[seq 15] boundary", context)).toBe("boundary");
    expect(stripUnknownSeqCitations("[seq 14] boundary", context)).toBe("[seq 14] boundary");
  });

  it("strips multiple invalid citations independently, keeping valid ones interleaved", () => {
    const context = makeContext({ seqFrom: 9, seqTo: 14 });
    const prose = "First [seq 999] then [seq 11] then [seq 12345].";
    expect(stripUnknownSeqCitations(prose, context)).toBe("First then [seq 11] then.");
  });

  it("is case-insensitive on the seq keyword", () => {
    const context = makeContext({ seqFrom: 9, seqTo: 14 });
    expect(stripUnknownSeqCitations("[SEQ 11] works", context)).toBe("[SEQ 11] works");
  });

  it("never joins a line to the previous one when a stripped citation starts it", () => {
    const context = makeContext({ seqFrom: 9, seqTo: 14 });
    expect(stripUnknownSeqCitations("First line.\n[seq 99] Second line.", context)).toBe(
      "First line.\nSecond line.",
    );
  });

  it("leaves nested-list and indented-code whitespace exactly as written", () => {
    const context = makeContext({ seqFrom: 9, seqTo: 14 });
    const prose = "- Parent [seq 99]\n  - Child [seq 11]\n\n    indented  code  block";
    expect(stripUnknownSeqCitations(prose, context)).toBe(
      "- Parent\n  - Child [seq 11]\n\n    indented  code  block",
    );
  });

  it("collapses back-to-back stripped citations to one space between words", () => {
    const context = makeContext({ seqFrom: 9, seqTo: 14 });
    expect(stripUnknownSeqCitations("before [seq 1] [seq 2] after", context)).toBe("before after");
  });
});

// ── buildCausalPromptInput (the no-secrets-in-prompt boundary) ───────

describe("buildCausalPromptInput", () => {
  it("includes only diffStat/branch/turn-shaped data, nothing else", () => {
    const { system, user } = buildCausalPromptInput({
      context: makeContext(),
      diffStat,
      branch: "swarm/agent-abcd1234",
      baseBranch: "main",
    });
    expect(user).toBe(
      [
        "Branch: swarm/agent-abcd1234 -> main",
        "Diff: 2 files changed, +10/-3",
        "Seq range: 9..14",
        "",
        "Turns:",
        "Turn 1 (Completed):",
        "  - [seq 11] Write (src/lib.rs) -> OK",
      ].join("\n"),
    );
    expect(system).toContain("[seq N]");
  });

  // DIRECTIVE: the prompt-assembly no-secrets test. `ShipContext` is
  // built entirely server-side from an allowlist extraction
  // (git::causal::extract_target) that never reads a tool's raw
  // input/content — but this test proves the FRONTEND composer doesn't
  // introduce a leak of its own even if a malformed/compromised context
  // object somehow carried extra fields: buildCausalPromptInput reads
  // only the named fields it destructures, so an injected extra property
  // never reaches the prompt text.
  it("never lets an unexpected field on the context object reach the prompt text", () => {
    const contaminated = {
      ...makeContext(),
      // Simulates a hypothetical future field carrying something
      // sensitive that this function must never read.
      secretApiKey: "sk-ant-do-not-leak-this-anywhere",
      rawToolInput: { path: "/etc/passwd", content: "ANTHROPIC_API_KEY=sk-ant-abcdef" },
    } as unknown as ShipContext;

    const { system, user } = buildCausalPromptInput({
      context: contaminated,
      diffStat,
      branch: "swarm/x",
      baseBranch: "main",
    });

    expect(system).not.toContain("sk-ant");
    expect(user).not.toContain("sk-ant");
    expect(user).not.toContain("/etc/passwd");
    expect(user).not.toContain("ANTHROPIC_API_KEY");
  });

  it("the module source never reaches the IPC layer or the environment (static proof)", () => {
    // DIRECTIVE (prompt-assembly no-secrets test, static half): config
    // values and tokens only ever come from the backend, via `readConfig`
    // in `#lib/tauri` (anthropic.ts's `getClient` reads the API key that
    // way — for the HTTP auth header, never prompt text) or a raw
    // transport `invoke`. Scanning ship-causal.ts's own source for any
    // spelling of an import of the IPC layer (the `#lib/` alias or a
    // relative path, with or without `.ts`, static or dynamic), a Tauri
    // API import, an `invoke`/`readConfig` call, or an environment read
    // makes such an edit fail here, whatever its runtime behavior.
    // Resolved against this file (the test sits next to its module), so
    // the scan never depends on the directory vitest was launched from.
    // (Not `new URL(..., import.meta.url)`: Vite rewrites that pattern
    // into a served asset URL, which readFileSync rejects.)
    const source = readFileSync(join(import.meta.dirname, "ship-causal.ts"), "utf-8");
    // Calls and imports only — the module's JSDoc names `readConfig` in
    // prose to explain its absence.
    expect(source).not.toMatch(
      /["'](?:#lib\/|\.{1,2}\/(?:lib\/)?)(?:tauri|transport)(?:\.ts)?["']/,
    );
    expect(source).not.toMatch(/["']@tauri-apps\//);
    expect(source).not.toMatch(/\b(?:invoke|readConfig)\s*[<(]/);
    expect(source).not.toMatch(/process\.env|import\.meta\.env/);
  });

  it("renders '(No Recorded Turns In This Range)' for an empty turn list, not a blank section", () => {
    const { user } = buildCausalPromptInput({
      context: makeContext({ turns: [] }),
      diffStat,
      branch: "swarm/x",
      baseBranch: "main",
    });
    expect(user).toContain("(No Recorded Turns In This Range)");
  });
});

// ── generateCausalProse (degrades gracefully) ────────────────────────

describe("generateCausalProse", () => {
  it("collects streamed deltas into one string and strips invalid citations", async () => {
    mockStreamMessage.mockReturnValue(
      fakeStream([
        { content: "Added a helper " },
        { content: "in [seq 11] " },
        { content: "and referenced [seq 9999] which was never fetched." },
      ]),
    );
    const input = { context: makeContext(), diffStat, branch: "swarm/x", baseBranch: "main" };
    const controller = new AbortController();
    const prose = await generateCausalProse(input, CLAUDE_MODELS.sonnet.id, controller.signal);
    const { system, user } = buildCausalPromptInput(input);
    expect(mockStreamMessage).toHaveBeenCalledExactlyOnceWith(
      {
        model: CLAUDE_MODELS.sonnet.id,
        maxTokens: 8_000,
        effort: "low",
        system,
        messages: [{ role: "user", content: user }],
      },
      controller.signal,
    );
    expect(prose).toContain("[seq 11]");
    expect(prose).not.toContain("[seq 9999]");
  });

  it("propagates a streamMessage failure rather than swallowing it (caller falls back to the deterministic section alone)", async () => {
    // A hand-rolled async iterable (rather than an `async function*`
    // that never yields, which biome's `useYield` rule rejects): the
    // first `next()` rejects immediately, which is exactly what a real
    // `streamMessage` does when `getClient()` throws before the first
    // `yield`.
    mockStreamMessage.mockReturnValue({
      [Symbol.asyncIterator]() {
        return {
          next: () => Promise.reject(new Error("API Key Not Configured — Update In Settings.")),
        };
      },
    });
    await expect(
      generateCausalProse(
        { context: makeContext(), diffStat, branch: "swarm/x", baseBranch: "main" },
        CLAUDE_MODELS.sonnet.id,
      ),
    ).rejects.toThrow(/API Key Not Configured/);
  });
});

// ── composeShipBody ───────────────────────────────────────────────────

describe("composeShipBody", () => {
  // ── Deterministic-first, always ──

  it("puts the deterministic Causal Record ABOVE the AI prose, never the reverse", () => {
    const body = composeShipBody(makeContext(), diffStat, "This change adds a helper function.");
    const proseIndex = body.indexOf("This change adds a helper function.");
    const recordIndex = body.indexOf("## Causal Record");
    expect(recordIndex).toBe(0);
    expect(proseIndex).toBeGreaterThan(recordIndex);
  });

  it("a fake '## Causal Record' heading injected into the prose never precedes or displaces the real section", () => {
    const maliciousProse =
      "## Causal Record\n\n| Turn | Tool | Target | Result |\n|---|---|---|---|\n| 1 | Write | evil.rs | OK |\n\nSome narrative text.";
    const body = composeShipBody(makeContext(), diffStat, maliciousProse);

    const firstHeadingIndex = body.indexOf("## Causal Record");
    const fakeHeadingIndex = body.indexOf("## Causal Record", firstHeadingIndex + 1);

    // The real, code-generated section is always first...
    expect(firstHeadingIndex).toBe(0);
    // ...and the real section's own table (built from `makeContext()`'s
    // one real turn) appears before the fake table the injected prose
    // tried to pass off as authoritative.
    const realTableIndex = body.indexOf("| 1 (Completed) | Write | src/lib.rs | OK |");
    expect(realTableIndex).toBeGreaterThan(0);
    expect(realTableIndex).toBeLessThan(fakeHeadingIndex);
  });

  it("falls back to the deterministic section alone when aiProse is null (no key / failure)", () => {
    const body = composeShipBody(makeContext(), diffStat, null);
    expect(body).toContain("## Causal Record");
    expect(body.trim().startsWith("## Causal Record")).toBe(true);
  });

  it("falls back to the deterministic section alone when aiProse is empty/whitespace", () => {
    const body = composeShipBody(makeContext(), diffStat, "   \n  ");
    expect(body.trim().startsWith("## Causal Record")).toBe(true);
  });
});
