/**
 * Side-by-side diff viewer for comparing worker outputs.
 *
 * Displays two text outputs with color-coded line-level differences:
 * equal lines in neutral, insertions in green, deletions in rose.
 * Uses glass-panel styling and OKLCH color tokens.
 */


import type { DiffSegment } from "#lib/diff";
import { computeDiff } from "#lib/diff";

type DiffViewerProps = {
  readonly leftLabel: string;
  readonly rightLabel: string;
  readonly leftContent: string;
  readonly rightContent: string;
};

/** Line entry with a stable key, line number, and diff type for rendering. */
type DiffLine = {
  readonly key: string;
  readonly lineNumber: number | null;
  readonly value: string;
  readonly type: DiffSegment["type"];
};

function buildSides(segments: DiffSegment[]): {
  left: DiffLine[];
  right: DiffLine[];
} {
  const left: DiffLine[] = [];
  const right: DiffLine[] = [];
  let leftNum = 1;
  let rightNum = 1;
  let row = 0;

  for (const seg of segments) {
    switch (seg.type) {
      case "equal":
        left.push({ key: `l-eq-${row}`, lineNumber: leftNum++, value: seg.value, type: "equal" });
        right.push({
          key: `r-eq-${row}`,
          lineNumber: rightNum++,
          value: seg.value,
          type: "equal",
        });
        break;
      case "delete":
        left.push({
          key: `l-del-${row}`,
          lineNumber: leftNum++,
          value: seg.value,
          type: "delete",
        });
        right.push({ key: `r-pad-${row}`, lineNumber: null, value: "", type: "equal" });
        break;
      case "insert":
        left.push({ key: `l-pad-${row}`, lineNumber: null, value: "", type: "equal" });
        right.push({
          key: `r-ins-${row}`,
          lineNumber: rightNum++,
          value: seg.value,
          type: "insert",
        });
        break;
    }
    row++;
  }

  return { left, right };
}

/**
 * Side-by-side diff viewer component with line numbers and glass-panel styling.
 *
 * Computes a line-level diff and renders both sides with color-coded
 * equal (neutral), inserted (green/lime), and deleted (rose) lines.
 */
export function DiffViewer({
  leftLabel,
  rightLabel,
  leftContent,
  rightContent,
}: DiffViewerProps): React.ReactElement {
  const segments = computeDiff(leftContent, rightContent);
  const { left, right } = buildSides(segments);

  return (
    <div className="glass-panel rounded-lg overflow-hidden" style={{ width: "100%" }}>
      <div className="flex" style={{ minHeight: 0 }}>
        {/* Left pane */}
        <div className="flex-1 min-w-0" style={{ borderRight: "1px solid oklch(0.22 0.04 220)" }}>
          <div
            className="px-3 py-2 font-mono text-xs font-semibold"
            style={{
              color: "oklch(0.55 0.04 220)",
              borderBottom: "1px solid oklch(0.22 0.04 220)",
              background: "oklch(0.09 0.02 220)",
            }}
          >
            {leftLabel}
          </div>
          <div className="scroll-area overflow-auto" style={{ maxHeight: 480 }}>
            <pre className="font-mono text-xs leading-relaxed" style={{ margin: 0, padding: 0 }}>
              {left.map((line) => (
                <DiffLineRow key={line.key} line={line} />
              ))}
            </pre>
          </div>
        </div>

        {/* Right pane */}
        <div className="flex-1 min-w-0">
          <div
            className="px-3 py-2 font-mono text-xs font-semibold"
            style={{
              color: "oklch(0.55 0.04 220)",
              borderBottom: "1px solid oklch(0.22 0.04 220)",
              background: "oklch(0.09 0.02 220)",
            }}
          >
            {rightLabel}
          </div>
          <div className="scroll-area overflow-auto" style={{ maxHeight: 480 }}>
            <pre className="font-mono text-xs leading-relaxed" style={{ margin: 0, padding: 0 }}>
              {right.map((line) => (
                <DiffLineRow key={line.key} line={line} />
              ))}
            </pre>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Internal line renderer ──────────────────────────

const LINE_STYLES: Record<DiffSegment["type"], React.CSSProperties> = {
  equal: {
    color: "oklch(0.85 0.04 220)",
    background: "oklch(0 0 0 / 0)",
  },
  insert: {
    color: "oklch(0.82 0.18 140)",
    background: "oklch(0.82 0.18 140 / 0.08)",
  },
  delete: {
    color: "oklch(0.72 0.20 10)",
    background: "oklch(0.72 0.20 10 / 0.08)",
  },
};

function DiffLineRow({ line }: { readonly line: DiffLine }): React.ReactElement {
  const style = LINE_STYLES[line.type];

  return (
    <div className="flex" style={{ ...style, minHeight: "1.5em" }}>
      <span
        className="select-none text-right shrink-0"
        style={{
          width: 40,
          paddingRight: 8,
          paddingLeft: 8,
          color: "oklch(0.55 0.04 220)",
          opacity: line.lineNumber != null ? 0.6 : 0,
          userSelect: "none",
        }}
      >
        {line.lineNumber ?? ""}
      </span>
      <span className="px-2 whitespace-pre-wrap break-all flex-1">{line.value}</span>
    </div>
  );
}
