import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { useEffect, useEffectEvent, useId, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { WorkerAIPanel } from "#components/ai/WorkerAIPanel";
import { CausalityPanel } from "#components/graph/CausalityPanel";
import { WorkerDetail } from "#components/graph/WorkerDetail";
import { WorkerGraph } from "#components/graph/WorkerGraph";
import { ShipPanel } from "#components/ship/ShipPanel";
import { Badge, stateLabels } from "#components/ui/Badge";
import { Button } from "#components/ui/Button";
import { Pill } from "#components/ui/Pill";
import { type TabItem, TabList, TabPanel } from "#components/ui/Tabs";
import { ProviderBadge } from "#components/worker/ProviderBadge";
import { SpawnWorkerDialog } from "#components/worker/SpawnWorkerDialog";
import { escapeForDisplay } from "#lib/display-escape";
import { formatBinding, matchesBinding } from "#lib/keybindings";
import { useAgentSessionStore } from "#store/agent-sessions";
import {
  causalityInspectorAtom,
  detailPanelOpenAtom,
  graphViewAtom,
  keybindingsAtom,
  selectedWorkerIdAtom,
} from "#store/ui";
import { useWorkerStore } from "#store/workers";

type ViewMode = "graph" | "list";
type DetailTab = "detail" | "ai" | "ship";

const VIEW_TABS: ReadonlyArray<TabItem<ViewMode>> = [
  { id: "graph", label: "Graph" },
  { id: "list", label: "List" },
];

/** Detail panel width per tab: the chat and ship views need more room. */
const DETAIL_WIDTH: Record<DetailTab, string> = {
  detail: "w-80",
  ai: "w-120",
  ship: "w-105",
};

const VIEW_TAB_CLASS =
  "cursor-pointer rounded-md px-3 py-1.5 text-sm font-medium text-fg-muted transition-colors hover:text-fg aria-selected:bg-plasma/15 aria-selected:text-plasma";

const DETAIL_TAB_CLASS =
  "flex-1 cursor-pointer px-3 py-2 text-sm font-medium text-fg-muted transition-colors hover:text-fg aria-selected:bg-plasma/12 aria-selected:text-plasma disabled:cursor-not-allowed disabled:text-fg-dim disabled:hover:text-fg-dim";

/**
 * One list row. Selects only the fields it shows, so a worker's output
 * chunks (which replace the whole `workers` Map) re-render no row.
 */
function WorkerRow({ id }: { readonly id: string }): React.ReactElement | null {
  const name = useWorkerStore((s) => s.workers.get(id)?.name);
  const branch = useWorkerStore((s) => s.workers.get(id)?.branch);
  const state = useWorkerStore((s) => s.workers.get(id)?.state);
  const agentSession = useAgentSessionStore((s) => s.sessions.get(id));
  const [selectedId, setSelectedId] = useAtom(selectedWorkerIdAtom);
  const setDetailOpen = useSetAtom(detailPanelOpenAtom);

  if (state === undefined) return null;

  return (
    <li>
      <button
        type="button"
        aria-current={selectedId === id || undefined}
        onClick={() => {
          setSelectedId(id);
          setDetailOpen(true);
        }}
        className="glass-panel flex w-full cursor-pointer items-center justify-between gap-3 rounded-lg border border-border-2 px-4 py-3 text-left transition-colors hover:border-border-3 aria-current:border-plasma/30 aria-current:bg-plasma/8"
      >
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate font-display text-md font-semibold text-fg-bright">
            {escapeForDisplay(name ?? id.slice(0, 8))}
          </span>
          {branch != null && (
            <Pill tone="info" size="sm" maxWidth={160} title={escapeForDisplay(branch)}>
              {escapeForDisplay(branch)}
            </Pill>
          )}
          {agentSession && (
            <ProviderBadge provider={agentSession.provider} model={agentSession.model} />
          )}
        </span>
        <Badge state={state}>{stateLabels[state]}</Badge>
      </button>
    </li>
  );
}

function WorkerListView(): React.ReactElement {
  const ids = useWorkerStore(useShallow((s) => [...s.workers.keys()]));
  const { commandPalette } = useAtomValue(keybindingsAtom);

  if (ids.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3">
        <div
          aria-hidden="true"
          className="flex size-12 items-center justify-center rounded-lg border border-border bg-surface-1 text-xl text-fg-dim"
        >
          +
        </div>
        <p className="text-md text-fg-muted">No Workers Running</p>
        <p className="font-mono text-xs text-fg-dim">
          Click "Spawn Worker" Or Press {formatBinding(commandPalette)}
        </p>
      </div>
    );
  }

  return (
    <ul className="scroll-area flex h-full flex-col gap-2 overflow-y-auto p-4">
      {ids.map((id) => (
        <WorkerRow key={id} id={id} />
      ))}
    </ul>
  );
}

/**
 * Workers page: the worker graph or list (a tab pair; the binding from
 * Settings, Ctrl+Shift+G by default, switches them), a detail panel
 * with Detail / AI Chat / Ship tabs for the selected worker, the
 * causality inspector and the spawn dialog.
 *
 * Views and detail tabs are kept mounted once shown (`<Activity>` via
 * {@link TabPanel}), so switching back restores the graph viewport, the
 * list scroll position and an in-progress chat. The detail panel is
 * keyed by worker, so selecting another worker starts its tabs fresh.
 */
export function Workers(): React.ReactElement {
  const idBase = useId();
  const [viewMode, setViewMode] = useAtom(graphViewAtom);
  const [detailOpen, setDetailOpen] = useAtom(detailPanelOpenAtom);
  const [selectedId, setSelectedWorkerId] = useAtom(selectedWorkerIdAtom);
  const [causalityTarget, setCausalityTarget] = useAtom(causalityInspectorAtom);
  const { graphToggle } = useAtomValue(keybindingsAtom);
  const selectedWorker = useWorkerStore((s) =>
    selectedId ? s.workers.get(selectedId) : undefined,
  );
  const [detailTab, setDetailTab] = useState<DetailTab>("detail");
  /** Views and tabs shown at least once; only these stay mounted while hidden. */
  const [shown, setShown] = useState<ReadonlySet<string>>(() => new Set([viewMode, "detail"]));
  // The spawn dialog is conditionally mounted (not driven by its own
  // `open` prop) so every field/probe/error resets cleanly on each
  // open cycle — see SpawnWorkerDialog's doc.
  const [spawnDialogOpen, setSpawnDialogOpen] = useState(false);

  const markShown = (id: string): void =>
    setShown((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));

  const showView = (mode: ViewMode): void => {
    markShown(mode);
    setViewMode(mode);
  };

  const showDetailTab = (tab: DetailTab): void => {
    markShown(tab);
    setDetailTab(tab);
  };

  const onGlobalKeyDown = useEffectEvent((e: KeyboardEvent): void => {
    if (!matchesBinding(e, graphToggle)) return;
    e.preventDefault();
    showView(viewMode === "graph" ? "list" : "graph");
  });

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => onGlobalKeyDown(e);
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  const canShip = selectedWorker?.worktreePath != null;
  const detailTabs: ReadonlyArray<TabItem<DetailTab>> = [
    { id: "detail", label: "Detail" },
    { id: "ai", label: "AI Chat" },
    {
      id: "ship",
      label: "Ship",
      disabled: !canShip,
      title: canShip ? undefined : "Shipping Requires An Isolated Worktree",
    },
  ];
  // A worker without a worktree cannot show the Ship tab.
  const activeDetailTab = detailTab === "ship" && !canShip ? "detail" : detailTab;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="flex shrink-0 items-center justify-between border-b border-border px-6 py-4">
        <div>
          <h1 className="font-display text-xl font-bold tracking-tight text-fg-bright">Workers</h1>
          <p className="mt-1 text-sm text-fg-muted">Manage And Monitor Worker Processes.</p>
        </div>

        <div className="flex items-center gap-3">
          <Button variant="primary" size="sm" onClick={() => setSpawnDialogOpen(true)}>
            Spawn Worker
          </Button>
          <TabList
            label="Worker View"
            idBase={`${idBase}-view`}
            items={VIEW_TABS}
            value={viewMode}
            onChange={showView}
            className="flex rounded-lg border border-border bg-surface-0 p-0.5"
            tabClassName={VIEW_TAB_CLASS}
          />
        </div>
      </header>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div className="min-w-0 flex-1 overflow-hidden">
          <TabPanel
            idBase={`${idBase}-view`}
            id="graph"
            selected={viewMode === "graph"}
            mounted={shown.has("graph")}
            className="h-full"
          >
            <WorkerGraph />
          </TabPanel>
          <TabPanel
            idBase={`${idBase}-view`}
            id="list"
            selected={viewMode === "list"}
            mounted={shown.has("list")}
            className="h-full"
          >
            <WorkerListView />
          </TabPanel>
        </div>

        {detailOpen && selectedWorker && (
          // Keyed by worker: panels kept alive across tab switches must not
          // carry one worker's chat or ship state over to the next worker.
          <aside
            key={selectedWorker.id}
            aria-label="Worker Details"
            className={`flex h-full shrink-0 flex-col overflow-hidden ${DETAIL_WIDTH[activeDetailTab]}`}
          >
            <TabList
              label="Worker Panels"
              idBase={`${idBase}-detail`}
              items={detailTabs}
              value={activeDetailTab}
              onChange={showDetailTab}
              className="flex shrink-0 border-b border-border bg-surface-1"
              tabClassName={DETAIL_TAB_CLASS}
            />
            <div className="min-h-0 flex-1 overflow-hidden">
              <TabPanel
                idBase={`${idBase}-detail`}
                id="detail"
                selected={activeDetailTab === "detail"}
                className="h-full"
              >
                <WorkerDetail worker={selectedWorker} />
              </TabPanel>
              <TabPanel
                idBase={`${idBase}-detail`}
                id="ai"
                selected={activeDetailTab === "ai"}
                mounted={shown.has("ai")}
                className="h-full"
              >
                <WorkerAIPanel
                  workerId={selectedWorker.id}
                  canShip={canShip}
                  onRequestShipTab={() => showDetailTab("ship")}
                />
              </TabPanel>
              <TabPanel
                idBase={`${idBase}-detail`}
                id="ship"
                selected={activeDetailTab === "ship"}
                mounted={canShip && shown.has("ship")}
                className="h-full"
              >
                <ShipPanel workerId={selectedWorker.id} />
              </TabPanel>
            </div>
          </aside>
        )}
      </div>

      {/* Causality inspector overlay — shared between an edge click in
          WorkerGraph and WorkerDetail's "View Causality" action, both
          of which just set `causalityInspectorAtom`. Rendered once here
          rather than in either entry point so it works from both. */}
      {causalityTarget && (
        <CausalityPanel
          startSeq={causalityTarget.startSeq}
          onClose={() => setCausalityTarget(null)}
        />
      )}

      {/* Spawn dialog — conditionally mounted so it resets fresh (fresh
          probe, fresh fields) every open cycle. Selects + opens the
          detail panel on the newly spawned worker, matching the list
          view's own click-to-select behavior. */}
      {spawnDialogOpen && (
        <SpawnWorkerDialog
          onClose={() => setSpawnDialogOpen(false)}
          onSpawned={(workerId) => {
            setSelectedWorkerId(workerId);
            setDetailOpen(true);
          }}
        />
      )}
    </div>
  );
}
