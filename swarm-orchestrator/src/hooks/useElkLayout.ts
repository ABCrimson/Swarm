import type { Edge, Node } from "@xyflow/react";
import type { ElkExtendedEdge, ElkNode } from "elkjs";
import ELK from "elkjs/lib/elk.bundled.js";
import { useEffect, useRef, useState } from "react";

interface ElkLayoutReturn {
  readonly layoutedNodes: Node[];
  readonly layoutedEdges: Edge[];
  readonly isLayouting: boolean;
  /** Set when the layout worker fails to start or errors out; cleared on the next `runLayout()`. */
  readonly error: string | null;
  readonly runLayout: () => void;
}

const NODE_WIDTH = 220;
const NODE_HEIGHT = 100;

const DEFAULT_LAYOUT_OPTIONS: Record<string, string> = {
  "elk.algorithm": "layered",
  "elk.direction": "DOWN",
  "elk.spacing.nodeNode": "40",
  "elk.spacing.edgeNode": "60",
  "elk.layered.spacing.nodeNodeBetweenLayers": "60",
  "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
};

/** Shown when the ELK layout worker fails to start, crashes, or sends an unreadable message. */
const LAYOUT_ENGINE_ERROR = "Layout Engine Failed To Start";

/**
 * Generates a stable fingerprint of the topology for deep comparison.
 * Only re-layouts when the node set or edge connections actually change.
 */
function topologyFingerprint(nodes: Node[], edges: Edge[]): string {
  const nodeIds = nodes
    .map((n) => n.id)
    .toSorted()
    .join(",");
  const edgeIds = edges
    .map((e) => `${e.source}->${e.target}`)
    .toSorted()
    .join(",");
  return `${nodeIds}|${edgeIds}`;
}

/**
 * Computes an ELK graph layout via a dedicated Web Worker.
 *
 * Constructs elkjs's own `ELK` class on the main thread with a
 * `workerFactory` that spawns exactly one dedicated, non-nested Worker
 * (`src/workers/elk.worker.ts`, which itself *is* elkjs's worker script —
 * see that file's header for why). elkjs drives its register/layout
 * protocol over that single worker and resolves/rejects `.layout()`
 * accordingly; a `worker.onerror`/`onmessageerror` failure is surfaced
 * through the `error` return value instead of leaving `isLayouting` stuck.
 *
 * Automatically re-runs layout when the topology fingerprint changes.
 * Node positions are applied via `requestAnimationFrame` to avoid layout thrash.
 *
 * @param nodes - React Flow nodes to position.
 * @param edges - React Flow edges defining connections.
 * @returns Layouted nodes/edges, loading/error state, and manual `runLayout` trigger.
 */
export function useElkLayout(nodes: Node[], edges: Edge[]): ElkLayoutReturn {
  const [layoutedNodes, setLayoutedNodes] = useState<Node[]>(nodes);
  const [layoutedEdges, setLayoutedEdges] = useState<Edge[]>(edges);
  const [isLayouting, setIsLayouting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const elkRef = useRef<InstanceType<typeof ELK> | null>(null);
  const prevFingerprintRef = useRef<string>("");
  const nodesRef = useRef<Node[]>(nodes);
  const edgesRef = useRef<Edge[]>(edges);
  const rafIdRef = useRef<number | null>(null);

  nodesRef.current = nodes;
  edgesRef.current = edges;

  // Construct the ELK driver (and its single, non-nested worker) once on
  // mount, terminate on unmount.
  useEffect(() => {
    const handleWorkerFailure = (): void => {
      setError(LAYOUT_ENGINE_ERROR);
      setIsLayouting(false);
    };

    const elk = new ELK({
      workerFactory: () => {
        const worker = new Worker(new URL("../workers/elk.worker.ts", import.meta.url), {
          type: "module",
        });
        worker.onerror = handleWorkerFailure;
        worker.onmessageerror = handleWorkerFailure;
        return worker;
      },
    });

    elkRef.current = elk;

    return () => {
      elk.terminateWorker();
      elkRef.current = null;
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
    };
  }, []);

  const runLayout = (): void => {
    const elk = elkRef.current;
    if (!elk) return;

    const currentNodes = nodesRef.current;
    const currentEdges = edgesRef.current;

    setIsLayouting(true);
    setError(null);

    const graph: ElkNode = {
      id: "root",
      layoutOptions: DEFAULT_LAYOUT_OPTIONS,
      children: currentNodes.map((n) => ({
        id: n.id,
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
      })),
      edges: currentEdges.map(
        (e): ElkExtendedEdge => ({
          id: e.id,
          sources: [e.source],
          targets: [e.target],
        }),
      ),
    };

    elk
      .layout(graph)
      .then((result) => {
        rafIdRef.current = requestAnimationFrame(() => {
          rafIdRef.current = null;

          const positionMap = new Map(
            (result.children ?? []).map((child) => [
              child.id,
              { x: child.x ?? 0, y: child.y ?? 0 },
            ]),
          );

          const updated = nodesRef.current.map((node) => {
            const pos = positionMap.get(node.id);
            if (pos) {
              return { ...node, position: { x: pos.x, y: pos.y } };
            }
            return node;
          });

          setLayoutedNodes(updated);
          setLayoutedEdges(edgesRef.current);
          setIsLayouting(false);
        });
      })
      .catch(() => {
        setError(LAYOUT_ENGINE_ERROR);
        setIsLayouting(false);
      });
  };

  // Auto-layout when topology changes
  // biome-ignore lint/correctness/useExhaustiveDependencies: runLayout is recreated every render but only reads refs; adding it would re-run this effect on every render (the fingerprint guard would still block extra layouts, but re-computing the fingerprint on every render is wasted work we intentionally avoid)
  useEffect(() => {
    const fingerprint = topologyFingerprint(nodes, edges);

    if (fingerprint !== prevFingerprintRef.current) {
      prevFingerprintRef.current = fingerprint;
      runLayout();
    }
  }, [nodes, edges]);

  return { layoutedNodes, layoutedEdges, isLayouting, error, runLayout };
}
