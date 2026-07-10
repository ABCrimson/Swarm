import { Pill } from "#components/ui/Pill";
import { pluralize } from "#lib/format";
import { toolRegistry } from "#lib/tools";

import type { CustomToolDef } from "./ToolBuilder.tsx";

/** Props for the tool list component. */
interface ToolListProps {
  /** Custom tools created by the user. */
  readonly customTools: CustomToolDef[];
  /** Callback to edit a custom tool. */
  readonly onEdit: (tool: CustomToolDef) => void;
  /** Callback to delete a custom tool. */
  readonly onDelete: (id: string) => void;
  /** Callback to create a new tool. */
  readonly onCreateNew: () => void;
}

/**
 * List of all tools (built-in + custom) displayed as OKLCH-styled cards.
 *
 * Shows tool name, description, and parameter count. Custom tools
 * include edit and delete actions.
 */
export function ToolList({
  customTools,
  onEdit,
  onDelete,
  onCreateNew,
}: ToolListProps): React.ReactElement {
  // Merge built-in and custom tools. Built-in tools show `uiDescription`
  // (Title Case, UI-only) here — `description` (sentence case) is reserved
  // for the Anthropic API tool-schema path; see #lib/tools.
  const builtInTools = [...toolRegistry.values()].map((tool) => ({
    name: tool.name,
    description: tool.uiDescription,
    paramCount: Object.keys(
      (tool.anthropicTool.input_schema as { properties?: Record<string, unknown> }).properties ??
        {},
    ).length,
    isCustom: false as const,
  }));

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
      {/* Header with create button */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
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
          Tools ({builtInTools.length + customTools.length})
        </span>
        <button
          type="button"
          onClick={onCreateNew}
          style={{
            padding: "6px 14px",
            borderRadius: 8,
            border: "1px solid oklch(0.78 0.18 205 / 0.4)",
            background: "oklch(0.78 0.18 205 / 0.1)",
            color: "oklch(0.78 0.18 205)",
            fontFamily: "var(--font-body)",
            fontSize: "0.75rem",
            fontWeight: 600,
            cursor: "pointer",
            transition: "background 0.15s ease",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = "oklch(0.78 0.18 205 / 0.2)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "oklch(0.78 0.18 205 / 0.1)";
          }}
        >
          + New Tool
        </button>
      </div>

      {/* Built-in tools */}
      {builtInTools.length > 0 && (
        <div>
          <div
            style={{
              fontFamily: "var(--font-body)",
              fontSize: "0.6875rem",
              fontWeight: 600,
              color: "oklch(0.50 0.04 220)",
              textTransform: "uppercase",
              letterSpacing: "0.06em",
              marginBottom: 8,
            }}
          >
            Built-In
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
              gap: 8,
            }}
          >
            {builtInTools.map((tool) => (
              <ToolCard
                key={tool.name}
                name={tool.name}
                description={tool.description}
                paramCount={tool.paramCount}
                isCustom={false}
              />
            ))}
          </div>
        </div>
      )}

      {/* Custom tools */}
      <div>
        <div
          style={{
            fontFamily: "var(--font-body)",
            fontSize: "0.6875rem",
            fontWeight: 600,
            color: "oklch(0.50 0.04 220)",
            textTransform: "uppercase",
            letterSpacing: "0.06em",
            marginBottom: 8,
          }}
        >
          Custom
        </div>
        {customTools.length === 0 ? (
          <div
            style={{
              padding: "24px 16px",
              textAlign: "center",
              fontFamily: "var(--font-body)",
              fontSize: "0.8125rem",
              color: "oklch(0.45 0.04 220)",
              border: "1px dashed oklch(0.22 0.04 220)",
              borderRadius: 12,
            }}
          >
            No Custom Tools Yet. Click &quot;New Tool&quot; To Create One.
          </div>
        ) : (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
              gap: 8,
            }}
          >
            {customTools.map((tool) => (
              <ToolCard
                key={tool.id}
                name={tool.name}
                description={tool.description}
                paramCount={tool.params.length}
                isCustom
                onEdit={() => onEdit(tool)}
                onDelete={() => onDelete(tool.id)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ToolCard({
  name,
  description,
  paramCount,
  isCustom,
  onEdit,
  onDelete,
}: {
  readonly name: string;
  readonly description: string;
  readonly paramCount: number;
  readonly isCustom: boolean;
  readonly onEdit?: () => void;
  readonly onDelete?: () => void;
}): React.ReactElement {
  return (
    <div
      style={{
        padding: 14,
        borderRadius: 10,
        border: "1px solid oklch(0.22 0.04 220)",
        background: "oklch(0.10 0.03 220 / 0.5)",
        backdropFilter: "blur(12px) saturate(1.5)",
        display: "flex",
        flexDirection: "column",
        gap: 6,
        transition: "border-color 0.15s ease",
      }}
    >
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "0.8125rem",
            fontWeight: 600,
            color: "oklch(0.78 0.18 205)",
          }}
        >
          {name}
        </span>
        <Pill tone="neutral" size="sm">
          {pluralize("Param", paramCount)}
        </Pill>
      </div>

      {/* Description */}
      <p
        style={{
          fontFamily: "var(--font-body)",
          fontSize: "0.75rem",
          color: "oklch(0.55 0.04 220)",
          lineHeight: 1.5,
          margin: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          display: "-webkit-box",
          WebkitLineClamp: 2,
          WebkitBoxOrient: "vertical",
        }}
      >
        {description}
      </p>

      {/* Custom tool actions */}
      {isCustom && (
        <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
          <Pill interactive tone="neutral" size="sm" onClick={onEdit}>
            Edit
          </Pill>
          <Pill interactive tone="danger" size="sm" onClick={onDelete}>
            Delete
          </Pill>
        </div>
      )}
    </div>
  );
}
