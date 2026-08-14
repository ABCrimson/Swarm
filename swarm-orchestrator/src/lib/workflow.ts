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
 * `edges` MUST already be filtered to portable/user-authored ("manual")
 * edges only — this function serializes whatever it's given verbatim,
 * dropping each edge's `data.kind` entirely, and `importWorkflow` below
 * always re-tags every imported edge `kind: "manual"`. Passing a
 * MEASURED causal edge (spawn/kill/command/message, derived from a
 * stamped `swarm://events` envelope — see `#store/provenance`) through
 * this round-trip would silently launder it into a user annotation on
 * re-import, exactly the "measured fact merged with annotation" outcome
 * the provenance store's own doc forbids. `WorkerGraph.tsx` enforces
 * this by only ever passing its `manualEdges` state here, never the
 * combined measured+manual `edges` array.
 *
 * @param nodes - Current React Flow nodes with positions and data.
 * @param edges - Current React Flow edges with source/target connections — manual/portable only, see above.
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
    // Imported edges are inherently user-authored, not measured facts
    // derived from a stamped envelope — the "manual" kind keeps them
    // visually and structurally distinct from provenance edges (see
    // `ProvenanceEdge.tsx`), same as one hand-drawn via `onConnect`.
    type: "provenance",
    data: { kind: "manual" },
    label: e.label,
  }));

  return { nodes, edges };
}
