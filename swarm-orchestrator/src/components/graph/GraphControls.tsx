import { open, save } from "@tauri-apps/plugin-dialog";
import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import type { Edge, Node } from "@xyflow/react";
import { useReactFlow } from "@xyflow/react";
import { useEffect } from "react";
import { toast } from "#components/ui/Toast";
import type { WorkflowDefinition } from "#lib/workflow";
import { exportWorkflow, importWorkflow } from "#lib/workflow";

interface GraphControlsProps {
  readonly onResetLayout: () => void;
  readonly onAddNode?: () => void;
  readonly onDeleteEdge?: () => void;
  readonly nodes?: Node[];
  readonly edges?: Edge[];
}

function ControlButton({
  onClick,
  label,
  children,
}: {
  readonly onClick: () => void;
  readonly label: string;
  readonly children: React.ReactNode;
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      style={{
        width: 36,
        height: 36,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "oklch(0.12 0.03 220 / 0.7)",
        backdropFilter: "blur(12px) saturate(1.5)",
        border: "1px solid oklch(0.28 0.05 220)",
        borderRadius: 8,
        color: "oklch(0.82 0.04 220)",
        cursor: "pointer",
        transition: "background 0.15s ease, border-color 0.15s ease",
        fontSize: "1rem",
        lineHeight: 1,
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = "oklch(0.17 0.04 220)";
        e.currentTarget.style.borderColor = "oklch(0.35 0.06 220)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "oklch(0.12 0.03 220 / 0.7)";
        e.currentTarget.style.borderColor = "oklch(0.28 0.05 220)";
      }}
    >
      {children}
    </button>
  );
}

/**
 * Floating toolbar with zoom, fit-view, reset-layout, add-node, export/import,
 * and edge deletion controls for the visual workflow builder.
 *
 * Keyboard shortcuts: `+`/`=` zoom in, `-` zoom out, `0` fit view.
 */
export function GraphControls({
  onResetLayout,
  onAddNode,
  onDeleteEdge,
  nodes,
  edges,
}: GraphControlsProps): React.ReactElement {
  const { zoomIn, zoomOut, fitView, setNodes, setEdges } = useReactFlow();

  const handleZoomIn = () => {
    zoomIn({ duration: 200 });
  };

  const handleZoomOut = () => {
    zoomOut({ duration: 200 });
  };

  const handleFitView = () => {
    fitView({ duration: 300, padding: 0.2 });
  };

  // Export workflow to JSON file
  const handleExport = async () => {
    if (!nodes || !edges) return;

    const workflow = exportWorkflow(nodes, edges);
    const json = JSON.stringify(workflow, null, 2);

    const filePath = await save({
      title: "Export Workflow",
      defaultPath: `workflow-${Date.now()}.json`,
      filters: [{ name: "JSON", extensions: ["json"] }],
    });

    if (!filePath) return;

    try {
      await writeTextFile(filePath, json);
      toast.success("Workflow Exported", { description: filePath });
    } catch (err) {
      toast.error("Export Failed", { description: String(err) });
    }
  };

  // Import workflow from JSON file
  const handleImport = async () => {
    const filePath = await open({
      title: "Import Workflow",
      multiple: false,
      filters: [{ name: "JSON", extensions: ["json"] }],
    });

    if (!filePath) return;

    try {
      const content = await readTextFile(filePath);
      const def = JSON.parse(content) as WorkflowDefinition;
      const { nodes: importedNodes, edges: importedEdges } = importWorkflow(def);
      setNodes(importedNodes);
      setEdges(importedEdges);
      toast.success("Workflow Imported", { description: def.name });
    } catch (err) {
      toast.error("Import Failed", { description: String(err) });
    }
  };

  // Keyboard shortcuts for graph operations
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Only handle when not in an input field
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) {
        return;
      }

      if (e.key === "+" || e.key === "=") {
        e.preventDefault();
        zoomIn({ duration: 200 });
      } else if (e.key === "-") {
        e.preventDefault();
        zoomOut({ duration: 200 });
      } else if (e.key === "0") {
        e.preventDefault();
        fitView({ duration: 300, padding: 0.2 });
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [zoomIn, zoomOut, fitView]);

  return (
    <div
      role="toolbar"
      aria-label="Graph Controls"
      style={{
        position: "absolute",
        bottom: 16,
        right: 16,
        display: "flex",
        flexDirection: "column",
        gap: 4,
        zIndex: 10,
      }}
    >
      {/* Add Worker */}
      {onAddNode && (
        <ControlButton onClick={onAddNode} label="Add Worker Node">
          <svg width={16} height={16} viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <circle cx={8} cy={8} r={6} stroke="currentColor" strokeWidth={1.5} />
            <path d="M8 5v6M5 8h6" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" />
          </svg>
        </ControlButton>
      )}

      {/* Delete selected edge */}
      {onDeleteEdge && (
        <ControlButton onClick={onDeleteEdge} label="Delete Selected Edge">
          <svg width={16} height={16} viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path
              d="M4 4l8 8M12 4l-8 8"
              stroke="oklch(0.72 0.20 10)"
              strokeWidth={1.5}
              strokeLinecap="round"
            />
          </svg>
        </ControlButton>
      )}

      <ControlButton onClick={handleZoomIn} label="Zoom In (+)">
        <svg width={16} height={16} viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" />
        </svg>
      </ControlButton>

      <ControlButton onClick={handleZoomOut} label="Zoom Out (-)">
        <svg width={16} height={16} viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M3 8h10" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" />
        </svg>
      </ControlButton>

      <ControlButton onClick={handleFitView} label="Fit View (0)">
        <svg width={16} height={16} viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path
            d="M2 6V3a1 1 0 011-1h3M10 2h3a1 1 0 011 1v3M14 10v3a1 1 0 01-1 1h-3M6 14H3a1 1 0 01-1-1v-3"
            stroke="currentColor"
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </ControlButton>

      <ControlButton onClick={onResetLayout} label="Reset Layout">
        <svg width={16} height={16} viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path
            d="M2 8a6 6 0 0111.46-2.46M14 8a6 6 0 01-11.46 2.46"
            stroke="currentColor"
            strokeWidth={1.5}
            strokeLinecap="round"
          />
          <path
            d="M14 2v4h-4M2 14v-4h4"
            stroke="currentColor"
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </ControlButton>

      {/* Export */}
      {nodes && edges && (
        <ControlButton onClick={handleExport} label="Export Workflow">
          <svg width={16} height={16} viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path
              d="M8 2v8M5 7l3 3 3-3M3 12v1a1 1 0 001 1h8a1 1 0 001-1v-1"
              stroke="currentColor"
              strokeWidth={1.5}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </ControlButton>
      )}

      {/* Import */}
      <ControlButton onClick={handleImport} label="Import Workflow">
        <svg width={16} height={16} viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path
            d="M8 10V2M5 5l3-3 3 3M3 12v1a1 1 0 001 1h8a1 1 0 001-1v-1"
            stroke="currentColor"
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </ControlButton>
    </div>
  );
}
