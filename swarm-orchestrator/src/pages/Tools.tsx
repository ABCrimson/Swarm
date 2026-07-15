import { useState } from "react";
import type { CustomToolDef } from "#components/tools/ToolBuilder";
import { ToolBuilder } from "#components/tools/ToolBuilder";
import { ToolList } from "#components/tools/ToolList";
import { useCustomToolsStore } from "#store/custom-tools";

/**
 * Tools page for managing built-in and custom tool definitions.
 *
 * Provides a list view of all tools and a builder form for creating
 * or editing custom tools with live Anthropic JSON preview. Custom
 * tools persist via the settings store and are sent to Claude with
 * every AI chat request (see #store/custom-tools, #lib/tools).
 */
export function Tools(): React.ReactElement {
  const customTools = useCustomToolsStore((s) => s.customTools);
  const saveTool = useCustomToolsStore((s) => s.saveTool);
  const deleteTool = useCustomToolsStore((s) => s.deleteTool);
  const [editingTool, setEditingTool] = useState<CustomToolDef | undefined>(undefined);
  const [isBuilding, setIsBuilding] = useState(false);

  const handleCreateNew = () => {
    setEditingTool(undefined);
    setIsBuilding(true);
  };

  const handleEdit = (tool: CustomToolDef) => {
    setEditingTool(tool);
    setIsBuilding(true);
  };

  const handleSave = (tool: CustomToolDef) => {
    saveTool(tool);
    setIsBuilding(false);
    setEditingTool(undefined);
  };

  const handleCancel = () => {
    setIsBuilding(false);
    setEditingTool(undefined);
  };

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        overflow: "hidden",
      }}
    >
      {/* Page header */}
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
        <p
          style={{
            fontFamily: "var(--font-body)",
            fontSize: 13,
            color: "oklch(0.55 0.04 220)",
          }}
        >
          Manage Built-In And Custom Tool Definitions
        </p>
      </div>

      {/* Content */}
      <div
        style={{
          flex: 1,
          margin: "0 16px 16px",
          overflow: "hidden",
        }}
      >
        {isBuilding ? (
          <ToolBuilder initialTool={editingTool} onSave={handleSave} onCancel={handleCancel} />
        ) : (
          <ToolList
            customTools={customTools}
            onEdit={handleEdit}
            onDelete={deleteTool}
            onCreateNew={handleCreateNew}
          />
        )}
      </div>
    </div>
  );
}
