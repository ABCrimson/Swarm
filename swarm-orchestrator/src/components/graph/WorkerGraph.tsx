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
import { useAtom } from "jotai";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { Spinner } from "#components/ui/Spinner";
import { useElkLayout } from "#hooks/useElkLayout";
import { workerColor } from "#lib/theme";

import type { Worker, WorkerState } from "#store/types";

import { detailPanelOpenAtom, selectedWorkerIdAtom } from "#store/ui";
import { useWorkerStore } from "#store/workers";
import { GraphContextMenu } from "./GraphContextMenu.tsx";
import { GraphControls } from "./GraphControls.tsx";
import { SpawnOrderEdge } from "./SpawnOrderEdge.tsx";
import { WorkerNode } from "./WorkerNode.tsx";

import "@xyflow/react/dist/style.css";

const nodeTypes: NodeTypes = {
  worker: WorkerNode,
};

const edgeTypes: EdgeTypes = {
  spawnOrder: SpawnOrderEdge,
};

interface ContextMenuState {
  readonly x: number;
  readonly y: number;
  readonly workerId: string;
  readonly workerState: WorkerState;
}

function buildGraphData(workers: Map<string, Worker>): { nodes: Node[]; edges: Edge[] } {
  const entries = [...workers.entries()];

  const nodes: Node[] = entries.map(([id, worker], index) => ({
    id,
    type: "worker",
    position: { x: 0, y: 0 },
    data: {
      label: worker.name ?? id.slice(0, 8),
      state: worker.state,
      index,
      pid: worker.pid,
    },
  }));

  // Build spawn-order chain edges. NOTE: these are NOT real dependency
  // relationships — the Worker schema has no dependency/parent field, so
  // this simply connects entries in Map iteration (insertion) order as a
  // visual chain. Treat as illustrative topology only. Labeled "Spawn
  // Order" in the graph's legend (below) — never "dependency" — to keep
  // the UI honest about what these edges represent.
  const edges: Edge[] = [];
  for (let i = 1; i < entries.length; i++) {
    const [prevId] = entries[i - 1];
    const [currId] = entries[i];
    edges.push({
      id: `edge-${prevId}-${currId}`,
      source: prevId,
      target: currId,
      type: "spawnOrder",
    });
  }

  return { nodes, edges };
}

function WorkerGraphInner(): React.ReactElement {
  const workers = useWorkerStore((s) => s.workers);
  const updateState = useWorkerStore((s) => s.updateState);
  const removeWorker = useWorkerStore((s) => s.removeWorker);
  const [, setSelectedId] = useAtom(selectedWorkerIdAtom);
  const [, setDetailOpen] = useAtom(detailPanelOpenAtom);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const initialFitDone = useRef(false);

  const { fitView, getViewport } = useReactFlow();

  // Build raw graph data from worker store
  const { nodes: rawNodes, edges: rawEdges } = buildGraphData(workers);

  // Run ELK layout
  const {
    layoutedNodes,
    layoutedEdges,
    isLayouting,
    error: layoutError,
    runLayout,
  } = useElkLayout(rawNodes, rawEdges);

  // Controlled nodes/edges state for interactive editing
  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);

  // Sync layout results into controlled state
  useEffect(() => {
    if (layoutedNodes.length > 0) {
      setNodes(layoutedNodes);
    }
  }, [layoutedNodes]);

  useEffect(() => {
    if (layoutedEdges.length > 0) {
      setEdges(layoutedEdges);
    }
  }, [layoutedEdges]);

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

  // Controlled change handlers for drag, select, remove
  const onNodesChange: OnNodesChange = (changes) => {
    setNodes((nds) => applyNodeChanges(changes, nds));
  };

  const onEdgesChange: OnEdgesChange = (changes) => {
    setEdges((eds) => applyEdgeChanges(changes, eds));
  };

  // Connect handler — draw new edges by dragging between handles
  const onConnect = (connection: Connection) => {
    if (!connection.source || !connection.target) return;
    const newEdge: Edge = {
      id: `edge-${connection.source}-${connection.target}-${Date.now()}`,
      source: connection.source,
      target: connection.target,
      type: "spawnOrder",
    };
    setEdges((eds) => [...eds, newEdge]);
  };

  // Add a new worker node at viewport center
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

  // Delete selected nodes via Delete/Backspace key
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) {
        return;
      }

      if (e.key === "Delete" || e.key === "Backspace") {
        // Delete selected edge
        if (selectedEdgeId) {
          e.preventDefault();
          setEdges((eds) => eds.filter((edge) => edge.id !== selectedEdgeId));
          setSelectedEdgeId(null);
          return;
        }
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [selectedEdgeId]);

  // Edge click — select for deletion
  const handleEdgeClick: EdgeMouseHandler = (_event, edge) => {
    setSelectedEdgeId((prev) => (prev === edge.id ? null : edge.id));
  };

  // Delete selected edge
  const handleDeleteEdge = () => {
    if (selectedEdgeId) {
      setEdges((eds) => eds.filter((e) => e.id !== selectedEdgeId));
      setSelectedEdgeId(null);
    }
  };

  // Node click → select worker + open detail
  const handleNodeClick: NodeMouseHandler = (_event, node) => {
    setSelectedId(node.id);
    setDetailOpen(true);
    setContextMenu(null);
    setSelectedEdgeId(null);
  };

  // Right-click → context menu with delete option
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

  // Context menu actions
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
      // Remove from store if it exists there
      if (workers.has(contextMenu.workerId)) {
        removeWorker(contextMenu.workerId);
      }
      // Always remove from graph
      setNodes((nds) => nds.filter((n) => n.id !== contextMenu.workerId));
      setEdges((eds) =>
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

  // MiniMap node color
  const miniMapNodeColor = (node: Node): string => {
    const data = node.data as { index?: number } | undefined;
    return workerColor(data?.index ?? 0);
  };

  // Edge styles — highlight selected edge
  const styledEdges = edges.map((edge) => ({
    ...edge,
    selected: edge.id === selectedEdgeId,
  }));

  // Empty state
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
        {/* Legend: the animated dashed edges are a spawn-order chain
            (Map insertion order), never a real dependency graph — see
            buildGraphData above. Labeling this "Spawn Order" instead of
            "Dependency" keeps the UI honest about what it renders. */}
        <Panel
          position="top-left"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "6px 10px",
            borderRadius: 8,
            background: "oklch(0.12 0.03 220 / 0.85)",
            backdropFilter: "blur(8px)",
            border: "1px solid oklch(0.28 0.05 220)",
            fontFamily: "var(--font-body)",
            fontSize: "0.6875rem",
            fontWeight: 500,
            color: "oklch(0.65 0.04 220)",
          }}
        >
          <svg width={20} height={8} viewBox="0 0 20 8" aria-hidden="true">
            <line
              x1={1}
              y1={4}
              x2={19}
              y2={4}
              stroke="oklch(0.78 0.18 205 / 0.8)"
              strokeWidth={2}
              strokeDasharray="4 2.5"
            />
          </svg>
          <span>Spawn Order</span>
        </Panel>
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
 * Edges are a spawn-order chain (Map insertion order), not real
 * dependency relationships — the Worker schema has no dependency field.
 * Wraps React Flow with a provider.
 */
export function WorkerGraph(): React.ReactElement {
  return (
    <ReactFlowProvider>
      <WorkerGraphInner />
    </ReactFlowProvider>
  );
}
