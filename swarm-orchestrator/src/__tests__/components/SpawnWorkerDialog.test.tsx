// ── SpawnWorkerDialog ────────────────────────────────
// Covers: provider switching reveals/hides the Claude Code fields,
// probe-failure disables the Claude Code option with the reported
// reason, and submit calls the right IPC wrapper (agentSpawn vs.
// spawnWorker) with the right shape per provider.

import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProbeReport } from "#lib/agent-events";

const getPersistedRepoRootMock = vi.fn<() => Promise<string | null>>();

vi.mock("#lib/project-root", () => ({
  DEFAULT_REPO_ROOT_KEY: "default_repo_root",
  getPersistedRepoRoot: () => getPersistedRepoRootMock(),
}));

vi.mock("#lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#lib/tauri")>();
  return {
    ...actual,
    agentProbe: vi.fn(),
    agentSpawn: vi.fn(),
    spawnWorker: vi.fn(),
    validateRepoRoot: vi.fn(),
    writeConfig: vi.fn(),
  };
});

import { SpawnWorkerDialog } from "#components/worker/SpawnWorkerDialog";
import { agentProbe, agentSpawn, spawnWorker } from "#lib/tauri";

const AVAILABLE: ProbeReport = { available: true, version: "1.0.0", detail: null };

async function waitForProbeSettled(): Promise<void> {
  // Every test resolves the project-root load to `null` (no persisted
  // root) so the "Loading…" placeholder always clears once effects
  // flush — a stable signal that both open-effects (probe + root load)
  // have settled before assertions run.
  await waitFor(() => {
    expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
  });
}

describe("SpawnWorkerDialog", () => {
  beforeEach(() => {
    getPersistedRepoRootMock.mockReset().mockResolvedValue(null);
    vi.mocked(agentProbe).mockReset().mockResolvedValue(AVAILABLE);
    vi.mocked(agentSpawn).mockReset().mockResolvedValue("11111111-2222-3333-8444-555555555555");
    vi.mocked(spawnWorker).mockReset().mockResolvedValue("22222222-3333-4444-8555-666666666666");
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("hides the Claude Code fields until that provider is selected, then hides them again on switch-back", async () => {
    const user = userEvent.setup();
    render(<SpawnWorkerDialog onClose={vi.fn()} />);
    await waitForProbeSettled();

    expect(screen.queryByLabelText("Model Alias")).not.toBeInTheDocument();

    await user.click(screen.getByRole("radio", { name: "Claude Code" }));

    expect(screen.getByLabelText("Model Alias")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Restricted" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Standard" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Write-Enabled" })).toBeInTheDocument();

    await user.click(screen.getByRole("radio", { name: "Webview Anthropic" }));

    expect(screen.queryByLabelText("Model Alias")).not.toBeInTheDocument();
  });

  it("disables the Claude Code option and shows the Title Case reason when agentProbe reports it unavailable", async () => {
    vi.mocked(agentProbe).mockResolvedValue({
      available: false,
      version: null,
      detail: "Claude Code CLI Not Found On PATH",
    });

    render(<SpawnWorkerDialog onClose={vi.fn()} />);
    await waitForProbeSettled();

    const claudeRadio = await screen.findByRole("radio", { name: "Claude Code" });
    await waitFor(() => expect(claudeRadio).toBeDisabled());
    expect(screen.getByText(/Claude Code Unavailable/)).toHaveTextContent(
      "Claude Code Unavailable — Claude Code CLI Not Found On PATH",
    );
  });

  it("keeps the Claude Code option enabled while the probe is still in flight", async () => {
    let resolveProbe: (report: ProbeReport) => void = () => {};
    vi.mocked(agentProbe).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveProbe = resolve;
        }),
    );

    render(<SpawnWorkerDialog onClose={vi.fn()} />);

    // Project root has already resolved (mocked to null), but the probe
    // is deliberately left pending — the option must not be disabled
    // just because a probe hasn't answered yet.
    await waitFor(() => expect(screen.queryByText("Loading…")).not.toBeInTheDocument());
    expect(screen.getByRole("radio", { name: "Claude Code" })).not.toBeDisabled();

    resolveProbe(AVAILABLE);
  });

  it("submits via spawnWorker (not agentSpawn) for the default Webview Anthropic provider", async () => {
    const user = userEvent.setup();
    const onSpawned = vi.fn();
    render(<SpawnWorkerDialog onClose={vi.fn()} onSpawned={onSpawned} />);
    await waitForProbeSettled();

    await user.click(screen.getByRole("button", { name: "Spawn Worker" }));

    await waitFor(() => expect(spawnWorker).toHaveBeenCalledTimes(1));
    expect(spawnWorker).toHaveBeenCalledWith({ name: "Worker" });
    expect(agentSpawn).not.toHaveBeenCalled();
    expect(onSpawned).toHaveBeenCalledWith("22222222-3333-4444-8555-666666666666");
  });

  it("submits via agentSpawn with the provider/model/trust-tier shape when Claude Code is selected", async () => {
    const user = userEvent.setup();
    render(<SpawnWorkerDialog onClose={vi.fn()} />);
    await waitForProbeSettled();

    await user.click(screen.getByRole("radio", { name: "Claude Code" }));

    const modelInput = screen.getByLabelText("Model Alias");
    await user.clear(modelInput);
    await user.type(modelInput, "opus");
    await user.click(screen.getByRole("radio", { name: "Write-Enabled" }));

    await user.click(screen.getByRole("button", { name: "Spawn Worker" }));

    await waitFor(() => expect(agentSpawn).toHaveBeenCalledTimes(1));
    expect(agentSpawn).toHaveBeenCalledWith(
      { name: "Worker" },
      "claude_code",
      "opus",
      "write_enabled",
    );
    expect(spawnWorker).not.toHaveBeenCalled();
  });

  it('submits via agentSpawn with provider "codex" when Codex is selected (Phase 4)', async () => {
    const user = userEvent.setup();
    render(<SpawnWorkerDialog onClose={vi.fn()} />);
    await waitForProbeSettled();

    await user.click(screen.getByRole("radio", { name: "Codex" }));

    const modelInput = screen.getByLabelText("Model Alias");
    await user.clear(modelInput);
    await user.type(modelInput, "gpt-5-codex");

    await user.click(screen.getByRole("button", { name: "Spawn Worker" }));

    await waitFor(() => expect(agentSpawn).toHaveBeenCalledTimes(1));
    expect(agentSpawn).toHaveBeenCalledWith({ name: "Worker" }, "codex", "gpt-5-codex", "standard");
    expect(spawnWorker).not.toHaveBeenCalled();
  });

  it("probes Claude Code and Codex independently — one unavailable does not disable the other (Phase 4)", async () => {
    vi.mocked(agentProbe).mockImplementation((provider) =>
      Promise.resolve(
        provider === "codex"
          ? { available: false, version: null, detail: "Codex CLI Not Found On PATH" }
          : AVAILABLE,
      ),
    );

    render(<SpawnWorkerDialog onClose={vi.fn()} />);
    await waitForProbeSettled();

    const codexRadio = await screen.findByRole("radio", { name: "Codex" });
    await waitFor(() => expect(codexRadio).toBeDisabled());
    expect(screen.getByRole("radio", { name: "Claude Code" })).not.toBeDisabled();
    expect(screen.getByText(/Codex Unavailable/)).toHaveTextContent(
      "Codex Unavailable — Codex CLI Not Found On PATH",
    );
  });

  it("includes repoRoot in the spawn options once a project root has loaded", async () => {
    getPersistedRepoRootMock.mockResolvedValue("/repo/root");
    const { validateRepoRoot } = await import("#lib/tauri");
    vi.mocked(validateRepoRoot).mockResolvedValue("/repo/root");

    const user = userEvent.setup();
    render(<SpawnWorkerDialog onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("/repo/root")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Spawn Worker" }));

    await waitFor(() => expect(spawnWorker).toHaveBeenCalledTimes(1));
    expect(spawnWorker).toHaveBeenCalledWith({ name: "Worker", repoRoot: "/repo/root" });
  });

  it("shows a spawn failure inline rather than guessing a cause, and does not close the dialog", async () => {
    vi.mocked(spawnWorker).mockRejectedValue(new Error("boom"));
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<SpawnWorkerDialog onClose={onClose} />);
    await waitForProbeSettled();

    await user.click(screen.getByRole("button", { name: "Spawn Worker" }));

    expect(await screen.findByText("Spawn Failed: boom")).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("calls onClose without spawning when Cancel is clicked", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<SpawnWorkerDialog onClose={onClose} />);
    await waitForProbeSettled();

    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(spawnWorker).not.toHaveBeenCalled();
    expect(agentSpawn).not.toHaveBeenCalled();
  });

  it("closes on Escape", async () => {
    const onClose = vi.fn();
    render(<SpawnWorkerDialog onClose={onClose} />);
    await waitForProbeSettled();

    await act(async () => {
      const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true });
      document.dispatchEvent(event);
    });

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
