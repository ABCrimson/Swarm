// ── Workflow Import/Export ───────────────────────────
// Serialise the Workers graph's layout and hand-drawn annotation edges to
// portable JSON, and validate a file on the way back in.

import * as z from "zod";

/** Serialisable node: a worker's id, node type, canvas position and display data. */
interface WorkflowNode {
  readonly id: string;
  readonly type: string;
  readonly position: { readonly x: number; readonly y: number };
  readonly data: Record<string, unknown>;
}

/** Serialisable annotation edge between two worker nodes. */
interface WorkflowEdge {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly label?: string;
}

/** Portable JSON representation of a Workers graph. */
export interface WorkflowDefinition {
  readonly id: string;
  readonly name: string;
  readonly nodes: readonly WorkflowNode[];
  readonly edges: readonly WorkflowEdge[];
}

const Id = z.string().min(1);

/**
 * The file format {@link exportWorkflow} writes. Positions must be finite
 * numbers and ids non-empty strings; unknown keys are ignored, so files
 * from older builds (which carried extra node data) still load.
 */
const WorkflowDefinitionSchema = z.object({
  id: Id,
  name: z.string(),
  nodes: z.array(
    z.object({
      id: Id,
      type: z.string(),
      position: z.object({ x: z.number(), y: z.number() }),
      data: z.record(z.string(), z.unknown()),
    }),
  ),
  edges: z.array(
    z.object({
      id: Id,
      source: Id,
      target: Id,
      label: z.string().optional(),
    }),
  ),
});

/** Shape of the nodes/edges {@link exportWorkflow} reads — a structural subset of xyflow's. */
interface ExportableNode {
  readonly id: string;
  readonly type?: string;
  readonly position: { readonly x: number; readonly y: number };
  readonly data: Record<string, unknown>;
}

interface ExportableEdge {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly label?: unknown;
}

/**
 * Exports graph nodes and annotation edges to a portable definition.
 *
 * `edges` MUST be the user's hand-drawn ("manual") annotations only. A
 * measured causal edge (spawn/kill/command/message, derived from a stamped
 * `swarm://events` envelope — see `#store/provenance`) is a fact of one
 * session, not a portable workflow; exporting it and importing it back
 * would launder it into a user annotation, the "measured fact merged with
 * annotation" outcome the provenance store forbids. `WorkerGraph` passes
 * only its manual edges here.
 *
 * @returns A {@link WorkflowDefinition} with a fresh UUID and a timestamped name.
 */
export function exportWorkflow(
  nodes: readonly ExportableNode[],
  edges: readonly ExportableEdge[],
): WorkflowDefinition {
  return {
    id: crypto.randomUUID(),
    name: `Workflow ${Temporal.Now.plainDateTimeISO().toString({ smallestUnit: "minute" })}`,
    nodes: nodes.map((n) => ({
      id: n.id,
      type: n.type ?? "worker",
      position: { x: n.position.x, y: n.position.y },
      data: n.data,
    })),
    edges: edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      ...(typeof e.label === "string" && { label: e.label }),
    })),
  };
}

/** Thrown by {@link parseWorkflow} with a Title Case, user-facing message. */
export class WorkflowFileError extends Error {
  override readonly name = "WorkflowFileError";
}

/**
 * Parses and validates the text of a workflow file.
 *
 * @throws {WorkflowFileError} when the text is not JSON or not a workflow
 *   definition; the message names the first offending field.
 */
export function parseWorkflow(text: string): WorkflowDefinition {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new WorkflowFileError("The File Is Not Valid JSON");
  }
  const parsed = WorkflowDefinitionSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.length ? ` At ${issue.path.join(".")}` : "";
    throw new WorkflowFileError(`Not A SWARM Workflow File (Invalid Value${where})`);
  }
  return parsed.data;
}
