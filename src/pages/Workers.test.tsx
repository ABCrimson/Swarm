import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getDefaultStore } from "jotai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_KEYBINDINGS } from "#lib/keybindings";
import { Workers } from "#pages/Workers";
import type { Worker } from "#store/types";
import {
  detailPanelOpenAtom,
  graphViewAtom,
  keybindingsAtom,
  selectedWorkerIdAtom,
} from "#store/ui";
import { useWorkerStore } from "#store/workers";

vi.mock("#components/graph/WorkerGraph", () => ({
  WorkerGraph: () => <p>Graph View</p>,
}));
vi.mock("#components/graph/WorkerDetail", () => ({
  WorkerDetail: ({ worker }: { worker: Worker }) => <p>Detail Of {worker.name}</p>,
}));
vi.mock("#components/ai/WorkerAIPanel", async () => {
  const { useState } = await import("react");
  return {
    WorkerAIPanel: () => {
      const [draft, setDraft] = useState("");
      return (
        <input aria-label="Chat Draft" value={draft} onChange={(e) => setDraft(e.target.value)} />
      );
    },
  };
});
vi.mock("#components/ship/ShipPanel", () => ({ ShipPanel: () => <p>Ship View</p> }));
vi.mock("#components/graph/CausalityPanel", () => ({ CausalityPanel: () => null }));
vi.mock("#components/worker/SpawnWorkerDialog", () => ({ SpawnWorkerDialog: () => null }));

const store = getDefaultStore();
const ID = "0f5b8f5e-7a41-4a8e-9a53-1c1f7e0d9a11";
const OTHER_ID = "5d0c2a7e-3b1f-4c9d-8e2a-6f4b1a9c0d22";

function addWorker(patch: Partial<Worker> = {}): Worker {
  const worker: Worker = {
    id: ID,
    state: "running",
    name: "Builder",
    startedAt: "2026-09-23T00:00:00Z",
    ...patch,
  };
  useWorkerStore.setState({ workers: new Map([[worker.id, worker]]) });
  return worker;
}

beforeEach(() => {
  useWorkerStore.setState({ workers: new Map() });
  store.set(graphViewAtom, "graph");
  store.set(detailPanelOpenAtom, false);
  store.set(selectedWorkerIdAtom, null);
  store.set(keybindingsAtom, DEFAULT_KEYBINDINGS);
});

describe("Workers — view tabs", () => {
  it("is a tablist whose tabs control their panels", async () => {
    const user = userEvent.setup();
    render(<Workers />);

    const tablist = screen.getByRole("tablist", { name: "Worker View" });
    const graphTab = within(tablist).getByRole("tab", { name: "Graph" });
    expect(graphTab).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel", { name: "Graph" })).toHaveTextContent("Graph View");

    await user.click(within(tablist).getByRole("tab", { name: "List" }));

    expect(store.get(graphViewAtom)).toBe("list");
    expect(screen.getByRole("tabpanel", { name: "List" })).toHaveTextContent("No Workers Running");
  });

  it("switches views with the remappable shortcut", async () => {
    const user = userEvent.setup();
    render(<Workers />);

    await user.keyboard("{Control>}{Shift>}g{/Shift}{/Control}");
    expect(store.get(graphViewAtom)).toBe("list");

    store.set(keybindingsAtom, { ...DEFAULT_KEYBINDINGS, graphToggle: "alt+v" });
    await user.keyboard("{Alt>}v{/Alt}");
    expect(store.get(graphViewAtom)).toBe("graph");
  });

  it("names the current command-palette binding in the empty-state hint", () => {
    store.set(graphViewAtom, "list");
    render(<Workers />);
    // After mount: the storage-backed atom re-reads its initial value on mount.
    act(() => store.set(keybindingsAtom, { ...DEFAULT_KEYBINDINGS, commandPalette: "alt+p" }));

    expect(screen.getByText('Click "Spawn Worker" Or Press Alt+P')).toBeInTheDocument();
  });
});

describe("Workers — list and detail panel", () => {
  it("opens the detail panel for a clicked worker and marks it current", async () => {
    const user = userEvent.setup();
    addWorker();
    store.set(graphViewAtom, "list");
    render(<Workers />);

    const row = screen.getByRole("button", { name: /Builder/ });
    await user.click(row);

    expect(row).toHaveAttribute("aria-current", "true");
    const details = screen.getByRole("complementary", { name: "Worker Details" });
    expect(within(details).getByRole("tabpanel", { name: "Detail" })).toHaveTextContent(
      "Detail Of Builder",
    );
  });

  it("disables Ship without a worktree and keeps the chat draft across tab switches", async () => {
    const user = userEvent.setup();
    addWorker();
    store.set(selectedWorkerIdAtom, ID);
    store.set(detailPanelOpenAtom, true);
    render(<Workers />);

    const panels = screen.getByRole("tablist", { name: "Worker Panels" });
    const ship = within(panels).getByRole("tab", { name: "Ship" });
    expect(ship).toBeDisabled();
    expect(document.getElementById(ship.getAttribute("aria-controls") ?? "")).not.toBeNull();

    await user.click(within(panels).getByRole("tab", { name: "AI Chat" }));
    await user.type(screen.getByLabelText("Chat Draft"), "half a thought");
    await user.click(within(panels).getByRole("tab", { name: "Detail" }));
    await user.click(within(panels).getByRole("tab", { name: "AI Chat" }));

    expect(screen.getByLabelText("Chat Draft")).toHaveValue("half a thought");
  });

  it("does not carry one worker's chat draft over to another worker", async () => {
    const user = userEvent.setup();
    addWorker();
    useWorkerStore.setState(({ workers }) => ({
      workers: new Map(workers).set(OTHER_ID, {
        id: OTHER_ID,
        state: "idle",
        name: "Reviewer",
        startedAt: "2026-09-23T00:00:00Z",
      }),
    }));
    store.set(graphViewAtom, "list");
    render(<Workers />);

    await user.click(screen.getByRole("button", { name: /Builder/ }));
    await user.click(screen.getByRole("tab", { name: "AI Chat" }));
    await user.type(screen.getByLabelText("Chat Draft"), "for builder only");
    await user.click(screen.getByRole("tab", { name: "Detail" }));
    await user.click(screen.getByRole("button", { name: /Reviewer/ }));
    await user.click(screen.getByRole("tab", { name: "AI Chat" }));

    expect(screen.getByLabelText("Chat Draft")).toHaveValue("");
  });

  it("offers Ship for a worker with a worktree", async () => {
    const user = userEvent.setup();
    addWorker({ worktreePath: "/tmp/wt", branch: "swarm/builder-0f5b8f5e" });
    store.set(selectedWorkerIdAtom, ID);
    store.set(detailPanelOpenAtom, true);
    render(<Workers />);

    await user.click(screen.getByRole("tab", { name: "Ship" }));

    expect(screen.getByRole("tabpanel", { name: "Ship" })).toHaveTextContent("Ship View");
  });
});

describe("Workers — Trojan Source", () => {
  it("shows a list row's name and branch with bidi overrides as escaped data", async () => {
    addWorker({ name: "a\u202Eb", branch: "swarm/c\u202Ed" });
    store.set(graphViewAtom, "list");
    render(<Workers />);

    const panel = screen.getByRole("tabpanel", { name: "List" });
    expect(within(panel).getByText(String.raw`a\u202Eb`)).toBeInTheDocument();
    const branch = within(panel).getByText(String.raw`swarm/c\u202Ed`);
    expect(branch.closest("[title]")).toHaveAttribute("title", String.raw`swarm/c\u202Ed`);
    expect(panel.textContent).not.toContain("\u202E");
  });
});
