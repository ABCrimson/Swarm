import { useState } from "react";
import type { CustomToolDef } from "#components/tools/ToolBuilder";
import { ToolBuilder } from "#components/tools/ToolBuilder";
import { ToolList } from "#components/tools/ToolList";

/**
 * Tools page for managing built-in and custom tool definitions.
 *
 * Provides a list view of all tools and a builder form for creating
 * or editing custom tools with live Anthropic JSON preview.
 */
export function Tools(): React.ReactElement {
  const [customTools, setCustomTools] = useState<CustomToolDef[]>([]);
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

  const handleDelete = (id: string) => {
    setCustomTools((prev) => prev.filter((t) => t.id !== id));
  };

  const handleSave = (tool: CustomToolDef) => {
    setCustomTools((prev) => {
      const existing = prev.findIndex((t) => t.id === tool.id);
      if (existing >= 0) {
        const next = [...prev];
        next[existing] = tool;
        return next;
      }
      return [...prev, tool];
    });
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
            onDelete={handleDelete}
            onCreateNew={handleCreateNew}
          />
        )}
      </div>
    </div>
  );
}
