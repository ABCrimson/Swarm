import "./graph.css";

import type {
  Connection,
  Dimensions,
  EdgeMouseHandler,
  EdgeTypes,
  NodeChange,
  NodeMouseHandler,
  NodeTypes,
  OnEdgesChange,
  XYPosition,
} from "@xyflow/react";
import {
  applyEdgeChanges,
  Background,
  MarkerType,
  MiniMap,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
} from "@xyflow/react";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { GraphContextMenu } from "#components/graph/GraphContextMenu";
import { GraphControls } from "#components/graph/GraphControls";
import { GraphLegend } from "#components/graph/GraphLegend";
import type { GraphEdgeKind, ProvenanceFlowEdge } from "#components/graph/ProvenanceEdge";
import { KIND_LABEL, KIND_STYLE, ProvenanceEdge } from "#components/graph/ProvenanceEdge";
import type { WorkerFlowNode } from "#components/graph/WorkerNode";
import { WorkerNode } from "#components/graph/WorkerNode";
import { stateLabels } from "#components/ui/Badge";
import { Button } from "#components/ui/Button";
import { Spinner } from "#components/ui/Spinner";
import { useElkLayout } from "#hooks/useElkLayout";
import { escapeForDisplay } from "#lib/display-escape";
import { workerColor } from "#lib/theme";
import type { WorkflowDefinition } from "#lib/workflow";
import { exportWorkflow } from "#lib/workflow";
import type { ProvenanceEdgeRecord } from "#store/provenance";
import { selectVisibleEdges, useProvenanceStore } from "#store/provenance";
import type { Worker } from "#store/types";
import {
  causalityInspectorAtom,
  detailPanelOpenAtom,
  reducedMotionAtom,
  selectedWorkerIdAtom,
} from "#store/ui";
import { useWorkerStore } from "#store/workers";

const nodeTypes = { worker: WorkerNode } satisfies NodeTypes;
const edgeTypes = { provenance: ProvenanceEdge } satisfies EdgeTypes;

const ORIGIN: XYPosition = { x: 0, y: 0 };
const NO_EDGE_IDS: ReadonlySet<string> = new Set();

interface ContextMenuState {
  readonly x: number;
  readonly y: number;
  readonly workerId: string;
  /** A button was still down when the menu was requested (see GraphContextMenu). */
  readonly openOnRelease: boolean;
}

/**
 * The per-node UI state xyflow reports through `onNodesChange` in
 * controlled mode — everything about a node that is not derived from the
 * stores or the layout. `position` is set only by a user drag, so it
 * overrides the layout until the next Reset Layout.
 */
export interface NodeUiState {
  readonly position?: XYPosition;
  readonly measured?: Dimensions;
  readonly selected?: boolean;
  readonly dragging?: boolean;
}

/**
 * Folds xyflow node changes into per-node UI state. Worker nodes are not
 * deletable and the graph never adds nodes through xyflow, so only
 * position (drag), dimensions (measurement) and selection changes matter.
 */
export function reduceNodeUi(
  previous: ReadonlyMap<string, NodeUiState>,
  changes: readonly NodeChange<WorkerFlowNode>[],
): ReadonlyMap<string, NodeUiState> {
  const next = new Map(previous);
  for (const change of changes) {
    switch (change.type) {
      case "position": {
        const current = next.get(change.id);
        next.set(change.id, {
          ...current,
          position: change.position ?? current?.position,
          dragging: change.dragging ?? false,
        });
        break;
      }
      case "dimensions":
        if (change.dimensions) {
          next.set(change.id, { ...next.get(change.id), measured: change.dimensions });
        }
        break;
      case "select":
        next.set(change.id, { ...next.get(change.id), selected: change.selected });
        break;
      case "remove":
        next.delete(change.id);
        break;
      default:
        break;
    }
  }
  return next;
}

/** Accessible name of a worker node's (focusable) xyflow wrapper. */
function nodeAriaLabel(worker: Worker): string {
  const name = escapeForDisplay(worker.name ?? worker.id.slice(0, 8));
  const pid = worker.pid != null ? `, PID ${worker.pid}` : "";
  return `Worker ${name}, Status: ${stateLabels[worker.state]}${pid}`;
}

/** Name per worker id, raw: the workflow export saves it, so each display use escapes it. */
const selectNames = (s: { workers: ReadonlyMap<string, Worker> }): Record<string, string> =>
  Object.fromEntries(s.workers.values().map((w) => [w.id, w.name ?? w.id.slice(0, 8)]));

/** Node accessible name per worker id (changes with state and PID). */
const selectNodeLabels = (s: { workers: ReadonlyMap<string, Worker> }): Record<string, string> =>
  Object.fromEntries(s.workers.values().map((w) => [w.id, nodeAriaLabel(w)]));

/**
 * Converts visible provenance-store edge records into xyflow edges.
 * Each record already collapsed repeated same-kind occurrences (see
 * `#store/provenance`'s `ingestEvent`) — `count`/`lastSeq` ride along in
 * `data` for `ProvenanceEdge`'s ×N label and `CausalityPanel`'s walk
 * starting point. Measured edges are facts: not deletable, with an
 * arrowhead for direction and an accessible name built from worker names.
 */
export function toFlowEdges(
  records: readonly ProvenanceEdgeRecord[],
  names: Readonly<Record<string, string>>,
): ProvenanceFlowEdge[] {
  return records.map((r) => ({
    id: `prov-${r.from}-${r.to}-${r.kind}`,
    source: r.from,
    target: r.to,
    type: "provenance",
    deletable: false,
    markerEnd: { type: MarkerType.ArrowClosed, color: KIND_STYLE[r.kind].stroke },
    ariaLabel: `${KIND_LABEL[r.kind]}: ${escapeForDisplay(names[r.from] ?? r.from)} To ${escapeForDisplay(names[r.to] ?? r.to)}${
      r.count > 1 ? ` (×${r.count})` : ""
    }`,
    data: { kind: r.kind, count: r.count, lastSeq: r.lastSeq },
  }));
}

/** A user-drawn annotation edge. */
function manualEdge(id: string, source: string, target: string): ProvenanceFlowEdge {
  return {
    id,
    source,
    target,
    type: "provenance",
    markerEnd: { type: MarkerType.ArrowClosed, color: KIND_STYLE.manual.stroke },
    ariaLabel: "Manual Annotation",
    data: { kind: "manual" },
  };
}

function WorkerGraphInner(): React.ReactElement {
  // Graph-only projections with shallow equality: a PTY output chunk
  // (which replaces the worker object) leaves both records unchanged, so
  // the graph re-renders only when a worker is added, removed, renamed or
  // changes state/PID. Nodes read their own live fields (see WorkerNode).
  const names = useWorkerStore(useShallow(selectNames));
  const nodeLabels = useWorkerStore(useShallow(selectNodeLabels));
  const workerIds = Object.keys(nodeLabels);

  const provenanceEdges = useProvenanceStore((s) => s.edges);
  const setSelectedId = useSetAtom(selectedWorkerIdAtom);
  const setDetailOpen = useSetAtom(detailPanelOpenAtom);
  // d3-zoom viewport transitions are JS-driven, so CSS prefers-reduced-motion
  // cannot stop them; the animated duration is zeroed here instead.
  const reducedMotion = useAtomValue(reducedMotionAtom);
  // Read, not just set: while the causality inspector is open, graph
  // shortcuts (xyflow's delete keys) must not act on the canvas behind it.
  const [causalityTarget, setCausalityTarget] = useAtom(causalityInspectorAtom);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [nodeUi, setNodeUi] = useState<ReadonlyMap<string, NodeUiState>>(new Map());
  const [selectedEdgeIds, setSelectedEdgeIds] = useState(NO_EDGE_IDS);
  // User-drawn annotation edges (kind "manual") — the only edges that are
  // state. Measured edges are recomputed every render from the provenance
  // store, so a repeat occurrence's count never waits on a relayout.
  const [manualEdges, setManualEdges] = useState<readonly ProvenanceFlowEdge[]>([]);
  // L arms a focused node as annotation source; Enter/Space on another node draws the edge; Escape cancels.
  const [linkSource, setLinkSource] = useState<string | null>(null);
  const initialFitDone = useRef(false);

  const { fitView } = useReactFlow<WorkerFlowNode, ProvenanceFlowEdge>();

  // Measured edges come from the provenance store, filtered to workers
  // still on the canvas (an edge whose endpoint departed drops from the
  // graph but stays in the store — still findable via CausalityPanel).
  const measuredEdges = toFlowEdges(selectVisibleEdges(provenanceEdges, new Set(workerIds)), names);

  // Layout: only measured edges feed ELK's crossing minimization; manual
  // annotations never did.
  const layoutNodes = workerIds.map((id) => ({ id }));
  const {
    positions,
    isLayouting,
    error: layoutError,
    runLayout,
  } = useElkLayout(layoutNodes, measuredEdges);

  // Rendered nodes are derived, never copied into state: exactly one per
  // live worker (a departed worker's node disappears with it), positioned
  // by a user drag if there was one, else by the latest layout.
  const nodes: WorkerFlowNode[] = workerIds.map((id, index) => {
    const ui = nodeUi.get(id);
    return {
      id,
      type: "worker",
      position: ui?.position ?? positions.get(id) ?? ORIGIN,
      data: { workerId: id, index },
      ariaLabel: nodeLabels[id],
      className: linkSource === id ? "worker-graph__node--link-source" : undefined,
      domAttributes: { "aria-keyshortcuts": "L" },
      deletable: false,
      selected: ui?.selected ?? false,
      dragging: ui?.dragging ?? false,
      ...(ui?.measured && { measured: ui.measured }),
    };
  });

  const edges = [...measuredEdges, ...manualEdges].map((edge) => ({
    ...edge,
    selected: selectedEdgeIds.has(edge.id),
  }));
  const presentKinds = new Set<GraphEdgeKind>(edges.flatMap((e) => (e.data ? [e.data.kind] : [])));
  const selectedManualIds = manualEdges
    .filter((edge) => selectedEdgeIds.has(edge.id))
    .map((edge) => edge.id);

  // Fit the view once, after the first layout lands. The guard is consumed
  // inside the rAF: while occluded, Chromium suppresses rAF and a topology
  // change cancels the pending fit — leaving the guard unset lets the next
  // layout completion schedule it again instead of losing it forever.
  useEffect(() => {
    if (isLayouting || positions.size === 0 || initialFitDone.current) return undefined;
    const raf = requestAnimationFrame(() => {
      initialFitDone.current = true;
      void fitView({ duration: reducedMotion ? 0 : 300, padding: 0.2 });
    });
    return () => cancelAnimationFrame(raf);
  }, [isLayouting, positions, fitView, reducedMotion]);

  const onNodesChange = (changes: NodeChange<WorkerFlowNode>[]): void => {
    setNodeUi((previous) => reduceNodeUi(previous, changes));
  };

  // Selection is tracked for every edge; only manual edges are removable
  // (measured edges are `deletable: false`, so xyflow never removes them).
  const onEdgesChange: OnEdgesChange<ProvenanceFlowEdge> = (changes) => {
    setSelectedEdgeIds((previous) => {
      let next = previous;
      for (const change of changes) {
        if (change.type === "select" && change.selected) next = next.union(new Set([change.id]));
        else if (change.type === "select" || change.type === "remove") {
          next = next.difference(new Set([change.id]));
        }
      }
      return next;
    });
    const removals = changes.filter((change) => change.type === "remove");
    if (removals.length > 0) setManualEdges((current) => applyEdgeChanges(removals, [...current]));
  };

  // Drawing between handles adds a MANUAL annotation edge — kept visually
  // and structurally distinct from measured edges (own kind, own legend
  // group) so an annotation is never mistaken for a measured fact.
  const onConnect = (connection: Connection): void => {
    const { source, target } = connection;
    setManualEdges((current) => [
      ...current,
      manualEdge(`manual-${source}-${target}-${Date.now()}`, source, target),
    ]);
  };

  const deleteSelectedManualEdges = (): void => {
    const doomed = new Set(selectedManualIds);
    setManualEdges((current) => current.filter((edge) => !doomed.has(edge.id)));
    setSelectedEdgeIds((previous) => previous.difference(doomed));
  };

  const openDetail = (workerId: string): void => {
    setSelectedId(workerId);
    setDetailOpen(true);
  };

  const openCausality = (edgeId: string): boolean => {
    const lastSeq = measuredEdges.find((edge) => edge.id === edgeId)?.data?.lastSeq;
    if (lastSeq === undefined) return false;
    setCausalityTarget({ startSeq: lastSeq });
    return true;
  };

  // A measured edge opens the causality inspector at its most recent
  // occurrence; a manual edge just selects (xyflow handles that).
  const handleEdgeClick: EdgeMouseHandler<ProvenanceFlowEdge> = (_event, edge) => {
    openCausality(edge.id);
  };

  const handleNodeClick: NodeMouseHandler<WorkerFlowNode> = (_event, node) => {
    setLinkSource(null);
    openDetail(node.id);
  };

  const handleNodeContextMenu: NodeMouseHandler<WorkerFlowNode> = (event, node) => {
    event.preventDefault();
    setContextMenu({
      x: event.clientX,
      y: event.clientY,
      workerId: node.id,
      openOnRelease: event.buttons !== 0,
    });
  };

  // Keyboard activation for the focusable node and edge wrappers xyflow
  // renders (Enter/Space only select them natively): a node opens its
  // detail panel, a measured edge its causality trace. L arms a focused
  // node as an annotation source, and Enter/Space on another node then
  // draws the manual edge: xyflow's connection handles are not focusable,
  // so this is the keyboard route to onConnect.
  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (!(event.target instanceof Element)) return;
    const element = event.target.closest<HTMLElement | SVGElement>(
      ".react-flow__node, .react-flow__edge",
    );
    const id = element?.dataset.id;
    if (!element || element !== event.target || !id) return;
    const isNode = element.classList.contains("react-flow__node");
    if (
      isNode &&
      event.key.toLowerCase() === "l" &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey
    ) {
      event.preventDefault();
      setLinkSource(id);
      return;
    }
    if (event.key === "Escape") {
      setLinkSource(null);
      return;
    }
    if (event.key !== "Enter" && event.key !== " ") return;
    if (isNode) {
      event.preventDefault();
      if (linkSource === null) {
        openDetail(id);
        return;
      }
      if (linkSource !== id && workerIds.includes(linkSource)) {
        onConnect({ source: linkSource, target: id, sourceHandle: null, targetHandle: null });
      }
      setLinkSource(null);
    } else if (openCausality(id)) {
      event.preventDefault();
    }
  };

  const resetLayout = (): void => {
    setNodeUi(
      (previous) =>
        new Map(previous.entries().map(([id, ui]) => [id, { ...ui, position: undefined }])),
    );
    runLayout();
  };

  const getWorkflow = (): WorkflowDefinition =>
    exportWorkflow(
      nodes.map((node) => ({
        id: node.id,
        type: node.type,
        position: node.position,
        data: { label: names[node.id] ?? node.id, index: node.data.index },
      })),
      manualEdges,
    );

  // Imports apply to what is live: saved positions for workers still
  // running, and annotation edges whose two ends are both on the canvas.
  // Nothing is fabricated for a worker that is not running.
  const importWorkflow = (workflow: WorkflowDefinition): string => {
    const live = new Set(workerIds);
    const placed = workflow.nodes.filter((node) => live.has(node.id));
    const annotations = workflow.edges.filter(
      (edge) => live.has(edge.source) && live.has(edge.target),
    );
    setNodeUi((previous) => {
      const next = new Map(previous);
      for (const node of placed)
        next.set(node.id, { ...next.get(node.id), position: node.position });
      return next;
    });
    setManualEdges((current) => {
      const known = new Set(current.map((edge) => edge.id));
      return [
        ...current,
        ...annotations
          .filter((edge) => !known.has(edge.id))
          .map((edge) => manualEdge(edge.id, edge.source, edge.target)),
      ];
    });
    return `Placed ${placed.length} Of ${workflow.nodes.length} Nodes, Added ${annotations.length} Annotations`;
  };

  if (workerIds.length === 0) {
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
        <svg width={48} height={48} viewBox="0 0 48 48" fill="none" aria-hidden="true">
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
            color: "var(--color-fg-dim)",
          }}
        >
          No Workers Running. Spawn A Worker To See The Topology Graph.
        </span>
      </div>
    );
  }

  return (
    <div className="worker-graph" style={{ width: "100%", height: "100%", position: "relative" }}>
      <p role="status" className="sr-only">
        {linkSource !== null
          ? `Linking From ${escapeForDisplay(names[linkSource] ?? linkSource)}: Focus Another Worker And Press Enter, Or Escape To Cancel`
          : isLayouting
            ? "Computing Layout"
            : ""}
      </p>
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
                role="alert"
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
                <Button variant="secondary" size="sm" onClick={runLayout}>
                  Retry Layout
                </Button>
              </div>
            ) : (
              <div
                aria-hidden="true"
                style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}
              >
                <Spinner size="lg" decorative className="text-plasma" />
                <span
                  style={{
                    fontFamily: "var(--font-body)",
                    fontSize: "0.75rem",
                    color: "var(--color-fg-dim)",
                  }}
                >
                  Computing Layout
                </span>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      <ReactFlow<WorkerFlowNode, ProvenanceFlowEdge>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        colorMode="dark"
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onNodeClick={handleNodeClick}
        onNodeContextMenu={handleNodeContextMenu}
        onEdgeClick={handleEdgeClick}
        onKeyDown={handleKeyDown}
        // Focus leaving the graph disarms a pending link. (On the flow
        // wrapper, not the outer div: Biome rejects handlers on static elements.)
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setLinkSource(null);
        }}
        deleteKeyCode={causalityTarget ? null : ["Backspace", "Delete"]}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={20} size={1} />

        <GraphLegend presentKinds={presentKinds} />

        {/* Empty-causality hint: workers exist but nothing measured has
            happened between them yet (e.g. three hand-spawned workers) —
            an honest, quiet canvas rather than a fabricated chain. Shown
            only once layout has settled, so it doesn't flash during the
            computing-layout overlay. */}
        {!isLayouting && !layoutError && edges.length === 0 && (
          <Panel
            position="bottom-center"
            title="Provenance Edges Are Session-Scoped In v1 — A Reload Shows Nodes Without Historical Edges By Design."
            style={{
              padding: "6px 14px",
              borderRadius: 999,
              background: "oklch(0.12 0.03 220 / 0.75)",
              backdropFilter: "blur(8px)",
              border: "1px solid oklch(0.22 0.04 220)",
              fontFamily: "var(--font-body)",
              fontSize: "0.6875rem",
              color: "var(--color-fg-dim)",
            }}
          >
            No Measured Causality Yet
          </Panel>
        )}

        <MiniMap<WorkerFlowNode> nodeColor={(node) => workerColor(node.data.index)} />
        <GraphControls
          onResetLayout={resetLayout}
          onDeleteEdge={selectedManualIds.length > 0 ? deleteSelectedManualEdges : undefined}
          getWorkflow={getWorkflow}
          onImport={importWorkflow}
        />
      </ReactFlow>

      {contextMenu && (
        <GraphContextMenu
          // A new right-click mounts a fresh menu; the closed one's late
          // `onClose` then no longer matches and is ignored.
          key={`${contextMenu.workerId}:${contextMenu.x}:${contextMenu.y}`}
          x={contextMenu.x}
          y={contextMenu.y}
          workerId={contextMenu.workerId}
          openOnRelease={contextMenu.openOnRelease}
          onInspect={() => openDetail(contextMenu.workerId)}
          onClose={() => setContextMenu((current) => (current === contextMenu ? null : current))}
        />
      )}
    </div>
  );
}

/**
 * Interactive Workers topology graph (measured causality): ELK layout,
 * node context menu, zoom controls, annotation edge drawing, workflow
 * export/import and a mini-map.
 *
 * Edges are MEASURED causal facts derived from stamped `swarm://events`
 * envelopes (see `#store/provenance`) — spawn/kill/command/message —
 * plus user-drawn `manual` annotations, kept visually and structurally
 * distinct. Workers with no measured causality render with zero edges
 * and a quiet "No Measured Causality Yet" hint; nothing is ever
 * fabricated. Motion honours the user's reduced-motion preference.
 */
export function WorkerGraph(): React.ReactElement {
  return (
    <ReactFlowProvider>
      <MotionConfig reducedMotion="user">
        <WorkerGraphInner />
      </MotionConfig>
    </ReactFlowProvider>
  );
}
