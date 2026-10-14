// SpawnWorkerDialog: a native modal <dialog>; provider switching reveals
// the agent fields, an unavailable or failed probe disables its provider
// with the reason, a failed project-root read still lets you spawn, and
// submit calls the right IPC wrapper with the right shape per provider.

import "#test/dom-polyfills";
import { open as openFolderPicker } from "@tauri-apps/plugin-dialog";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProbeReport } from "#lib/agent-events";

const getPersistedRepoRootMock = vi.fn<() => Promise<string | null>>();

vi.mock(import("#lib/project-root"), () => ({
  DEFAULT_REPO_ROOT_KEY: "default_repo_root" as const,
  getPersistedRepoRoot: () => getPersistedRepoRootMock(),
}));

const web = vi.hoisted(() => ({ on: false }));

vi.mock(import("#lib/tauri"), async (importOriginal) => ({
  ...(await importOriginal()),
  hasCapability: () => !web.on,
  agentProbe: vi.fn(),
  agentSpawn: vi.fn(),
  spawnWorker: vi.fn(),
  validateRepoRoot: vi.fn(),
  writeConfig: vi.fn(),
}));

import { SpawnWorkerDialog } from "#components/worker/SpawnWorkerDialog";
import {
  AgentSpawnCommandError,
  agentProbe,
  agentSpawn,
  spawnWorker,
  validateRepoRoot,
} from "#lib/tauri";

const AVAILABLE: ProbeReport = { available: true, version: "1.0.0", detail: null };

async function waitForProbeSettled(): Promise<void> {
  // Callers leave the project-root load at its `null` default (no
  // persisted root), so the "Loading…" placeholder clears once effects
  // flush — a stable signal that both open-effects (probe + root load)
  // have settled before assertions run. Tests that load or reject a root
  // wait on the root text or the alert instead.
  await waitFor(() => {
    expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
  });
}

describe("SpawnWorkerDialog", () => {
  beforeEach(() => {
    web.on = false;
    getPersistedRepoRootMock.mockReset().mockResolvedValue(null);
    vi.mocked(agentProbe).mockReset().mockResolvedValue(AVAILABLE);
    vi.mocked(agentSpawn).mockReset().mockResolvedValue("11111111-2222-3333-8444-555555555555");
    vi.mocked(spawnWorker).mockReset().mockResolvedValue("22222222-3333-4444-8555-666666666666");
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("opens as a modal dialog labelled by its title", async () => {
    render(<SpawnWorkerDialog onClose={vi.fn()} />);
    await waitForProbeSettled();

    const dialog = screen.getByRole("dialog", { name: "Spawn Worker" });
    expect(dialog.tagName).toBe("DIALOG");
    expect(dialog).toHaveAttribute("open");
  });

  it("disables a provider whose probe rejects, instead of leaving it enabled as if still probing", async () => {
    vi.mocked(agentProbe).mockImplementation((provider) =>
      provider === "claude_code"
        ? Promise.reject(new Error("ipc down"))
        : Promise.resolve(AVAILABLE),
    );
    render(<SpawnWorkerDialog onClose={vi.fn()} />);

    await waitFor(() => expect(screen.getByRole("radio", { name: "Claude Code" })).toBeDisabled());
    expect(screen.getByText(/Claude Code Unavailable/)).toHaveTextContent(
      "Claude Code Unavailable — Probe Failed: ipc down",
    );
    expect(screen.getByRole("radio", { name: "Codex" })).toBeEnabled();
  });

  it("stops loading and allows spawning when reading the saved project root fails", async () => {
    getPersistedRepoRootMock.mockRejectedValue(new Error("config unreadable"));
    render(<SpawnWorkerDialog onClose={vi.fn()} />);

    expect(
      await screen.findByText("No Project Root — Spawns Without Worktree Isolation"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Spawn Worker" })).toBeEnabled();
    // In-dialog, not a toast: a modal dialog hides the page-level toaster.
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Could Not Read The Saved Project Root: config unreadable",
    );
  });

  it("names the real cause when validating the saved project root fails", async () => {
    getPersistedRepoRootMock.mockResolvedValue("/repo/root");
    vi.mocked(validateRepoRoot).mockRejectedValue(new Error("git not found"));
    render(<SpawnWorkerDialog onClose={vi.fn()} />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could Not Validate The Saved Project Root /repo/root: git not found",
    );
  });

  it("shows a failed folder pick inside the dialog and clears it once a root is accepted", async () => {
    const user = userEvent.setup();
    vi.mocked(openFolderPicker).mockResolvedValue("/not/a/repo");
    vi.mocked(validateRepoRoot).mockRejectedValueOnce("not inside a repository");
    render(<SpawnWorkerDialog onClose={vi.fn()} />);
    await waitForProbeSettled();

    await user.click(screen.getByRole("button", { name: "Choose…" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could Not Use /not/a/repo As The Project Root: not inside a repository",
    );

    vi.mocked(openFolderPicker).mockResolvedValue("/repo/root");
    vi.mocked(validateRepoRoot).mockResolvedValueOnce("/repo/root");
    await user.click(screen.getByRole("button", { name: "Choose…" }));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(screen.getByText("/repo/root")).toBeInTheDocument();
  });

  it("shows a rejected folder picker inside the dialog", async () => {
    const user = userEvent.setup();
    vi.mocked(openFolderPicker).mockRejectedValueOnce(new Error("dialog unavailable"));
    render(<SpawnWorkerDialog onClose={vi.fn()} />);
    await waitForProbeSettled();

    await user.click(screen.getByRole("button", { name: "Choose…" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could Not Open The Folder Picker: dialog unavailable",
    );
    expect(validateRepoRoot).not.toHaveBeenCalled();
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
    const probe = Promise.withResolvers<ProbeReport>();
    vi.mocked(agentProbe).mockImplementation(() => probe.promise);

    render(<SpawnWorkerDialog onClose={vi.fn()} />);

    // Project root has already resolved (mocked to null), but the probe
    // is deliberately left pending — the option must not be disabled
    // just because a probe hasn't answered yet.
    await waitFor(() => expect(screen.queryByText("Loading…")).not.toBeInTheDocument());
    expect(screen.getByRole("radio", { name: "Claude Code" })).not.toBeDisabled();

    probe.resolve(AVAILABLE);
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

  it('submits via agentSpawn with provider "codex" when Codex is selected', async () => {
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

  it("leaves the Codex model blank by default so Codex runs its own configured default", async () => {
    const user = userEvent.setup();
    render(<SpawnWorkerDialog onClose={vi.fn()} />);
    await waitForProbeSettled();

    await user.click(screen.getByRole("radio", { name: "Codex" }));
    expect(screen.getByLabelText("Model Alias")).toHaveValue("");
    await user.click(screen.getByRole("radio", { name: /^Write-Enabled/ }));
    await user.click(screen.getByRole("button", { name: "Spawn Worker" }));

    await waitFor(() =>
      expect(agentSpawn).toHaveBeenCalledWith(
        { name: "Worker" },
        "codex",
        undefined,
        "write_enabled",
      ),
    );
  });

  it("closes itself (firing onClose once) after a successful spawn", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<SpawnWorkerDialog onClose={onClose} />);
    await waitForProbeSettled();

    await user.click(screen.getByRole("button", { name: "Spawn Worker" }));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("dialog", { hidden: true })).not.toHaveAttribute("open");
  });

  it("probes Claude Code and Codex independently — one unavailable does not disable the other", async () => {
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

    expect(await screen.findByRole("alert")).toHaveTextContent("Spawn Failed: boom");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("reports a spawn without a transport inline instead of closing silently", async () => {
    vi.mocked(spawnWorker).mockResolvedValue(null);
    const onClose = vi.fn();
    const onSpawned = vi.fn();
    const user = userEvent.setup();
    render(<SpawnWorkerDialog onClose={onClose} onSpawned={onSpawned} />);
    await waitForProbeSettled();

    await user.click(screen.getByRole("button", { name: "Spawn Worker" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Spawn Failed: No Backend Transport Available.",
    );
    expect(onClose).not.toHaveBeenCalled();
    expect(onSpawned).not.toHaveBeenCalled();
  });

  it("hands over the surviving PTY worker when only the agent session failed to attach", async () => {
    vi.mocked(agentProbe).mockResolvedValue(AVAILABLE);
    vi.mocked(agentSpawn).mockRejectedValue(
      new AgentSpawnCommandError("w-survivor", "Not Signed In"),
    );
    const onClose = vi.fn();
    const onSpawned = vi.fn();
    const user = userEvent.setup();
    render(<SpawnWorkerDialog onClose={onClose} onSpawned={onSpawned} />);
    await waitForProbeSettled();
    await user.click(screen.getByRole("radio", { name: "Claude Code" }));

    await user.click(screen.getByRole("button", { name: "Spawn Worker" }));

    await waitFor(() => expect(onSpawned).toHaveBeenCalledWith("w-survivor"));
    expect(onClose).toHaveBeenCalledTimes(1);
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

  it("refuses every dismissal while a spawn is in flight, then closes when it succeeds", async () => {
    const pending = Promise.withResolvers<string | null>();
    vi.mocked(spawnWorker).mockImplementation(() => pending.promise);
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<SpawnWorkerDialog onClose={onClose} />);
    await waitForProbeSettled();

    await user.click(screen.getByRole("button", { name: "Spawn Worker" }));

    const closeButton = screen.getByRole("button", { name: "Close Spawn Worker Dialog" });
    await waitFor(() => expect(closeButton).toBeDisabled());
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    await user.click(closeButton);
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Spawn Worker" })).toHaveAttribute("open");

    await act(async () => pending.resolve("22222222-3333-4444-8555-666666666666"));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("closes from the header close button when no spawn is in flight", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<SpawnWorkerDialog onClose={onClose} />);
    await waitForProbeSettled();

    await user.click(screen.getByRole("button", { name: "Close Spawn Worker Dialog" }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("in web mode disables Webview Anthropic with the desktop-only reason and defaults to Claude Code", async () => {
    web.on = true;
    const user = userEvent.setup();
    render(<SpawnWorkerDialog onClose={vi.fn()} />);
    await waitForProbeSettled();

    const webview = screen.getByRole("radio", { name: "Webview Anthropic" });
    expect(webview).toBeDisabled();
    expect(webview).not.toBeChecked();
    expect(screen.getByRole("radio", { name: "Claude Code" })).toBeChecked();
    expect(screen.getByText(/Webview Anthropic Unavailable/)).toHaveTextContent(
      "Webview Anthropic Unavailable — Available In The Desktop App Only",
    );

    await user.click(screen.getByRole("button", { name: "Spawn Worker" }));
    await waitFor(() => expect(agentSpawn).toHaveBeenCalledTimes(1));
    expect(spawnWorker).not.toHaveBeenCalled();
  });

  it("in web mode refuses a webview spawn when the default is unusable too", async () => {
    web.on = true;
    vi.mocked(agentProbe).mockResolvedValue({ available: false, version: null, detail: "Missing" });
    const user = userEvent.setup();
    render(<SpawnWorkerDialog onClose={vi.fn()} />);
    await waitForProbeSettled();
    await waitFor(() => expect(screen.getByRole("radio", { name: "Claude Code" })).toBeDisabled());

    expect(screen.getByRole("button", { name: "Spawn Worker" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Spawn Worker" }));
    expect(spawnWorker).not.toHaveBeenCalled();
  });

  it("in web mode disables the folder picker with the desktop-only reason but still shows the saved root", async () => {
    web.on = true;
    getPersistedRepoRootMock.mockResolvedValue("/repo/root");
    vi.mocked(validateRepoRoot).mockResolvedValue("/repo/root");
    render(<SpawnWorkerDialog onClose={vi.fn()} />);

    expect(await screen.findByText("/repo/root")).toBeInTheDocument();
    const choose = screen.getByRole("button", { name: "Choose…" });
    expect(choose).toBeDisabled();
    expect(choose).toHaveAccessibleDescription("Available In The Desktop App Only");
    expect(choose).not.toHaveAttribute("title");
    expect(screen.getByText("Available In The Desktop App Only")).toBeVisible();
  });

  it("on desktop keeps Webview Anthropic selected by default and the folder picker enabled", async () => {
    render(<SpawnWorkerDialog onClose={vi.fn()} />);
    await waitForProbeSettled();

    expect(screen.getByRole("radio", { name: "Webview Anthropic" })).toBeChecked();
    expect(screen.getByRole("button", { name: "Choose…" })).toBeEnabled();
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

describe("SpawnWorkerDialog — Trojan Source", () => {
  beforeEach(() => {
    web.on = false;
    getPersistedRepoRootMock.mockReset();
    vi.mocked(agentProbe).mockReset().mockResolvedValue(AVAILABLE);
  });

  it("shows the project root with a bidi override as escaped data, and in its notice", async () => {
    const user = userEvent.setup();
    getPersistedRepoRootMock.mockResolvedValue("/repo/a\u202Eb");
    vi.mocked(validateRepoRoot).mockResolvedValue("/repo/a\u202Eb");
    render(<SpawnWorkerDialog onClose={vi.fn()} />);

    const root = await screen.findByText(String.raw`/repo/a\u202Eb`);
    expect(root).toHaveAttribute("title", String.raw`/repo/a\u202Eb`);

    vi.mocked(openFolderPicker).mockResolvedValue("/not/c\u202Ed");
    vi.mocked(validateRepoRoot).mockRejectedValueOnce(
      new Error("/not/c\u202Ed is not inside a git repository"),
    );
    await user.click(screen.getByRole("button", { name: "Choose…" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      String.raw`Could Not Use /not/c\u202Ed As The Project Root: /not/c\u202Ed is not inside a git repository`,
    );
    expect(alert.textContent).not.toContain(String.fromCharCode(0x202e));
  });
});
