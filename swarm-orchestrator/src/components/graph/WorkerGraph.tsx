import type {
  Connection,
  Edge,
  EdgeMouseHandler,
  EdgeTypes,
  Node,
  NodeMouseHandler,
  NodeTypes,
  OnEdgesChange,
  OnNodesChange,
} from "@xyflow/react";
import {
  applyEdgeChanges,
  applyNodeChanges,
  Background,
  MiniMap,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
} from "@xyflow/react";
import { useAtom, useSetAtom } from "jotai";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { Spinner } from "#components/ui/Spinner";
import { useElkLayout } from "#hooks/useElkLayout";
import { workerColor } from "#lib/theme";
import type { ProvenanceEdgeRecord } from "#store/provenance";
import { selectVisibleEdges, useProvenanceStore } from "#store/provenance";
import type { Worker, WorkerState } from "#store/types";
import { causalityInspectorAtom, detailPanelOpenAtom, selectedWorkerIdAtom } from "#store/ui";
import { useWorkerStore } from "#store/workers";
import { GraphContextMenu } from "./GraphContextMenu.tsx";
import { GraphControls } from "./GraphControls.tsx";
import { GraphLegend } from "./GraphLegend.tsx";
import type { GraphEdgeKind, ProvenanceEdgeData } from "./ProvenanceEdge.tsx";
import { ProvenanceEdge } from "./ProvenanceEdge.tsx";
import { WorkerNode } from "./WorkerNode.tsx";

import "@xyflow/react/dist/style.css";

const nodeTypes: NodeTypes = {
  worker: WorkerNode,
};

const edgeTypes: EdgeTypes = {
  provenance: ProvenanceEdge,
};

interface ContextMenuState {
  readonly x: number;
  readonly y: number;
  readonly workerId: string;
  readonly workerState: WorkerState;
}

/** Builds nodes from the live worker registry — one per worker, no fabricated edges. `fileWriteCounts` feeds each node's "Wrote N Files" badge. */
function buildNodes(
  workers: ReadonlyMap<string, Worker>,
  fileWriteCounts: ReadonlyMap<string, number>,
): Node[] {
  return [...workers.entries()].map(([id, worker], index) => ({
    id,
    type: "worker",
    position: { x: 0, y: 0 },
    data: {
      label: worker.name ?? id.slice(0, 8),
      state: worker.state,
      index,
      pid: worker.pid,
      fileWriteCount: fileWriteCounts.get(id) ?? 0,
    },
  }));
}

/**
 * Converts visible provenance-store edge records into React Flow edges.
 * Each record already collapsed repeated same-kind occurrences (see
 * `#store/provenance`'s `ingestEvent`) — `count`/`lastSeq` ride along in
 * `data` for `ProvenanceEdge`'s ×N label and `CausalityPanel`'s walk
 * starting point, respectively.
 */
function toFlowEdges(records: readonly ProvenanceEdgeRecord[]): Edge[] {
  return records.map((r) => ({
    id: `prov-${r.from}-${r.to}-${r.kind}`,
    source: r.from,
    target: r.to,
    type: "provenance",
    data: { kind: r.kind, count: r.count, lastSeq: r.lastSeq } satisfies ProvenanceEdgeData,
  }));
}

function WorkerGraphInner(): React.ReactElement {
  const workers = useWorkerStore((s) => s.workers);
  const updateState = useWorkerStore((s) => s.updateState);
  const removeWorker = useWorkerStore((s) => s.removeWorker);
  const provenanceEdges = useProvenanceStore((s) => s.edges);
  const fileWriteCounts = useProvenanceStore((s) => s.fileWriteCounts);
  const [, setSelectedId] = useAtom(selectedWorkerIdAtom);
  const [, setDetailOpen] = useAtom(detailPanelOpenAtom);
  const setCausalityTarget = useSetAtom(causalityInspectorAtom);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const initialFitDone = useRef(false);

  const { fitView, getViewport } = useReactFlow();

  // Nodes come from the live worker registry; measured edges come from
  // the provenance store, filtered to workers still on the canvas (an
  // edge whose endpoint departed drops from the graph but stays in the
  // store — see `selectVisibleEdges`'s doc, still findable via
  // CausalityPanel by seq).
  const rawNodes = buildNodes(workers, fileWriteCounts);
  const visibleRecords = selectVisibleEdges(provenanceEdges, new Set(workers.keys()));
  const measuredEdges = toFlowEdges(visibleRecords);

  // Run ELK layout. Only measured edges feed the topology (crossing
  // minimization) — user-drawn manual edges never did (onConnect always
  // appended straight into rendered state, bypassing layout) and still
  // don't here.
  const {
    layoutedNodes,
    isLayouting,
    error: layoutError,
    runLayout,
  } = useElkLayout(rawNodes, measuredEdges);

  // Controlled nodes state for interactive editing (drag, add, kill).
  const [nodes, setNodes] = useState<Node[]>([]);
  // User-drawn annotation edges only (kind: "manual") — kept as real
  // React state since nothing else derives them. Measured edges are
  // NOT stored as state: they're recomputed fresh every render from the
  // provenance store above, so a repeat occurrence's count/×N label
  // never goes stale waiting on the next ELK relayout (ELK only
  // repositions NODES; it passes edges through unchanged, so routing
  // edge content through it would leave collapsed-edge counts stuck at
  // whatever was true the last time the node topology itself changed).
  const [manualEdges, setManualEdges] = useState<Edge[]>([]);

  const edges = [...measuredEdges, ...manualEdges];
  const presentKinds = new Set<GraphEdgeKind>(
    edges.map((e) => (e.data as ProvenanceEdgeData).kind),
  );

  // Sync layout results into controlled node state.
  useEffect(() => {
    if (layoutedNodes.length > 0) {
      setNodes(layoutedNodes);
    }
  }, [layoutedNodes]);

  // Fit view on first layout completion. The guard is consumed inside the rAF
  // callback: while occluded, Chromium suppresses rAF, and a topology change
  // cancels the pending fit — leaving the guard unset lets the next layout
  // completion reschedule it instead of losing the initial fit forever.
  useEffect(() => {
    if (!isLayouting && nodes.length > 0 && !initialFitDone.current) {
      const raf = requestAnimationFrame(() => {
        initialFitDone.current = true;
        fitView({ duration: 300, padding: 0.2 });
      });
      return () => cancelAnimationFrame(raf);
    }
    return undefined;
  }, [isLayouting, nodes.length, fitView]);

  // Controlled change handlers for drag, select, remove.
  const onNodesChange: OnNodesChange = (changes) => {
    setNodes((nds) => applyNodeChanges(changes, nds));
  };

  // Only manual edges are ever structurally mutable — measured edges are
  // read-only facts recomputed from the store, so changes targeting
  // their ids are inert here (there's nothing in `manualEdges` for them
  // to match).
  const onEdgesChange: OnEdgesChange = (changes) => {
    setManualEdges((eds) => applyEdgeChanges(changes, eds));
  };

  // Connect handler — draw a new MANUAL annotation edge by dragging
  // between handles. Kept visually and structurally distinct from
  // measured edges (own `kind: "manual"`, own legend row) — annotations
  // must never be mistaken for measured facts.
  const onConnect = (connection: Connection) => {
    if (!connection.source || !connection.target) return;
    const newEdge: Edge = {
      id: `manual-${connection.source}-${connection.target}-${Date.now()}`,
      source: connection.source,
      target: connection.target,
      type: "provenance",
      data: { kind: "manual" } satisfies ProvenanceEdgeData,
    };
    setManualEdges((eds) => [...eds, newEdge]);
  };

  // Add a new worker node at viewport center.
  const handleAddNode = () => {
    const viewport = getViewport();
    const centerX = (-viewport.x + 400) / viewport.zoom;
    const centerY = (-viewport.y + 300) / viewport.zoom;

    const newId = crypto.randomUUID();
    const newNode: Node = {
      id: newId,
      type: "worker",
      position: { x: centerX, y: centerY },
      data: {
        label: `Worker ${nodes.length + 1}`,
        state: "idle" as WorkerState,
        index: nodes.length,
      },
    };
    setNodes((nds) => [...nds, newNode]);
  };

  // Delete selected (manual) edge via Delete/Backspace key.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) {
        return;
      }

      if ((e.key === "Delete" || e.key === "Backspace") && selectedEdgeId) {
        e.preventDefault();
        setManualEdges((eds) => eds.filter((edge) => edge.id !== selectedEdgeId));
        setSelectedEdgeId(null);
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [selectedEdgeId]);

  // Edge click: a MEASURED edge opens the causality inspector at its
  // most recent occurrence; a MANUAL edge selects for deletion (the
  // pre-existing annotation-editing UX) — never both, so a click can
  // never be ambiguous about which kind of edge it landed on.
  const handleEdgeClick: EdgeMouseHandler = (_event, edge) => {
    const data = edge.data as ProvenanceEdgeData | undefined;
    if (data?.kind === "manual") {
      setSelectedEdgeId((prev) => (prev === edge.id ? null : edge.id));
      return;
    }
    if (typeof data?.lastSeq === "number") {
      setCausalityTarget({ startSeq: data.lastSeq });
    }
  };

  // Delete selected edge (toolbar button).
  const handleDeleteEdge = () => {
    if (selectedEdgeId) {
      setManualEdges((eds) => eds.filter((e) => e.id !== selectedEdgeId));
      setSelectedEdgeId(null);
    }
  };

  // Node click → select worker + open detail.
  const handleNodeClick: NodeMouseHandler = (_event, node) => {
    setSelectedId(node.id);
    setDetailOpen(true);
    setContextMenu(null);
    setSelectedEdgeId(null);
  };

  // Right-click → context menu with delete option.
  const handleNodeContextMenu: NodeMouseHandler = (event, node) => {
    event.preventDefault();
    const worker = workers.get(node.id);
    const nodeData = node.data as { state?: WorkerState } | undefined;

    setContextMenu({
      x: event.clientX,
      y: event.clientY,
      workerId: node.id,
      workerState: worker?.state ?? nodeData?.state ?? ("idle" as WorkerState),
    });
  };

  const handlePaneClick = () => {
    setContextMenu(null);
    setSelectedEdgeId(null);
  };

  // Context menu actions.
  const handlePause = () => {
    if (contextMenu) {
      updateState(contextMenu.workerId, "paused");
      setContextMenu(null);
    }
  };

  const handleResume = () => {
    if (contextMenu) {
      updateState(contextMenu.workerId, "running");
      setContextMenu(null);
    }
  };

  const handleKill = () => {
    if (contextMenu) {
      // Remove from store if it exists there.
      if (workers.has(contextMenu.workerId)) {
        removeWorker(contextMenu.workerId);
      }
      // Always remove from graph. Measured edges auto-drop next render
      // via selectVisibleEdges once the worker leaves the store; only
      // manual edges (real state) need an explicit filter here.
      setNodes((nds) => nds.filter((n) => n.id !== contextMenu.workerId));
      setManualEdges((eds) =>
        eds.filter((e) => e.source !== contextMenu.workerId && e.target !== contextMenu.workerId),
      );
      setContextMenu(null);
    }
  };

  const handleInspect = () => {
    if (contextMenu) {
      setSelectedId(contextMenu.workerId);
      setDetailOpen(true);
      setContextMenu(null);
    }
  };

  const handleCloseContextMenu = () => {
    setContextMenu(null);
  };

  // MiniMap node color.
  const miniMapNodeColor = (node: Node): string => {
    const data = node.data as { index?: number } | undefined;
    return workerColor(data?.index ?? 0);
  };

  // Edge styles — highlight selected (manual) edge.
  const styledEdges = edges.map((edge) => ({
    ...edge,
    selected: edge.id === selectedEdgeId,
  }));

  // Empty state — zero workers.
  if (workers.size === 0 && nodes.length === 0) {
    return (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexDirection: "column",
          gap: 12,
        }}
      >
        <svg width={48} height={48} viewBox="0 0 48 48" fill="none">
          <title>No Workers</title>
          <circle cx={24} cy={24} r={20} stroke="oklch(0.28 0.05 220)" strokeWidth={2} />
          <path
            d="M18 24h12M24 18v12"
            stroke="oklch(0.55 0.04 220)"
            strokeWidth={2}
            strokeLinecap="round"
          />
        </svg>
        <span
          style={{
            fontFamily: "var(--font-body)",
            fontSize: "0.875rem",
            color: "oklch(0.55 0.04 220)",
          }}
        >
          No Workers Running. Spawn A Worker To See The Topology Graph.
        </span>
      </div>
    );
  }

  return (
    <div style={{ width: "100%", height: "100%", position: "relative" }}>
      {/* Loading / layout-error overlay */}
      <AnimatePresence>
        {(isLayouting || layoutError) && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            style={{
              position: "absolute",
              inset: 0,
              zIndex: 20,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: "oklch(0.06 0.02 220 / 0.5)",
              backdropFilter: "blur(2px)",
              borderRadius: 12,
            }}
          >
            {layoutError ? (
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  gap: 12,
                  padding: 24,
                  maxWidth: 320,
                  textAlign: "center",
                }}
              >
                <span
                  style={{
                    fontFamily: "var(--font-body)",
                    fontSize: "0.875rem",
                    fontWeight: 600,
                    color: "oklch(0.72 0.20 10)",
                  }}
                >
                  {layoutError}
                </span>
                <button
                  type="button"
                  onClick={runLayout}
                  style={{
                    padding: "8px 20px",
                    fontSize: "0.75rem",
                    fontWeight: 500,
                    fontFamily: "var(--font-body)",
                    background: "oklch(0.78 0.18 205 / 0.15)",
                    border: "1px solid oklch(0.78 0.18 205 / 0.3)",
                    borderRadius: 8,
                    color: "oklch(0.78 0.18 205)",
                    cursor: "pointer",
                  }}
                >
                  Retry Layout
                </button>
              </div>
            ) : (
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  gap: 8,
                }}
              >
                <Spinner size="lg" />
                <span
                  style={{
                    fontFamily: "var(--font-body)",
                    fontSize: "0.75rem",
                    color: "oklch(0.55 0.04 220)",
                  }}
                >
                  Computing Layout
                </span>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      <ReactFlow
        nodes={nodes}
        edges={styledEdges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onNodeClick={handleNodeClick}
        onNodeContextMenu={handleNodeContextMenu}
        onEdgeClick={handleEdgeClick}
        onPaneClick={handlePaneClick}
        nodesDraggable
        nodesConnectable
        proOptions={{ hideAttribution: true }}
        style={{ background: "oklch(0.08 0.02 220)" }}
      >
        <Background color="oklch(0.14 0.03 220)" gap={20} size={1} />

        <GraphLegend presentKinds={presentKinds} />

        {/* Empty-causality hint: workers exist but nothing measured has
            happened between them yet (e.g. three hand-spawned workers).
            This is the acceptance criterion for measured provenance —
            an honest, quiet canvas rather than a fabricated chain. Only
            shown once layout has actually settled, so it doesn't flash
            during the initial computing-layout overlay. */}
        {!isLayouting && !layoutError && nodes.length > 0 && edges.length === 0 && (
          <Panel
            position="bottom-center"
            style={{
              padding: "6px 14px",
              borderRadius: 999,
              background: "oklch(0.12 0.03 220 / 0.75)",
              backdropFilter: "blur(8px)",
              border: "1px solid oklch(0.22 0.04 220)",
              fontFamily: "var(--font-body)",
              fontSize: "0.6875rem",
              color: "oklch(0.50 0.04 220)",
            }}
          >
            No Measured Causality Yet
          </Panel>
        )}

        <MiniMap
          nodeColor={miniMapNodeColor}
          maskColor="oklch(0.06 0.02 220 / 0.8)"
          style={{
            background: "oklch(0.10 0.03 220)",
            border: "1px solid oklch(0.22 0.04 220)",
            borderRadius: 8,
          }}
        />
        <GraphControls
          onResetLayout={runLayout}
          onAddNode={handleAddNode}
          onDeleteEdge={selectedEdgeId ? handleDeleteEdge : undefined}
          nodes={nodes}
          edges={edges}
        />
      </ReactFlow>

      {/* Context menu */}
      {contextMenu && (
        <GraphContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          workerId={contextMenu.workerId}
          workerState={contextMenu.workerState}
          onPause={handlePause}
          onResume={handleResume}
          onKill={handleKill}
          onInspect={handleInspect}
          onClose={handleCloseContextMenu}
        />
      )}
    </div>
  );
}

/**
 * Interactive worker topology graph with ELK layout, context menus,
 * zoom controls, edge drawing, node addition, and a mini-map.
 *
 * Edges are MEASURED causal facts derived from stamped `swarm://events`
 * envelopes (see `#store/provenance`) — spawn/kill/command/message —
 * plus user-drawn `manual` annotations, kept visually and structurally
 * distinct. Workers with no measured causality render with zero edges
 * and a quiet "No Measured Causality Yet" hint; nothing is ever
 * fabricated. Wraps React Flow with a provider.
 */
export function WorkerGraph(): React.ReactElement {
  return (
    <ReactFlowProvider>
      <WorkerGraphInner />
    </ReactFlowProvider>
  );
}
