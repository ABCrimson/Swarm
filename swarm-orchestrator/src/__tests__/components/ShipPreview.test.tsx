import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ShipPreview } from "#components/ship/ShipPreview";
import type { CausalTurn, ShipContext, ShipPreflight } from "#store/types";

function makePreflight(overrides: Partial<ShipPreflight> = {}): ShipPreflight {
  return {
    workerId: "11111111-2222-3333-8444-555555555555",
    branch: "swarm/agent-abcd1234",
    baseBranch: "main",
    remote: "https://github.com/example/repo.git",
    host: "github.com",
    hostSupportsCompare: true,
    upstream: null,
    ahead: 0,
    behind: 0,
    staged: [],
    unstaged: [],
    untracked: [],
    skipped: [],
    diffStat: { filesChanged: 2, insertions: 10, deletions: 3 },
    canShip: true,
    blockers: [],
    ...overrides,
  };
}

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

function renderPreview(overrides: Partial<React.ComponentProps<typeof ShipPreview>> = {}) {
  const props: React.ComponentProps<typeof ShipPreview> = {
    preflight: makePreflight(),
    message: "feat: add feature",
    onMessageChange: vi.fn(),
    mode: "all",
    onModeChange: vi.fn(),
    busy: false,
    onCommitOnly: vi.fn(),
    onCommitAndPush: vi.fn(),
    onCommitPushAndOpenCompare: vi.fn(),
    context: makeContext(),
    aiProse: null,
    onAiProseChange: vi.fn(),
    aiProseState: "idle",
    onRegenerateProse: vi.fn(),
    ...overrides,
  };
  return render(<ShipPreview {...props} />);
}

describe("ShipPreview — Causal Record section", () => {
  it("renders the seq range, turn count, and a tool-call row for a populated context", () => {
    renderPreview();

    expect(screen.getByText("9..14")).toBeInTheDocument();
    expect(screen.getByText("1 Turn")).toBeInTheDocument();
    expect(screen.getByText("Write")).toBeInTheDocument();
    expect(screen.getByText("src/lib.rs")).toBeInTheDocument();
    expect(screen.getByText("OK")).toBeInTheDocument();
  });

  it("renders a distinct loading state while context is null, never an empty table", () => {
    renderPreview({ context: null });

    expect(screen.getByText("Loading Causal Record…")).toBeInTheDocument();
    expect(screen.queryByText("Causal Record Unavailable For This Range")).not.toBeInTheDocument();
  });

  // ── DIRECTIVE: the empty-range honest degradation ───────────────────
  it("renders the honest unavailable message for a genuinely empty range, distinct from the loading state", () => {
    renderPreview({ context: makeContext({ turns: [] }) });

    expect(
      screen.getByText(/Causal Record Unavailable For This Range — No Recorded Agent Turns\./),
    ).toBeInTheDocument();
    expect(screen.queryByText("Loading Causal Record…")).not.toBeInTheDocument();
  });

  it("surfaces an omitted-turn-count warning honestly rather than silently truncating", () => {
    renderPreview({ context: makeContext({ omittedTurnCount: 5 }) });

    expect(
      screen.getByText("Showing The Most Recent 1 Turn In This Range — Older Turns Omitted."),
    ).toBeInTheDocument();
  });

  // ── DIRECTIVE (review FIX-1): SQL-level truncation, same disclosure ──
  it("surfaces the same truncation disclosure when the fetch itself was capped, not just when turns were", () => {
    renderPreview({ context: makeContext({ omittedTurnCount: 0, eventsTruncated: true }) });

    expect(
      screen.getByText("Showing The Most Recent 1 Turn In This Range — Older Turns Omitted."),
    ).toBeInTheDocument();
  });

  // ── DIRECTIVE (review NIT-4): "did nothing" vs. "structurally invisible" ──
  it("renders the webview-chat-path message instead of 'did nothing' when the worker had uncaptured webview activity", () => {
    renderPreview({
      context: makeContext({ turns: [], hasUncapturedWebviewActivity: true }),
    });

    expect(
      screen.getByText(
        "This Worker's Activity Is Not Captured In The Causal Record (Webview Chat Path).",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/No Recorded Agent Turns/)).not.toBeInTheDocument();
  });

  it("renders an Error badge and an em-dash target for a failed, target-less tool call", () => {
    renderPreview({
      context: makeContext({
        turns: [makeTurn({ toolCalls: [{ seq: 5, name: "Read", target: null, ok: false }] })],
      }),
    });

    expect(screen.getByText("Read")).toBeInTheDocument();
    expect(screen.getByText("Error")).toBeInTheDocument();
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("renders a Pending badge for a tool call with no observed result yet", () => {
    renderPreview({
      context: makeContext({
        turns: [makeTurn({ toolCalls: [{ seq: 5, name: "Bash", target: "pnpm test", ok: null }] })],
      }),
    });

    expect(screen.getByText("Pending")).toBeInTheDocument();
  });
});

describe("ShipPreview — AI prose section", () => {
  it("shows a Generate label before any prose has been produced", () => {
    renderPreview({ aiProse: null, aiProseState: "idle" });
    expect(screen.getByText("Generate")).toBeInTheDocument();
  });

  it("shows a Regenerate label once prose exists", () => {
    renderPreview({ aiProse: "This change adds a helper.", aiProseState: "ready" });
    expect(screen.getByText("Regenerate")).toBeInTheDocument();
    expect(screen.getByDisplayValue("This change adds a helper.")).toBeInTheDocument();
  });

  it("disables the generate button and shows a generating label while in flight", () => {
    renderPreview({ aiProseState: "generating" });
    const button = screen.getByText("Generating…");
    expect(button).toBeInTheDocument();
    expect(button.closest("button")).toBeDisabled();
  });

  it("surfaces a failure message without blocking the rest of the preview from rendering", () => {
    renderPreview({ aiProseState: "failed" });
    expect(
      screen.getByText(/Generation Failed — Shipping With The Causal Record Alone Still Works\./),
    ).toBeInTheDocument();
    // The rest of the preview (actions) is still present — a prose
    // failure never disables shipping.
    expect(screen.getByText("Commit Only")).toBeInTheDocument();
  });

  it("disables the generate button while context hasn't loaded yet", () => {
    renderPreview({ context: null, aiProseState: "idle" });
    expect(screen.getByText("Generate").closest("button")).toBeDisabled();
  });
});
