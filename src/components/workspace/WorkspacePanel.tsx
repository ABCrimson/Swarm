import { open } from "@tauri-apps/plugin-dialog";
import { Suspense, useId, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "#components/ui/Button";
import { Spinner } from "#components/ui/Spinner";
import { loadFilePreview } from "#lib/file-preview";
import { errorMessage } from "#lib/is-error";
import { DESKTOP_ONLY_REASON, hasCapability } from "#lib/tauri";
import { FileTree } from "./FileTree.tsx";
import { type FileSelection, FileViewer } from "./FileViewer.tsx";

/** Default width of the file-tree sidebar, in CSS pixels. */
const DEFAULT_SIDEBAR_WIDTH = 260;
const MIN_SIDEBAR_WIDTH = 180;
const MAX_SIDEBAR_WIDTH = 480;
/** Pixels one Arrow key press moves the resize handle. */
const KEYBOARD_RESIZE_STEP = 16;

const clampWidth = (px: number): number =>
  Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, px));

/**
 * Workspace panel: a resizable file-tree sidebar and a read-only file
 * viewer for a user-chosen project directory.
 *
 * The directory is opened with `recursive: true`, which grants the
 * app's fs scope the whole subtree, so folders outside `$HOME` (e.g.
 * `D:\code`) can be expanded and their files read. The chosen folder
 * survives page switches because the page host keeps visited pages
 * mounted.
 *
 * The folder picker and the file reads are native (plugin-dialog and
 * plugin-fs), so a transport without workspace browsing (the
 * `pnpm build:web` page) gets a disabled Open Project button that says why.
 *
 * Opening a file starts its read in a transition: the current file stays
 * on screen (dimmed) until the next one is ready.
 */
export function WorkspacePanel(): React.ReactElement {
  const [rootPath, setRootPath] = useState<string | null>(null);
  const [selection, setSelection] = useState<FileSelection | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SIDEBAR_WIDTH);
  const [loadingFile, startFileTransition] = useTransition();
  /** Pointer x and sidebar width when a drag started; `null` when not dragging. */
  const dragStartRef = useRef<{ readonly x: number; readonly width: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const treePaneId = useId();
  const reasonId = useId();
  const canBrowse = hasCapability("workspaceBrowsing");

  const handleOpenProject = async (): Promise<void> => {
    let selected: string | null;
    try {
      selected = await open({
        title: "Open Project Directory",
        directory: true,
        multiple: false,
        recursive: true,
      });
    } catch (err) {
      toast.error(`Could Not Open The Folder Picker: ${errorMessage(err)}`);
      return;
    }
    if (selected) {
      setRootPath(selected);
      setSelection(null);
    }
  };

  const handleSelectFile = (path: string): void => {
    startFileTransition(() => setSelection({ path, preview: loadFilePreview(path) }));
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLHRElement>): void => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragStartRef.current = { x: e.clientX, width: sidebarWidth };
    setDragging(true);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLHRElement>): void => {
    const start = dragStartRef.current;
    if (start) setSidebarWidth(clampWidth(start.width + e.clientX - start.x));
  };

  // After pointerup (implicit release) and on pointercancel alike.
  const handleLostPointerCapture = (): void => {
    dragStartRef.current = null;
    setDragging(false);
  };

  const handleSeparatorKeyDown = (e: React.KeyboardEvent<HTMLHRElement>): void => {
    const targets: Partial<Record<string, number>> = {
      ArrowLeft: sidebarWidth - KEYBOARD_RESIZE_STEP,
      ArrowRight: sidebarWidth + KEYBOARD_RESIZE_STEP,
      Home: MIN_SIDEBAR_WIDTH,
      End: MAX_SIDEBAR_WIDTH,
    };
    const target = targets[e.key];
    if (target === undefined) return;
    e.preventDefault();
    setSidebarWidth(clampWidth(target));
  };

  if (!rootPath) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4">
        <svg width={56} height={56} viewBox="0 0 56 56" fill="none" aria-hidden="true">
          <rect
            x={8}
            y={14}
            width={40}
            height={30}
            rx={3}
            strokeWidth={2}
            className="stroke-border-2"
          />
          <path
            d="M8 20h16l4-6h12"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            className="stroke-fg-dim"
          />
        </svg>
        <p className="text-fg-muted text-lg">No Project Directory Open</p>
        <Button
          variant="secondary"
          size="sm"
          disabled={!canBrowse}
          aria-describedby={canBrowse ? undefined : reasonId}
          onClick={() => void handleOpenProject()}
        >
          Open Project
        </Button>
        {!canBrowse && (
          <p id={reasonId} className="text-fg-dim text-sm">
            {DESKTOP_ONLY_REASON}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="flex h-full overflow-hidden">
      <div
        id={treePaneId}
        className="flex shrink-0 flex-col border-border border-r bg-surface-0/60 backdrop-blur-md"
        style={{ width: sidebarWidth }}
      >
        <div className="flex items-center justify-between border-border border-b px-3 py-2.5">
          <h2 className="font-bold font-display text-fg-muted text-sm uppercase tracking-[0.04em]">
            Explorer
          </h2>
          <button
            type="button"
            onClick={() => void handleOpenProject()}
            aria-label="Change Project Directory"
            title="Change Project Directory"
            className="flex size-6 cursor-pointer items-center justify-center rounded text-fg-muted hover:bg-surface-2 hover:text-fg"
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
        <div className="min-h-0 flex-1">
          <FileTree
            key={rootPath}
            rootPath={rootPath}
            onSelectFile={handleSelectFile}
            selectedPath={selection?.path}
          />
        </div>
      </div>

      <hr
        tabIndex={0}
        aria-orientation="vertical"
        aria-controls={treePaneId}
        aria-valuenow={sidebarWidth}
        aria-valuemin={MIN_SIDEBAR_WIDTH}
        aria-valuemax={MAX_SIDEBAR_WIDTH}
        aria-label="Resize File Tree"
        data-dragging={dragging || undefined}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onLostPointerCapture={handleLostPointerCapture}
        onKeyDown={handleSeparatorKeyDown}
        onWheel={(e) => {
          e.currentTarget.nextElementSibling
            ?.querySelector<HTMLElement>(".scroll-area")
            ?.scrollBy(e.deltaX, e.deltaY);
        }}
        className="m-0 h-auto w-1 shrink-0 relative z-10 before:absolute before:inset-y-0 before:left-0 before:-right-5 before:content-[''] cursor-col-resize touch-none select-none border-0 bg-transparent transition-colors duration-150 hover:bg-plasma/20 data-dragging:bg-plasma/40"
      />

      <div className="min-w-0 flex-1 overflow-hidden">
        {selection ? (
          <Suspense
            fallback={
              <div className="flex h-full items-center justify-center">
                <Spinner size="md" />
              </div>
            }
          >
            <FileViewer selection={selection} pending={loadingFile} />
          </Suspense>
        ) : (
          <p className="flex h-full items-center justify-center text-fg-dim text-lg">
            Select A File To View
          </p>
        )}
      </div>
    </div>
  );
}
