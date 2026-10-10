import { Panel } from "@xyflow/react";
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
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <svg width={20} height={8} viewBox="0 0 20 8" aria-hidden="true">
        <line x1={1} y1={4} x2={19} y2={4} stroke={stroke} strokeWidth={2} strokeDasharray={dash} />
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
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 6,
        padding: "8px 10px",
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
      {measuredKinds.map((kind) => (
        <LegendRow key={kind} kind={kind} />
      ))}

      {showManual && (
        <>
          {measuredKinds.length > 0 && (
            <hr
              style={{
                width: "100%",
                height: 1,
                margin: "2px 0",
                border: "none",
                background: "oklch(0.28 0.05 220)",
              }}
            />
          )}
          <span
            style={{
              fontSize: "0.5625rem",
              fontWeight: 600,
              letterSpacing: "0.06em",
              textTransform: "uppercase",
              color: "var(--color-fg-dim)",
            }}
          >
            {ANNOTATION_GROUP_LABEL}
          </span>
          <LegendRow kind="manual" />
        </>
      )}
    </Panel>
  );
}
