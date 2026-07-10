// ── WorkerDetail Control Tests ──────────────────────
//
// Covers batch-1 feedback finding 1: the flagship Kill/Pause/Resume
// controls in the Workers → List → Detail panel were migrated from
// `.swarm-btn` to the shared `Pill` component (see
// src/components/graph/WorkerDetail.tsx) but had no dedicated test
// file. These tests assert: (a) Kill renders as a real, interactive
// button with `data-tone="danger"`; (b) clicking Kill invokes the
// underlying kill IPC handler; (c) Pause/Resume render with their
// correct (neutral) tone and their state-dependent `disabled` wiring
// is correct; (d) accessible names stay Title Case ("Kill", "Pause",
// "Resume").

import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkerDetail } from "#components/graph/WorkerDetail";
import type { Worker } from "#store/types";
import { useWorkerStore } from "#store/workers";

// Mock the Tauri IPC commands used by useWorker (same pattern as
// src/__tests__/hooks/useWorker.test.tsx and src/__tests__/hooks/useStream.test.tsx —
// module-scope `mock`-prefixed refs so assertions can use them directly).
const mockPauseWorker = vi.fn().mockResolvedValue(undefined);
const mockResumeWorker = vi.fn().mockResolvedValue(undefined);
const mockKillWorker = vi.fn().mockResolvedValue(undefined);
vi.mock("#lib/tauri", () => ({
  pauseWorker: (...args: unknown[]) => mockPauseWorker(...args),
  resumeWorker: (...args: unknown[]) => mockResumeWorker(...args),
  killWorker: (...args: unknown[]) => mockKillWorker(...args),
  spawnWorker: vi.fn().mockResolvedValue("mock-id"),
}));

function createWorker(overrides?: Partial<Worker>): Worker {
  return {
    id: crypto.randomUUID(),
    state: "running",
    name: "test-worker",
    startedAt: new Date().toISOString(),
    ...overrides,
  };
}

function resetStore(): void {
  act(() => {
    const state = useWorkerStore.getState();
    for (const [id] of state.workers) {
      state.removeWorker(id);
    }
    state.selectWorker(null);
  });
}

function seedWorker(worker: Worker): void {
  act(() => {
    useWorkerStore.getState().addWorker(worker);
  });
}

describe("WorkerDetail", () => {
  beforeEach(resetStore);
  afterEach(() => {
    resetStore();
    vi.clearAllMocks();
  });

  it('renders Kill as a real, interactive button with data-tone="danger"', () => {
    const worker = createWorker();
    seedWorker(worker);
    render(<WorkerDetail worker={worker} />);

    const killButton = screen.getByRole("button", { name: "Kill" });
    expect(killButton.tagName).toBe("BUTTON");
    expect(killButton).toHaveAttribute("data-tone", "danger");
    expect(killButton).toHaveAttribute("data-interactive", "true");
  });

  it("invokes the kill IPC handler when Kill is clicked", async () => {
    const user = userEvent.setup();
    const worker = createWorker();
    seedWorker(worker);
    render(<WorkerDetail worker={worker} />);

    await user.click(screen.getByRole("button", { name: "Kill" }));

    expect(mockKillWorker).toHaveBeenCalledTimes(1);
    expect(mockKillWorker).toHaveBeenCalledWith(worker.id);
  });

  it("Kill stays enabled regardless of worker state (always available)", () => {
    const worker = createWorker({ state: "idle" });
    seedWorker(worker);
    render(<WorkerDetail worker={worker} />);

    expect(screen.getByRole("button", { name: "Kill" })).toBeEnabled();
  });

  it("renders Pause and Resume with neutral tone", () => {
    const worker = createWorker({ state: "running" });
    seedWorker(worker);
    render(<WorkerDetail worker={worker} />);

    expect(screen.getByRole("button", { name: "Pause" })).toHaveAttribute("data-tone", "neutral");
    expect(screen.getByRole("button", { name: "Resume" })).toHaveAttribute("data-tone", "neutral");
  });

  it("enables Pause and disables Resume when the worker is running", () => {
    const worker = createWorker({ state: "running" });
    seedWorker(worker);
    render(<WorkerDetail worker={worker} />);

    expect(screen.getByRole("button", { name: "Pause" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Resume" })).toBeDisabled();
  });

  it("enables Resume and disables Pause when the worker is paused", () => {
    const worker = createWorker({ state: "paused" });
    seedWorker(worker);
    render(<WorkerDetail worker={worker} />);

    expect(screen.getByRole("button", { name: "Resume" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Pause" })).toBeDisabled();
  });

  it("disables both Pause and Resume when the worker is idle", () => {
    const worker = createWorker({ state: "idle" });
    seedWorker(worker);
    render(<WorkerDetail worker={worker} />);

    expect(screen.getByRole("button", { name: "Pause" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Resume" })).toBeDisabled();
  });

  it("invokes the pause IPC handler when Pause is clicked and enabled", async () => {
    const user = userEvent.setup();
    const worker = createWorker({ state: "running" });
    seedWorker(worker);
    render(<WorkerDetail worker={worker} />);

    await user.click(screen.getByRole("button", { name: "Pause" }));

    expect(mockPauseWorker).toHaveBeenCalledWith(worker.id);
  });

  it("invokes the resume IPC handler when Resume is clicked and enabled", async () => {
    const user = userEvent.setup();
    const worker = createWorker({ state: "paused" });
    seedWorker(worker);
    render(<WorkerDetail worker={worker} />);

    await user.click(screen.getByRole("button", { name: "Resume" }));

    expect(mockResumeWorker).toHaveBeenCalledWith(worker.id);
  });

  it("does not invoke the resume IPC handler when Resume is disabled", async () => {
    const user = userEvent.setup();
    const worker = createWorker({ state: "running" });
    seedWorker(worker);
    render(<WorkerDetail worker={worker} />);

    await user.click(screen.getByRole("button", { name: "Resume" }));

    expect(mockResumeWorker).not.toHaveBeenCalled();
  });

  it("keeps Title Case accessible names for Kill, Pause, and Resume", () => {
    const worker = createWorker({ state: "running" });
    seedWorker(worker);
    render(<WorkerDetail worker={worker} />);

    expect(screen.getByRole("button", { name: "Kill" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pause" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Resume" })).toBeInTheDocument();
  });
});
