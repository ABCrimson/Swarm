import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ShipPreview } from "#components/ship/ShipPreview";

/** `true` makes the active transport report no webview AI chat (the `build:web` page). */
const web = vi.hoisted(() => ({ on: false }));
vi.mock(import("#lib/tauri"), async (importOriginal) => ({
  ...(await importOriginal()),
  hasCapability: () => !web.on,
}));

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
    unstaged: ["src/main.rs"],
    untracked: ["notes.env"],
    skipped: [{ path: "notes.env", reason: "Skipped — Looks Like A Credential" }],
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
    onCommitOnly: vi.fn(),
    onCommitAndPush: vi.fn(),
    onCommitPushAndOpenCompare: vi.fn(),
    context: makeContext(),
    contextState: "ready",
    onRetryContext: vi.fn(),
    aiProse: null,
    onAiProseChange: vi.fn(),
    aiProseState: "idle",
    aiProseError: null,
    onRegenerateProse: vi.fn(),
    ...overrides,
  };
  render(<ShipPreview {...props} />);
  return props;
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
    renderPreview({ context: null, contextState: "loading" });

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

  it("escapes bidi controls in an agent-supplied target", () => {
    renderPreview({
      context: makeContext({
        turns: [
          makeTurn({
            toolCalls: [{ seq: 5, name: "Bash", target: "echo \u202Etxt.exe", ok: true }],
          }),
        ],
      }),
    });

    expect(screen.getByText("echo \\u202Etxt.exe")).toHaveAttribute("title", "echo \\u202Etxt.exe");
  });

  it("surfaces an omitted-turn-count warning honestly rather than silently truncating", () => {
    renderPreview({ context: makeContext({ omittedTurnCount: 5 }) });

    expect(
      screen.getByText("Showing The Most Recent 1 Turn In This Range — Older Turns Omitted."),
    ).toBeInTheDocument();
  });

  // ── DIRECTIVE: the SQL-level truncation disclosure ──
  it("surfaces the same truncation disclosure when the fetch itself was capped, not just when turns were", () => {
    renderPreview({ context: makeContext({ omittedTurnCount: 0, eventsTruncated: true }) });

    expect(
      screen.getByText("Showing The Most Recent 1 Turn In This Range — Older Turns Omitted."),
    ).toBeInTheDocument();
  });

  // ── DIRECTIVE: "did nothing" vs. "structurally invisible" ──
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
  afterEach(() => {
    web.on = false;
  });

  it("disables Generate with the reason when the transport has no webview AI chat", async () => {
    web.on = true;
    const user = userEvent.setup();
    const props = renderPreview({ aiProse: null, aiProseState: "idle" });

    const button = screen.getByRole("button", { name: "Generate" });
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription("Available In The Desktop App Only");
    expect(
      screen.getByLabelText("What Changed / Why (AI-Generated, Editable)"),
    ).not.toHaveAttribute("placeholder", expect.stringContaining("Click Generate"));
    await user.click(button);
    expect(props.onRegenerateProse).not.toHaveBeenCalled();
  });

  it("ends a failure reason that already ends in a period with a single period", () => {
    renderPreview({
      aiProseState: "failed",
      aiProseError: "Remote Access To Secret-Shaped Config Keys Is Denied.",
    });
    expect(screen.getByRole("alert")).toHaveTextContent(/Is Denied\.$/);
    expect(screen.getByRole("alert")).not.toHaveTextContent("..");
  });

  it("shows a Generate label before any prose has been produced", () => {
    renderPreview({ aiProse: null, aiProseState: "idle" });
    expect(screen.getByText("Generate")).toBeInTheDocument();
  });

  it("shows a Regenerate label once prose exists and regenerates on click", async () => {
    const user = userEvent.setup();
    const props = renderPreview({ aiProse: "This change adds a helper.", aiProseState: "ready" });
    expect(screen.getByText("Regenerate")).toBeInTheDocument();
    expect(screen.getByDisplayValue("This change adds a helper.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Regenerate" }));
    expect(props.onRegenerateProse).toHaveBeenCalledOnce();
  });

  it("marks the generate button busy, keeps it focusable and ignores clicks while in flight", async () => {
    const user = userEvent.setup();
    const props = renderPreview({ aiProseState: "generating" });
    const button = screen.getByRole("button", { name: "Generating…" });
    expect(button).toBeEnabled();
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByText("Generating Summary…")).toHaveAttribute("role", "status");

    await user.click(button);
    expect(props.onRegenerateProse).not.toHaveBeenCalled();
  });

  it("appends the reason a generation failed", () => {
    renderPreview({
      aiProseState: "failed",
      aiProseError: "API Key Not Configured — Add It In Settings",
    });
    expect(
      screen.getByText(/Still Works\. API Key Not Configured — Add It In Settings\./),
    ).toBeInTheDocument();
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
    renderPreview({ context: null, contextState: "loading", aiProseState: "idle" });
    expect(screen.getByText("Generate").closest("button")).toBeDisabled();
  });
});

describe("ShipPreview — Causal Record load failure", () => {
  it("says the record could not be loaded (never an endless loading state) and offers a retry", async () => {
    const user = userEvent.setup();
    const props = renderPreview({ context: null, contextState: "failed" });

    expect(screen.getByText("Causal Record Could Not Be Loaded.")).toBeInTheDocument();
    expect(screen.queryByText("Loading Causal Record…")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(props.onRetryContext).toHaveBeenCalledOnce();
  });
});

describe("ShipPreview — ship action gating", () => {
  const actionNames = ["Commit Only", "Commit + Push", "Commit + Push + Open Compare Page"];

  it("enables all three actions for a shippable preflight and a non-empty message, each wired to its own handler", async () => {
    const user = userEvent.setup();
    const props = renderPreview();

    for (const name of actionNames) {
      expect(screen.getByRole("button", { name })).toBeEnabled();
    }
    await user.click(screen.getByRole("button", { name: "Commit Only" }));
    await user.click(screen.getByRole("button", { name: "Commit + Push" }));
    await user.click(screen.getByRole("button", { name: "Commit + Push + Open Compare Page" }));
    expect(props.onCommitOnly).toHaveBeenCalledOnce();
    expect(props.onCommitAndPush).toHaveBeenCalledOnce();
    expect(props.onCommitPushAndOpenCompare).toHaveBeenCalledOnce();
  });

  it("renders blockers as an alert and disables every action when preflight says it can't ship", () => {
    renderPreview({
      preflight: makePreflight({
        canShip: false,
        blockers: ["Worker Is On The Primary Checkout."],
      }),
    });

    expect(
      within(screen.getByRole("alert")).getByText("Worker Is On The Primary Checkout."),
    ).toBeInTheDocument();
    for (const name of actionNames) {
      expect(screen.getByRole("button", { name })).toBeDisabled();
    }
  });

  it("disables every action while the commit message is blank", () => {
    renderPreview({ message: "   \n " });
    for (const name of actionNames) {
      expect(screen.getByRole("button", { name })).toBeDisabled();
    }
  });

  it("disables only the compare action for a non-GitHub remote, and says why", () => {
    renderPreview({ preflight: makePreflight({ hostSupportsCompare: false }) });

    expect(screen.getByRole("button", { name: "Commit Only" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Commit + Push" })).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "Commit + Push + Open Compare Page" }),
    ).toBeDisabled();
    expect(screen.getByText("Compare Links Require A GitHub Remote")).toBeInTheDocument();
  });

  it("labels each action with only the commands that action runs", () => {
    renderPreview();
    expect(screen.getByText("Will Run: git add -- <files> · git commit")).toBeInTheDocument();
    expect(
      screen.getByText("Will Run: git add -- <files> · git commit · git push -u origin <branch>"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Will Run: git add -- <files> · git commit · git push -u origin <branch> · Open Compare Page",
      ),
    ).toBeInTheDocument();
  });
});

describe("ShipPreview — preview details and editing", () => {
  it("lists each changed file once, with its skip reason, and pluralizes the counts", () => {
    renderPreview({
      preflight: makePreflight({ ahead: 1, behind: 2, staged: ["src/main.rs"] }),
    });

    const files = within(screen.getByRole("list", { name: "Changed Files" })).getAllByRole(
      "listitem",
    );
    expect(files.map((item) => item.textContent)).toEqual([
      "src/main.rs",
      "notes.envSkipped — Looks Like A Credential",
    ]);
    expect(screen.getByText("2 Files")).toBeInTheDocument();
    expect(screen.getByText("1 Unpushed Commit")).toBeInTheDocument();
    expect(screen.getByText("2 Commits Behind")).toBeInTheDocument();
  });

  it("offers the staging-mode toggle only when files are pre-staged, reporting the choice", async () => {
    const user = userEvent.setup();
    const props = renderPreview({ preflight: makePreflight({ staged: ["src/main.rs"] }) });

    expect(screen.getByRole("button", { name: "All Changes" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await user.click(screen.getByRole("button", { name: "Already Staged" }));
    expect(props.onModeChange).toHaveBeenCalledExactlyOnceWith("staged");
  });

  it("hides the staging-mode toggle when nothing is pre-staged", () => {
    renderPreview();
    expect(screen.queryByRole("button", { name: "Already Staged" })).not.toBeInTheDocument();
  });

  it("gives both text areas a visible label and reports edits", async () => {
    const user = userEvent.setup();
    const props = renderPreview({ message: "" });

    await user.type(screen.getByLabelText("Commit Message"), "x");
    expect(props.onMessageChange).toHaveBeenLastCalledWith("x");

    await user.type(screen.getByLabelText("What Changed / Why (AI-Generated, Editable)"), "y");
    expect(props.onAiProseChange).toHaveBeenLastCalledWith("y");
  });
});

describe("ShipPreview — agent-controlled names", () => {
  it("escapes bidi controls and newlines in paths and the branch", () => {
    renderPreview({
      preflight: makePreflight({
        branch: "swarm/agent-\u202Efdp",
        staged: ["notes\u202Efdp.sh"],
        unstaged: ["a\nb.rs"],
        untracked: [],
        skipped: [],
      }),
    });
    const files = screen.getByRole("list", { name: "Changed Files" });
    expect(files).toHaveTextContent("notes\\u202Efdp.sh");
    expect(within(files).getByTitle("notes\\u202Efdp.sh")).toBeInTheDocument();
    expect(files).toHaveTextContent("a\\nb.rs");
    expect(files.textContent).not.toContain("\u202E");
    expect(screen.getByText("swarm/agent-\\u202Efdp")).toBeInTheDocument();
  });

  it("names the staging-mode group by its heading", () => {
    renderPreview({ preflight: makePreflight({ staged: ["src/main.rs"] }) });
    const group = screen.getByRole("group", { name: "Staging Mode" });
    expect(within(group).getByRole("button", { name: /All Changes/ })).toBeInTheDocument();
    expect(within(group).getByRole("button", { name: /Already Staged/ })).toBeInTheDocument();
  });

  it("escapes control characters in a blocker", () => {
    renderPreview({
      preflight: makePreflight({ canShip: false, blockers: ["Branch `a\u202Eb` Is Protected"] }),
    });
    expect(screen.getByText("Branch `a\\u202Eb` Is Protected")).toBeInTheDocument();
  });
});
