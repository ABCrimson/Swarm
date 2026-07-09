/**
 * Web Worker for ELK graph layout computation.
 *
 * Receives node/edge data, runs the ELK layered algorithm off the main thread,
 * and posts back computed positions. Uses layer-sweep crossing minimisation
 * for clean top-down dependency graphs.
 *
 * @module elk.worker
 */

/// <reference lib="webworker" />

import type { ElkExtendedEdge, ElkNode } from "elkjs";
import ELK from "elkjs";

/** Node descriptor sent from the main thread. */
interface IncomingNode {
  readonly id: string;
  readonly width: number;
  readonly height: number;
}

/** Edge descriptor sent from the main thread. */
interface IncomingEdge {
  readonly id: string;
  readonly source: string;
  readonly target: string;
}

/** Payload received via `postMessage` from the main thread. */
interface LayoutRequest {
  readonly nodes: readonly IncomingNode[];
  readonly edges: readonly IncomingEdge[];
  readonly options?: Record<string, string>;
}

/** Positioned node returned after ELK layout computation. */
interface LayoutedNode {
  readonly id: string;
  readonly x: number;
  readonly y: number;
}

/** Response payload sent back via `postMessage`. */
interface LayoutResponse {
  readonly layoutedNodes: readonly LayoutedNode[];
}

const elk = new ELK();

const DEFAULT_OPTIONS: Record<string, string> = {
  "elk.algorithm": "layered",
  "elk.direction": "DOWN",
  "elk.spacing.nodeNode": "40",
  "elk.spacing.edgeNode": "60",
  "elk.layered.spacing.nodeNodeBetweenLayers": "60",
  "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
};

/** Run the ELK layered layout algorithm and return computed positions. */
async function computeLayout(request: LayoutRequest): Promise<LayoutResponse> {
  const graph: ElkNode = {
    id: "root",
    layoutOptions: { ...DEFAULT_OPTIONS, ...request.options },
    children: request.nodes.map((n) => ({
      id: n.id,
      width: n.width,
      height: n.height,
    })),
    edges: request.edges.map(
      (e): ElkExtendedEdge => ({
        id: e.id,
        sources: [e.source],
        targets: [e.target],
      }),
    ),
  };

  const result = await elk.layout(graph);

  const layoutedNodes: LayoutedNode[] = (result.children ?? []).map((child) => ({
    id: child.id,
    x: child.x ?? 0,
    y: child.y ?? 0,
  }));

  return { layoutedNodes };
}

self.onmessage = async (event: MessageEvent<LayoutRequest>) => {
  try {
    const response = await computeLayout(event.data);
    self.postMessage(response);
  } catch (error) {
    self.postMessage({
      error: error instanceof Error ? error.message : "Layout computation failed",
    });
  }
};
