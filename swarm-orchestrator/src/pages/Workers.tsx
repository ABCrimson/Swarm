import { useAtom, useAtomValue } from "jotai";
import { useEffect, useState } from "react";

import { WorkerAIPanel } from "#components/ai/WorkerAIPanel";
import { CausalityPanel } from "#components/graph/CausalityPanel";
import { WorkerDetail } from "#components/graph/WorkerDetail";
import { WorkerGraph } from "#components/graph/WorkerGraph";
import { ShipPanel } from "#components/ship/ShipPanel";
import { Badge, stateLabels } from "#components/ui/Badge";
import { Button } from "#components/ui/Button";
import { Pill } from "#components/ui/Pill";
import { SpawnWorkerDialog } from "#components/worker/SpawnWorkerDialog";
import { matchesBinding } from "#lib/keybindings";
import { useAgentSessionStore } from "#store/agent-sessions";
import {
  causalityInspectorAtom,
  detailPanelOpenAtom,
  graphViewAtom,
  keybindingsAtom,
  selectedWorkerIdAtom,
} from "#store/ui";
import { useWorkerStore } from "#store/workers";

type DetailTab = "detail" | "ai" | "ship";

function WorkerListView(): React.ReactElement {
  const workers = useWorkerStore((s) => s.workers);
  const agentSessions = useAgentSessionStore((s) => s.sessions);
  const [selectedId, setSelectedId] = useAtom(selectedWorkerIdAtom);
  const [, setDetailOpen] = useAtom(detailPanelOpenAtom);

  if (workers.size === 0) {
    return (
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 12,
        }}
      >
        <div
          style={{
            width: 48,
            height: 48,
            borderRadius: 12,
            background: "oklch(0.12 0.03 220)",
            border: "1px solid oklch(0.22 0.04 220)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 20,
            color: "oklch(0.40 0.04 220)",
          }}
          aria-hidden="true"
        >
          +
        </div>
        <span
          style={{
            color: "oklch(0.50 0.04 220)",
            fontFamily: "var(--font-body)",
            fontSize: "0.8125rem",
          }}
        >
          No Workers Running
        </span>
        <span
          style={{
            color: "oklch(0.38 0.03 220)",
            fontFamily: "var(--font-mono)",
            fontSize: "0.6875rem",
          }}
        >
          Click "Spawn Worker" Or Press Ctrl+K
        </span>
      </div>
    );
  }

  return (
    <div style={{ flex: 1, overflowY: "auto", padding: 16 }} className="scroll-area">
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {[...workers.entries()].map(([id, worker]) => (
          <button
            key={id}
            type="button"
            onClick={() => {
              setSelectedId(id);
              setDetailOpen(true);
            }}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "12px 16px",
              background:
                selectedId === id ? "oklch(0.78 0.18 205 / 0.08)" : "oklch(0.12 0.03 220 / 0.7)",
              backdropFilter: "blur(12px) saturate(1.5)",
              border: `1px solid ${selectedId === id ? "oklch(0.78 0.18 205 / 0.3)" : "oklch(0.28 0.05 220)"}`,
              borderRadius: 8,
              cursor: "pointer",
              textAlign: "left",
              width: "100%",
              outline: "none",
              transition:
                "background 0.12s cubic-bezier(0, 0, 0.2, 1), border-color 0.12s cubic-bezier(0, 0, 0.2, 1), box-shadow 0.12s cubic-bezier(0, 0, 0.2, 1)",
            }}
            onFocus={(e) => {
              e.currentTarget.style.boxShadow = "0 0 0 2px oklch(0.78 0.18 205 / 0.4)";
            }}
            onBlur={(e) => {
              e.currentTarget.style.boxShadow = "none";
            }}
          >
            <span
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                minWidth: 0,
              }}
            >
              <span
                style={{
                  fontFamily: "var(--font-display)",
                  fontSize: "0.8125rem",
                  fontWeight: 600,
                  color: "oklch(0.95 0.02 220)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {worker.name ?? id.slice(0, 8)}
              </span>
              {worker.branch != null && (
                <Pill
                  tone="info"
                  size="sm"
                  maxWidth={160}
                  title={worker.branch}
                  style={{ fontFamily: "var(--font-mono)" }}
                >
                  {worker.branch}
                </Pill>
              )}
              {agentSessions.has(id) && (
                <span
                  style={{
                    padding: "2px 7px",
                    borderRadius: 5,
                    border: "1px solid oklch(0.45 0.14 290)",
                    background: "oklch(0.16 0.06 290 / 0.5)",
                    color: "oklch(0.80 0.14 290)",
                    fontFamily: "var(--font-mono)",
                    fontSize: "0.625rem",
                    fontWeight: 600,
                  }}
                >
                  Claude Code
                </span>
              )}
            </span>
            <Badge state={worker.state}>{stateLabels[worker.state]}</Badge>
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * Workers page with graph/list view toggle, worker detail panel,
 * and Ctrl+Shift+G keyboard shortcut for switching views.
 */
export function Workers(): React.ReactElement {
  const [viewMode, setViewMode] = useAtom(graphViewAtom);
  const [detailOpen, setDetailOpen] = useAtom(detailPanelOpenAtom);
  const [selectedId, setSelectedWorkerId] = useAtom(selectedWorkerIdAtom);
  const [causalityTarget, setCausalityTarget] = useAtom(causalityInspectorAtom);
  const workers = useWorkerStore((s) => s.workers);
  const selectedWorker = selectedId ? workers.get(selectedId) : undefined;
  const [detailTab, setDetailTab] = useState<DetailTab>("detail");
  // The spawn dialog is conditionally mounted (not driven by its own
  // `open` prop) so every field/probe/error resets cleanly on each
  // open cycle — see SpawnWorkerDialog's doc.
  const [spawnDialogOpen, setSpawnDialogOpen] = useState(false);

  // Graph/list toggle — binding is remappable in Settings.
  const keybindings = useAtomValue(keybindingsAtom);
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (matchesBinding(e, keybindings.graphToggle)) {
        e.preventDefault();
        setViewMode((prev) => (prev === "graph" ? "list" : "graph"));
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [setViewMode, keybindings]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "16px 24px",
          borderBottom: "1px solid oklch(0.22 0.04 220)",
          flexShrink: 0,
        }}
      >
        <div>
          <h1
            style={{
              fontFamily: "var(--font-display)",
              fontSize: "1.25rem",
              fontWeight: 700,
              color: "oklch(0.95 0.02 220)",
              margin: 0,
              letterSpacing: "-0.01em",
            }}
          >
            Workers
          </h1>
          <p
            style={{
              fontFamily: "var(--font-body)",
              fontSize: "0.75rem",
              color: "oklch(0.55 0.04 220)",
              margin: "4px 0 0",
            }}
          >
            Manage And Monitor Worker Processes.
          </p>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          {/* Opens the designed spawn dialog (provider, Claude Code
              model/trust-tier, working directory) — replaces the old
              inline header picker. */}
          <Button variant="primary" size="sm" onClick={() => setSpawnDialogOpen(true)}>
            Spawn Worker
          </Button>

          {/* View toggle */}
          <div
            style={{
              display: "flex",
              background: "oklch(0.08 0.02 220)",
              border: "1px solid oklch(0.22 0.04 220)",
              borderRadius: 8,
              padding: 2,
            }}
          >
            <button
              type="button"
              role="tab"
              aria-selected={viewMode === "graph"}
              onClick={() => setViewMode("graph")}
              style={{
                padding: "6px 12px",
                background: viewMode === "graph" ? "oklch(0.78 0.18 205 / 0.15)" : "transparent",
                border: "none",
                borderRadius: 6,
                color: viewMode === "graph" ? "oklch(0.78 0.18 205)" : "oklch(0.55 0.04 220)",
                fontFamily: "var(--font-body)",
                fontSize: "0.75rem",
                fontWeight: 500,
                cursor: "pointer",
                outline: "none",
                transition:
                  "background 0.12s cubic-bezier(0, 0, 0.2, 1), color 0.12s cubic-bezier(0, 0, 0.2, 1), box-shadow 0.12s cubic-bezier(0, 0, 0.2, 1)",
              }}
              onFocus={(e) => {
                e.currentTarget.style.boxShadow = "0 0 0 2px oklch(0.78 0.18 205 / 0.4)";
              }}
              onBlur={(e) => {
                e.currentTarget.style.boxShadow = "none";
              }}
            >
              Graph
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={viewMode === "list"}
              onClick={() => setViewMode("list")}
              style={{
                padding: "6px 12px",
                background: viewMode === "list" ? "oklch(0.78 0.18 205 / 0.15)" : "transparent",
                border: "none",
                borderRadius: 6,
                color: viewMode === "list" ? "oklch(0.78 0.18 205)" : "oklch(0.55 0.04 220)",
                fontFamily: "var(--font-body)",
                fontSize: "0.75rem",
                fontWeight: 500,
                cursor: "pointer",
                outline: "none",
                transition:
                  "background 0.12s cubic-bezier(0, 0, 0.2, 1), color 0.12s cubic-bezier(0, 0, 0.2, 1), box-shadow 0.12s cubic-bezier(0, 0, 0.2, 1)",
              }}
              onFocus={(e) => {
                e.currentTarget.style.boxShadow = "0 0 0 2px oklch(0.78 0.18 205 / 0.4)";
              }}
              onBlur={(e) => {
                e.currentTarget.style.boxShadow = "none";
              }}
            >
              List
            </button>
          </div>
        </div>
      </div>

      {/* Main content area */}
      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
        <div style={{ flex: 1, overflow: "hidden" }}>
          {viewMode === "graph" ? <WorkerGraph /> : <WorkerListView />}
        </div>

        {/* Detail / AI chat panel */}
        {detailOpen && selectedWorker && (
          <div
            style={{
              width: detailTab === "ai" ? 480 : detailTab === "ship" ? 420 : 320,
              height: "100%",
              display: "flex",
              flexDirection: "column",
              overflow: "hidden",
              flexShrink: 0,
            }}
          >
            <div
              style={{
                display: "flex",
                borderBottom: "1px solid oklch(0.22 0.04 220)",
                background: "oklch(0.10 0.03 220)",
                flexShrink: 0,
              }}
              role="tablist"
            >
              <button
                type="button"
                role="tab"
                aria-selected={detailTab === "detail"}
                onClick={() => setDetailTab("detail")}
                style={{
                  flex: 1,
                  padding: "8px 12px",
                  background:
                    detailTab === "detail" ? "oklch(0.78 0.18 205 / 0.12)" : "transparent",
                  border: "none",
                  color: detailTab === "detail" ? "oklch(0.78 0.18 205)" : "oklch(0.55 0.04 220)",
                  fontFamily: "var(--font-body)",
                  fontSize: "0.75rem",
                  fontWeight: 500,
                  cursor: "pointer",
                }}
              >
                Detail
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={detailTab === "ai"}
                onClick={() => setDetailTab("ai")}
                style={{
                  flex: 1,
                  padding: "8px 12px",
                  background: detailTab === "ai" ? "oklch(0.78 0.18 205 / 0.12)" : "transparent",
                  border: "none",
                  color: detailTab === "ai" ? "oklch(0.78 0.18 205)" : "oklch(0.55 0.04 220)",
                  fontFamily: "var(--font-body)",
                  fontSize: "0.75rem",
                  fontWeight: 500,
                  cursor: "pointer",
                }}
              >
                AI Chat
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={detailTab === "ship"}
                disabled={selectedWorker.worktreePath == null}
                onClick={() => setDetailTab("ship")}
                title={
                  selectedWorker.worktreePath == null
                    ? "Shipping Requires An Isolated Worktree"
                    : undefined
                }
                style={{
                  flex: 1,
                  padding: "8px 12px",
                  background: detailTab === "ship" ? "oklch(0.78 0.18 205 / 0.12)" : "transparent",
                  border: "none",
                  color:
                    selectedWorker.worktreePath == null
                      ? "oklch(0.38 0.03 220)"
                      : detailTab === "ship"
                        ? "oklch(0.78 0.18 205)"
                        : "oklch(0.55 0.04 220)",
                  fontFamily: "var(--font-body)",
                  fontSize: "0.75rem",
                  fontWeight: 500,
                  cursor: selectedWorker.worktreePath == null ? "not-allowed" : "pointer",
                }}
              >
                Ship
              </button>
            </div>
            <div style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
              {detailTab === "detail" && <WorkerDetail worker={selectedWorker} />}
              {detailTab === "ai" && (
                <WorkerAIPanel
                  workerId={selectedWorker.id}
                  canShip={selectedWorker.worktreePath != null}
                  onRequestShipTab={() => setDetailTab("ship")}
                />
              )}
              {detailTab === "ship" &&
                (selectedWorker.worktreePath != null ? (
                  <ShipPanel workerId={selectedWorker.id} />
                ) : (
                  <div
                    style={{
                      padding: 24,
                      fontFamily: "var(--font-body)",
                      fontSize: "0.8125rem",
                      color: "oklch(0.55 0.04 220)",
                      textAlign: "center",
                    }}
                  >
                    Shipping Requires An Isolated Worktree
                  </div>
                ))}
            </div>
          </div>
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
