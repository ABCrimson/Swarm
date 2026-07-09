import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useRef, useState } from "react";
import { FileTree } from "./FileTree.tsx";
import { FileViewer } from "./FileViewer.tsx";

/** Default split ratio for the file tree sidebar (percentage). */
const DEFAULT_SIDEBAR_WIDTH = 260;
const MIN_SIDEBAR_WIDTH = 180;
const MAX_SIDEBAR_WIDTH = 480;

/**
 * Workspace panel with a file tree sidebar and file viewer main area.
 *
 * Uses a draggable divider for resizable split layout.
 * The file tree reads from a user-selected project directory.
 */
export function WorkspacePanel(): React.ReactElement {
  const [rootPath, setRootPath] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SIDEBAR_WIDTH);
  const [isDragging, setIsDragging] = useState(false);
  const cleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    return () => { cleanupRef.current?.(); };
  }, []);

  // Open directory picker
  const handleOpenProject = async () => {
    const selected = await open({
      title: "Open Project Directory",
      directory: true,
      multiple: false,
    });

    if (selected) {
      setRootPath(selected);
      setSelectedFile(null);
    }
  };

  // Resize handler
  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    setIsDragging(true);

    const startX = e.clientX;
    const startWidth = sidebarWidth;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const delta = moveEvent.clientX - startX;
      const newWidth = Math.min(
        MAX_SIDEBAR_WIDTH,
        Math.max(MIN_SIDEBAR_WIDTH, startWidth + delta),
      );
      setSidebarWidth(newWidth);
    };

    const handleMouseUp = () => {
      setIsDragging(false);
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      cleanupRef.current = null;
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    cleanupRef.current = () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  };

  // No project open state
  if (!rootPath) {
    return (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          height: "100%",
          gap: 16,
        }}
      >
        <svg width={56} height={56} viewBox="0 0 56 56" fill="none">
          <title>Open project</title>
          <rect
            x={8}
            y={14}
            width={40}
            height={30}
            rx={3}
            stroke="oklch(0.28 0.05 220)"
            strokeWidth={2}
          />
          <path
            d="M8 20h16l4-6h12"
            stroke="oklch(0.55 0.04 220)"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        <span
          style={{
            fontFamily: "var(--font-body)",
            fontSize: "0.9375rem",
            color: "oklch(0.55 0.04 220)",
          }}
        >
          No project directory open
        </span>
        <button
          type="button"
          onClick={() => void handleOpenProject()}
          style={{
            padding: "8px 20px",
            background: "oklch(0.78 0.18 205 / 0.15)",
            border: "1px solid oklch(0.78 0.18 205 / 0.4)",
            borderRadius: 8,
            color: "oklch(0.78 0.18 205)",
            fontFamily: "var(--font-body)",
            fontSize: "0.8125rem",
            fontWeight: 600,
            cursor: "pointer",
            transition: "background 0.15s ease",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = "oklch(0.78 0.18 205 / 0.25)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "oklch(0.78 0.18 205 / 0.15)";
          }}
        >
          Open Project
        </button>
      </div>
    );
  }

  return (
    <div
      style={{
        display: "flex",
        height: "100%",
        overflow: "hidden",
      }}
    >
      {/* File tree sidebar */}
      <div
        style={{
          width: sidebarWidth,
          minWidth: MIN_SIDEBAR_WIDTH,
          maxWidth: MAX_SIDEBAR_WIDTH,
          display: "flex",
          flexDirection: "column",
          borderRight: "1px solid oklch(0.22 0.04 220)",
          background: "oklch(0.09 0.02 220 / 0.6)",
          backdropFilter: "blur(12px) saturate(1.5)",
        }}
      >
        {/* Sidebar header */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "10px 12px",
            borderBottom: "1px solid oklch(0.22 0.04 220)",
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
            Explorer
          </span>
          <button
            type="button"
            onClick={() => void handleOpenProject()}
            aria-label="Change project directory"
            style={{
              width: 24,
              height: 24,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: "oklch(0 0 0 / 0)",
              border: "none",
              borderRadius: 4,
              color: "oklch(0.55 0.04 220)",
              cursor: "pointer",
              fontSize: "0.75rem",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = "oklch(0.14 0.03 220)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "oklch(0 0 0 / 0)";
            }}
          >
            <svg width={14} height={14} viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path
                d="M2 8a6 6 0 0111.46-2.46M14 8a6 6 0 01-11.46 2.46"
                stroke="currentColor"
                strokeWidth={1.5}
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>

        {/* File tree */}
        <div style={{ flex: 1, overflow: "auto" }}>
          <FileTree
            rootPath={rootPath}
            onSelectFile={setSelectedFile}
            selectedPath={selectedFile ?? undefined}
          />
        </div>
      </div>

      {/* Resize handle — div is needed for interactive separator, not <hr> */}
      {/* biome-ignore lint/a11y/useSemanticElements: interactive resize handle needs div */}
      <div
        role="separator"
        tabIndex={0}
        aria-orientation="vertical"
        aria-valuenow={sidebarWidth}
        aria-valuemin={MIN_SIDEBAR_WIDTH}
        aria-valuemax={MAX_SIDEBAR_WIDTH}
        aria-label="Resize file tree"
        onMouseDown={handleMouseDown}
        style={{
          width: 4,
          cursor: "col-resize",
          background: isDragging ? "oklch(0.78 0.18 205 / 0.4)" : "oklch(0 0 0 / 0)",
          transition: isDragging ? "none" : "background 0.15s ease",
          flexShrink: 0,
        }}
        onMouseEnter={(e) => {
          if (!isDragging) e.currentTarget.style.background = "oklch(0.78 0.18 205 / 0.2)";
        }}
        onMouseLeave={(e) => {
          if (!isDragging) e.currentTarget.style.background = "oklch(0 0 0 / 0)";
        }}
      />

      {/* File viewer */}
      <div style={{ flex: 1, overflow: "hidden" }}>
        <FileViewer filePath={selectedFile} />
      </div>
    </div>
  );
}
