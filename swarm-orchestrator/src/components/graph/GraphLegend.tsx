import { Panel } from "@xyflow/react";
import type { GraphEdgeKind } from "./ProvenanceEdge.tsx";

interface LegendRow {
  readonly kind: GraphEdgeKind;
  readonly label: string;
  readonly stroke: string;
  readonly dash?: string;
}

/**
 * Fixed row order/style, kept separate from `ProvenanceEdge`'s
 * `KIND_STYLE` so a legend swatch can be a plain solid line (no
 * measured-only dash-flow animation) even for kinds that animate on
 * canvas.
 */
const LEGEND_ROWS: readonly LegendRow[] = [
  { kind: "spawn", label: "Spawn", stroke: "oklch(0.78 0.18 205 / 0.8)" },
  { kind: "kill", label: "Kill", stroke: "oklch(0.72 0.20 10 / 0.8)", dash: "3 3" },
  { kind: "command", label: "Command", stroke: "oklch(0.75 0.19 145 / 0.8)", dash: "7 3" },
  { kind: "message", label: "Message", stroke: "oklch(0.80 0.15 85 / 0.8)", dash: "1.5 3" },
  { kind: "manual", label: "Manual", stroke: "oklch(0.60 0.02 220 / 0.6)", dash: "8 4" },
];

interface GraphLegendProps {
  /** The edge kinds actually present on the current canvas. */
  readonly presentKinds: ReadonlySet<GraphEdgeKind>;
}

/** Title Case group header separating measured facts from the user-drawn annotation kind — see the component doc for why this can't just be "one more row" visually. */
const ANNOTATION_GROUP_LABEL = "Annotation";

/**
 * Legend for the Workers topology graph — one row per edge kind
 * ACTUALLY rendered, gated on presence (a row for a kind with zero
 * edges would describe a line style nothing on screen uses). Renders
 * nothing at all when no edges are present, matching the graph's empty
 * state — an empty canvas needs no key.
 *
 * Measured kinds (spawn/kill/command/message) and the manual annotation
 * kind always render in this fixed order so the legend never implies
 * measured facts and user annotations are the same category of thing —
 * a same-list, same-style row for "Manual" right after "Message" would
 * only ASSERT that distinction in prose (the component doc above) while
 * looking, on screen, exactly like one more measured kind. A separator
 * plus an "Annotation" group header makes the never-merge claim visibly
 * true, not just documented.
 */
export function GraphLegend({ presentKinds }: GraphLegendProps): React.ReactElement | null {
  const measuredRows = LEGEND_ROWS.filter(
    (row) => row.kind !== "manual" && presentKinds.has(row.kind),
  );
  const manualRow = LEGEND_ROWS.find((row) => row.kind === "manual" && presentKinds.has(row.kind));
  if (measuredRows.length === 0 && !manualRow) return null;

  const renderRow = (row: LegendRow): React.ReactElement => (
    <div key={row.kind} style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <svg width={20} height={8} viewBox="0 0 20 8" aria-hidden="true">
        <line
          x1={1}
          y1={4}
          x2={19}
          y2={4}
          stroke={row.stroke}
          strokeWidth={2}
          strokeDasharray={row.dash}
        />
      </svg>
      <span>{row.label}</span>
    </div>
  );

  return (
    <Panel
      position="top-left"
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
      {measuredRows.map(renderRow)}

      {manualRow && (
        <>
          {measuredRows.length > 0 && (
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
              color: "oklch(0.45 0.04 220)",
            }}
          >
            {ANNOTATION_GROUP_LABEL}
          </span>
          {renderRow(manualRow)}
        </>
      )}
    </Panel>
  );
}
