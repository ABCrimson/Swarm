import { open, save } from "@tauri-apps/plugin-dialog";
import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { useReactFlow } from "@xyflow/react";
import { useAtomValue } from "jotai";
import { useEffect, useEffectEvent } from "react";
import { toast } from "#components/ui/Toast";
import { isTauri } from "#lib/tauri";
import type { WorkflowDefinition } from "#lib/workflow";
import { parseWorkflow } from "#lib/workflow";
import { causalityInspectorAtom, reducedMotionAtom } from "#store/ui";

interface GraphControlsProps {
  readonly onResetLayout: () => void;
  /** Present while a manual edge is selected. */
  readonly onDeleteEdge?: () => void;
  /** Snapshot of the graph to write out (layout + manual annotations). */
  readonly getWorkflow: () => WorkflowDefinition;
  /** Applies a validated workflow; returns a Title Case summary for the toast. */
  readonly onImport: (workflow: WorkflowDefinition) => string;
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

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
    <button type="button" className="graph-control" onClick={onClick} aria-label={label}>
      {children}
    </button>
  );
}

/** True when a key event comes from a text field (shortcuts must not steal typing). */
function isTypingTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
  );
}

/**
 * Floating toolbar for the Workers topology graph: zoom, fit view, reset
 * layout, delete the selected annotation edge, and export/import of the
 * layout and annotations as a workflow file.
 *
 * Keyboard shortcuts: `+`/`=` zoom in, `-` zoom out, `0` fit view, active
 * only while focus is inside the graph, never with Ctrl/Cmd/Alt (browser
 * zoom), and ignored while typing or while the causality inspector is open.
 * Export/Import use the Tauri dialog and fs plugins, so they only appear in the desktop
 * app (not under the remote `swarmd` web transport).
 */
export function GraphControls({
  onResetLayout,
  onDeleteEdge,
  getWorkflow,
  onImport,
}: GraphControlsProps): React.ReactElement {
  const { zoomIn, zoomOut, fitView } = useReactFlow();
  const causalityOpen = useAtomValue(causalityInspectorAtom) !== null;
  const reducedMotion = useAtomValue(reducedMotionAtom);
  const filesAvailable = isTauri();

  const handleZoomIn = (): void => void zoomIn({ duration: reducedMotion ? 0 : 200 });
  const handleZoomOut = (): void => void zoomOut({ duration: reducedMotion ? 0 : 200 });
  const handleFitView = (): void =>
    void fitView({ duration: reducedMotion ? 0 : 300, padding: 0.2 });

  const handleExport = async (): Promise<void> => {
    try {
      const filePath = await save({
        title: "Export Workflow",
        defaultPath: `workflow-${Date.now()}.json`,
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (!filePath) return;
      await writeTextFile(filePath, JSON.stringify(getWorkflow(), null, 2));
      toast.success("Workflow Exported", { description: filePath });
    } catch (err) {
      toast.error("Export Failed", { description: errorText(err) });
    }
  };

  const handleImport = async (): Promise<void> => {
    try {
      const filePath = await open({
        title: "Import Workflow",
        multiple: false,
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (!filePath) return;
      const workflow = parseWorkflow(await readTextFile(filePath));
      toast.success("Workflow Imported", { description: onImport(workflow) });
    } catch (err) {
      toast.error("Import Failed", { description: errorText(err) });
    }
  };

  // Registered once; the Effect Event always sees the latest inspector
  // state and viewport actions. The listener is document-level, so it is
  // gated on focus inside `.react-flow` and on the causality inspector
  // (whose own keys must not zoom the canvas behind it).
  const onShortcut = useEffectEvent((e: KeyboardEvent): void => {
    if (causalityOpen || isTypingTarget(e.target)) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (!(e.target instanceof Element) || !e.target.closest(".react-flow")) return;
    if (e.key === "+" || e.key === "=") {
      e.preventDefault();
      handleZoomIn();
    } else if (e.key === "-") {
      e.preventDefault();
      handleZoomOut();
    } else if (e.key === "0") {
      e.preventDefault();
      handleFitView();
    }
  });

  useEffect(() => {
    const listener = (e: KeyboardEvent): void => onShortcut(e);
    document.addEventListener("keydown", listener);
    return () => document.removeEventListener("keydown", listener);
  }, []);

  return (
    <div
      role="toolbar"
      aria-label="Graph Controls"
      aria-orientation="vertical"
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

      {filesAvailable && (
        <>
          <ControlButton onClick={() => void handleExport()} label="Export Workflow">
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

          <ControlButton onClick={() => void handleImport()} label="Import Workflow">
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
        </>
      )}
    </div>
  );
}
