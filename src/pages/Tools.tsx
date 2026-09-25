import { useState } from "react";
import { toast } from "sonner";
import { ToolBuilder } from "#components/tools/ToolBuilder";
import { ToolList } from "#components/tools/ToolList";
import type { CustomToolDef } from "#lib/custom-tools";
import { toolRegistry } from "#lib/tools";
import { useCustomToolsStore } from "#store/custom-tools";

/** What the page shows: the list, or the builder for a new (`tool` absent) or existing tool. */
type View = { readonly mode: "list" } | { readonly mode: "build"; readonly tool?: CustomToolDef };

/**
 * Tools page for managing built-in and custom tool definitions: a list
 * of every tool, and a builder form with a live Anthropic JSON preview.
 * Custom tools persist via the settings store and are offered to Claude
 * with every AI chat request (see `#store/custom-tools`, `#lib/tools`).
 * Deleting a custom tool is undoable from its toast.
 */
export function Tools(): React.ReactElement {
  const customTools = useCustomToolsStore((s) => s.customTools);
  const saveTool = useCustomToolsStore((s) => s.saveTool);
  const deleteTool = useCustomToolsStore((s) => s.deleteTool);
  const [view, setView] = useState<View>({ mode: "list" });

  const handleDelete = (tool: CustomToolDef) => {
    deleteTool(tool.id);
    toast.success(`Deleted ${tool.name}`, {
      action: { label: "Undo", onClick: () => saveTool(tool) },
    });
  };

  const takenNamesFor = (editing: CustomToolDef | undefined): ReadonlySet<string> =>
    new Set([
      ...toolRegistry.keys(),
      ...customTools.filter((tool) => tool.id !== editing?.id).map((tool) => tool.name),
    ]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      <div style={{ padding: "20px 28px 12px" }}>
        <h1
          style={{
            fontFamily: "var(--font-display)",
            fontSize: 24,
            fontWeight: 700,
            letterSpacing: "-0.01em",
            color: "oklch(0.95 0.02 220)",
            marginBottom: 4,
          }}
        >
          Tools
        </h1>
        <p style={{ fontFamily: "var(--font-body)", fontSize: 13, color: "oklch(0.55 0.04 220)" }}>
          Manage Built-In And Custom Tool Definitions
        </p>
      </div>

      <div style={{ flex: 1, margin: "0 16px 16px", overflow: "hidden" }}>
        {view.mode === "build" ? (
          <ToolBuilder
            key={view.tool?.id ?? "new"}
            initialTool={view.tool}
            takenNames={takenNamesFor(view.tool)}
            onSave={(tool) => {
              saveTool(tool);
              setView({ mode: "list" });
            }}
            onCancel={() => setView({ mode: "list" })}
          />
        ) : (
          <ToolList
            customTools={customTools}
            onEdit={(tool) => setView({ mode: "build", tool })}
            onDelete={handleDelete}
            onCreateNew={() => setView({ mode: "build" })}
          />
        )}
      </div>
    </div>
  );
}
