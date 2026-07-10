import type { Edge, Node } from "@xyflow/react";
import { useEffect, useRef, useState } from "react";

interface LayoutedResult {
  readonly layoutedNodes: readonly { id: string; x: number; y: number }[];
}

interface ElkLayoutReturn {
  readonly layoutedNodes: Node[];
  readonly layoutedEdges: Edge[];
  readonly isLayouting: boolean;
  readonly runLayout: () => void;
}

const NODE_WIDTH = 220;
const NODE_HEIGHT = 100;

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
 * Automatically re-runs layout when the topology fingerprint changes.
 * Node positions are applied via `requestAnimationFrame` to avoid layout thrash.
 *
 * @param nodes - React Flow nodes to position.
 * @param edges - React Flow edges defining connections.
 * @returns Layouted nodes/edges, loading state, and manual `runLayout` trigger.
 */
export function useElkLayout(nodes: Node[], edges: Edge[]): ElkLayoutReturn {
  const [layoutedNodes, setLayoutedNodes] = useState<Node[]>(nodes);
  const [layoutedEdges, setLayoutedEdges] = useState<Edge[]>(edges);
  const [isLayouting, setIsLayouting] = useState(false);

  const workerRef = useRef<Worker | null>(null);
  const prevFingerprintRef = useRef<string>("");
  const nodesRef = useRef<Node[]>(nodes);
  const edgesRef = useRef<Edge[]>(edges);
  const rafIdRef = useRef<number | null>(null);

  nodesRef.current = nodes;
  edgesRef.current = edges;

  // Spawn worker once on mount, terminate on unmount
  useEffect(() => {
    const worker = new Worker(new URL("../workers/elk.worker.ts", import.meta.url), {
      type: "module",
    });

    worker.onmessage = (event: MessageEvent<LayoutedResult>) => {
      const { layoutedNodes: positions } = event.data;

      rafIdRef.current = requestAnimationFrame(() => {
        rafIdRef.current = null;
        const currentNodes = nodesRef.current;
        const currentEdges = edgesRef.current;

        const positionMap = new Map(positions.map((p) => [p.id, { x: p.x, y: p.y }]));

        const updated = currentNodes.map((node) => {
          const pos = positionMap.get(node.id);
          if (pos) {
            return { ...node, position: { x: pos.x, y: pos.y } };
          }
          return node;
        });

        setLayoutedNodes(updated);
        setLayoutedEdges(currentEdges);
        setIsLayouting(false);
      });
    };

    workerRef.current = worker;

    return () => {
      worker.terminate();
      workerRef.current = null;
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
    };
  }, []);

  const runLayout = (): void => {
    const worker = workerRef.current;
    if (!worker) return;

    const currentNodes = nodesRef.current;
    const currentEdges = edgesRef.current;

    setIsLayouting(true);

    worker.postMessage({
      nodes: currentNodes.map((n) => ({
        id: n.id,
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
      })),
      edges: currentEdges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
      })),
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

  return { layoutedNodes, layoutedEdges, isLayouting, runLayout };
}
