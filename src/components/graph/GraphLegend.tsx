import { Panel } from "@xyflow/react";
import type { CSSProperties } from "react";
import type { GraphEdgeKind } from "#components/graph/ProvenanceEdge";
import { KIND_LABEL, KIND_STYLE } from "#components/graph/ProvenanceEdge";

/** Measured kinds in legend order; the manual annotation kind is listed separately. */
const MEASURED_KINDS = ["spawn", "kill", "command", "message"] as const satisfies readonly Exclude<
  GraphEdgeKind,
  "manual"
>[];

interface GraphLegendProps {
  /** The edge kinds actually present on the current canvas. */
  readonly presentKinds: ReadonlySet<GraphEdgeKind>;
}

/** Title Case group header separating measured facts from the user-drawn annotation kind — see the component doc for why this can't just be "one more row" visually. */
const ANNOTATION_GROUP_LABEL = "Annotation";

/** One swatch row: a static line in the kind's stroke and dash (the canvas pulse is not drawn here). */
function LegendRow({ kind }: { readonly kind: GraphEdgeKind }): React.ReactElement {
  const { stroke, dash } = KIND_STYLE[kind];
  return (
    <div className="flex items-center gap-2">
      <svg width={20} height={8} viewBox="0 0 20 8" aria-hidden="true">
        <line
          x1={1}
          y1={4}
          x2={19}
          y2={4}
          className="[stroke:var(--legend-stroke)]"
          style={{ "--legend-stroke": stroke } as CSSProperties}
          strokeWidth={2}
          strokeDasharray={dash}
        />
      </svg>
      <span>{KIND_LABEL[kind]}</span>
    </div>
  );
}

/**
 * Legend for the Workers topology graph — one row per edge kind
 * ACTUALLY rendered, gated on presence (a row for a kind with zero
 * edges would describe a line style nothing on screen uses). Renders
 * nothing at all when no edges are present, matching the graph's empty
 * state — an empty canvas needs no key. Swatches are drawn from
 * `ProvenanceEdge`'s own `KIND_STYLE`, so the key can never drift from
 * the canvas.
 *
 * Measured kinds (spawn/kill/command/message) and the manual annotation
 * kind always render in this fixed order so the legend never implies
 * measured facts and user annotations are the same category of thing —
 * a same-list, same-style row for "Manual" right after "Message" would
 * only ASSERT that distinction in prose while looking, on screen,
 * exactly like one more measured kind. A separator plus an "Annotation"
 * group header makes the never-merge claim visibly true.
 */
export function GraphLegend({ presentKinds }: GraphLegendProps): React.ReactElement | null {
  const measuredKinds = MEASURED_KINDS.filter((kind) => presentKinds.has(kind));
  const showManual = presentKinds.has("manual");
  if (measuredKinds.length === 0 && !showManual) return null;

  return (
    <Panel
      position="top-left"
      role="note"
      aria-label="Edge Legend"
      className="flex flex-col gap-1.5 rounded-md border border-border-2 bg-[oklch(0.12_0.03_220/0.85)] px-2.5 py-2 font-body text-[0.6875rem] font-medium text-[color:oklch(0.65_0.04_220)] backdrop-blur-[8px]"
    >
      {measuredKinds.map((kind) => (
        <LegendRow key={kind} kind={kind} />
      ))}

      {showManual && (
        <>
          {measuredKinds.length > 0 && (
            <hr className="my-0.5 h-px w-full border-none bg-border-2" />
          )}
          <span className="font-display text-[length:var(--text-md)] font-semibold tracking-[-0.01em] text-fg-dim">
            {ANNOTATION_GROUP_LABEL}
          </span>
          <LegendRow kind="manual" />
        </>
      )}
    </Panel>
  );
}
