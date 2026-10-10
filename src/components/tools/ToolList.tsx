import type { CSSProperties } from "react";
import { useId } from "react";
import { Button } from "#components/ui/Button";
import { Pill } from "#components/ui/Pill";
import type { CustomToolDef } from "#lib/custom-tools";
import { pluralize } from "#lib/format";
import { toolRegistry } from "#lib/tools";

/** Props for the tool list component. */
interface ToolListProps {
  /** Custom tools created by the user. */
  readonly customTools: readonly CustomToolDef[];
  /** Callback to edit a custom tool. */
  readonly onEdit: (tool: CustomToolDef) => void;
  /** Callback to delete a custom tool. */
  readonly onDelete: (tool: CustomToolDef) => void;
  /** Callback to create a new tool. */
  readonly onCreateNew: () => void;
}

const sectionHeadingStyle: CSSProperties = {
  margin: "0 0 8px",
  fontFamily: "var(--font-body)",
  fontSize: "0.6875rem",
  fontWeight: 600,
  color: "var(--color-fg-dim)",
  textTransform: "uppercase",
  letterSpacing: "0.06em",
};

const gridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
  gap: 8,
};

/** Built-in tools as shown on the page — their Title Case `uiDescription`, never the model-facing one. */
const BUILT_IN_TOOLS = toolRegistry
  .values()
  .map((tool) => {
    const { properties } = tool.anthropicTool.input_schema;
    return {
      name: tool.name,
      description: tool.uiDescription,
      paramCount: properties && typeof properties === "object" ? Object.keys(properties).length : 0,
    };
  })
  .toArray();

/**
 * List of all tools (built-in + custom) as OKLCH-styled cards: name,
 * description and parameter count, with Edit/Delete actions (named per
 * tool for assistive technology) on custom tools.
 */
export function ToolList({
  customTools,
  onEdit,
  onDelete,
  onCreateNew,
}: ToolListProps): React.ReactElement {
  const builtInHeadingId = useId();
  const customHeadingId = useId();

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 16,
        height: "100%",
        overflow: "auto",
        padding: 16,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span
          style={{
            fontFamily: "var(--font-display)",
            fontSize: "0.75rem",
            fontWeight: 700,
            letterSpacing: "0.04em",
            color: "oklch(0.65 0.04 220)",
            textTransform: "uppercase",
          }}
        >
          Tools ({BUILT_IN_TOOLS.length + customTools.length})
        </span>
        <Button variant="secondary" size="sm" onClick={onCreateNew}>
          + New Tool
        </Button>
      </div>

      <section aria-labelledby={builtInHeadingId}>
        <h2 id={builtInHeadingId} style={sectionHeadingStyle}>
          Built-In
        </h2>
        <div style={gridStyle}>
          {BUILT_IN_TOOLS.map((tool) => (
            <ToolCard
              key={tool.name}
              name={tool.name}
              description={tool.description}
              paramCount={tool.paramCount}
            />
          ))}
        </div>
      </section>

      <section aria-labelledby={customHeadingId}>
        <h2 id={customHeadingId} style={sectionHeadingStyle}>
          Custom
        </h2>
        {customTools.length === 0 ? (
          <p
            style={{
              margin: 0,
              padding: "24px 16px",
              textAlign: "center",
              fontFamily: "var(--font-body)",
              fontSize: "0.8125rem",
              color: "var(--color-fg-dim)",
              border: "1px dashed oklch(0.22 0.04 220)",
              borderRadius: 12,
            }}
          >
            No Custom Tools Yet. Click “New Tool” To Create One.
          </p>
        ) : (
          <div style={gridStyle}>
            {customTools.map((tool) => (
              <ToolCard
                key={tool.id}
                name={tool.name}
                description={tool.description}
                paramCount={tool.params.filter((param) => param.name !== "").length}
                onEdit={() => onEdit(tool)}
                onDelete={() => onDelete(tool)}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function ToolCard({
  name,
  description,
  paramCount,
  onEdit,
  onDelete,
}: {
  readonly name: string;
  readonly description: string;
  readonly paramCount: number;
  /** Present on custom tools only — built-ins cannot be edited or deleted. */
  readonly onEdit?: () => void;
  readonly onDelete?: () => void;
}): React.ReactElement {
  const headingId = useId();
  return (
    <article
      aria-labelledby={headingId}
      style={{
        padding: 14,
        borderRadius: 10,
        border: "1px solid oklch(0.22 0.04 220)",
        background: "oklch(0.10 0.03 220 / 0.5)",
        backdropFilter: "blur(12px) saturate(1.5)",
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <h3
          id={headingId}
          style={{
            margin: 0,
            fontFamily: "var(--font-mono)",
            fontSize: "0.8125rem",
            fontWeight: 600,
            color: "oklch(0.78 0.18 205)",
          }}
        >
          {name}
        </h3>
        <Pill tone="neutral" size="sm">
          {pluralize("Param", paramCount)}
        </Pill>
      </div>

      <p
        style={{
          fontFamily: "var(--font-body)",
          fontSize: "0.75rem",
          color: "var(--color-fg-dim)",
          lineHeight: 1.5,
          margin: 0,
          overflow: "hidden",
          display: "-webkit-box",
          WebkitLineClamp: 2,
          WebkitBoxOrient: "vertical",
        }}
      >
        {description}
      </p>

      {onEdit && onDelete && (
        <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
          <Pill interactive tone="neutral" size="sm" onClick={onEdit} aria-label={`Edit ${name}`}>
            Edit
          </Pill>
          <Pill
            interactive
            tone="danger"
            size="sm"
            onClick={onDelete}
            aria-label={`Delete ${name}`}
          >
            Delete
          </Pill>
        </div>
      )}
    </article>
  );
}
