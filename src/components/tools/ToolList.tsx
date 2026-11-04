import type { CSSProperties } from "react";
import { useId } from "react";
import { Button } from "#components/ui/Button";
import { EmptyState } from "#components/ui/EmptyState";
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
  fontSize: "var(--text-md)",
  fontWeight: 500,
  color: "var(--color-fg-muted)",
};

const listStyle: CSSProperties = { display: "flex", flexDirection: "column" };

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
 * List of all tools (built-in + custom) as rule-divided rows: name,
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
      <section aria-labelledby={builtInHeadingId}>
        <h2 id={builtInHeadingId} style={sectionHeadingStyle}>
          Built-In{" "}
          <span className="font-mono text-fg-dim tabular-nums">{BUILT_IN_TOOLS.length}</span>
        </h2>
        <div className="divide-y divide-border" style={listStyle}>
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
        {/* New Tool belongs to the section it creates into. */}
        <div className="mb-2 flex items-center justify-between">
          <h2 id={customHeadingId} style={{ ...sectionHeadingStyle, margin: 0 }}>
            Custom <span className="font-mono text-fg-dim tabular-nums">{customTools.length}</span>
          </h2>
          <Button variant="primary" size="sm" onClick={onCreateNew}>
            New Tool
          </Button>
        </div>
        {customTools.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border">
            <EmptyState
              title="No Custom Tools Yet"
              body="Every AI Chat Request Offers Your Tools To Claude"
            />
          </div>
        ) : (
          <div className="divide-y divide-border" style={listStyle}>
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
      className="grid grid-cols-[200px_1fr_auto] items-baseline gap-x-4 py-3"
    >
      <h3
        id={headingId}
        style={{
          margin: 0,
          fontFamily: "var(--font-mono)",
          fontSize: "var(--text-md)",
          fontWeight: 600,
          color: "var(--color-plasma)",
        }}
      >
        {name}
      </h3>

      <p
        style={{
          fontFamily: "var(--font-body)",
          fontSize: "var(--text-sm)",
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

      <div className="flex items-center gap-1.5">
        <Pill tone="neutral" size="sm" className="tabular-nums">
          {pluralize("Param", paramCount)}
        </Pill>
        {onEdit && onDelete && (
          <>
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
          </>
        )}
      </div>
    </article>
  );
}
