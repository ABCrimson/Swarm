// ── Workflow Import/Export ───────────────────────────
// Serialise and deserialise visual workflow graphs to/from portable JSON.

import type { Edge, Node } from "@xyflow/react";

/** Serialisable node definition within a workflow. */
export interface WorkflowNode {
  readonly id: string;
  readonly type: string;
  readonly position: { readonly x: number; readonly y: number };
  readonly data: Record<string, unknown>;
}

/** Serialisable edge definition within a workflow. */
export interface WorkflowEdge {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly label?: string;
}

/** Portable JSON representation of a visual workflow graph. */
export interface WorkflowDefinition {
  readonly id: string;
  readonly name: string;
  readonly nodes: WorkflowNode[];
  readonly edges: WorkflowEdge[];
}

/**
 * Exports the current React Flow graph state to a portable JSON definition.
 *
 * @param nodes - Current React Flow nodes with positions and data.
 * @param edges - Current React Flow edges with source/target connections.
 * @returns A serialisable {@link WorkflowDefinition} with a generated UUID.
 */
export function exportWorkflow(nodes: Node[], edges: Edge[]): WorkflowDefinition {
  return {
    id: crypto.randomUUID(),
    name: `Workflow ${new Date().toISOString().slice(0, 16)}`,
    nodes: nodes.map((n) => ({
      id: n.id,
      type: n.type ?? "worker",
      position: { x: n.position.x, y: n.position.y },
      data: n.data as Record<string, unknown>,
    })),
    edges: edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      label: typeof e.label === "string" ? e.label : undefined,
    })),
  };
}

/**
 * Imports a workflow definition back into React Flow node/edge arrays.
 *
 * @param def - A previously exported {@link WorkflowDefinition}.
 * @returns An object with `nodes` and `edges` arrays ready for React Flow.
 */
export function importWorkflow(def: WorkflowDefinition): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = def.nodes.map((n) => ({
    id: n.id,
    type: n.type,
    position: { x: n.position.x, y: n.position.y },
    data: n.data,
  }));

  const edges: Edge[] = def.edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    type: "spawnOrder",
    label: e.label,
  }));

  return { nodes, edges };
}
