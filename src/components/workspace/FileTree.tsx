import { useResizeObserver } from "@crimson_dev/use-resize-observer";
import type { DirEntry } from "@tauri-apps/plugin-fs";
import { readDir } from "@tauri-apps/plugin-fs";
import { useEffect, useState } from "react";

const ROW_HEIGHT = 28;
const OVERSCAN = 10;

/** Props for the recursive file tree component. */
interface FileTreeProps {
  /** Absolute path to the root directory. */
  readonly rootPath: string;
  /** Callback when a file is selected. */
  readonly onSelectFile: (path: string) => void;
  /** Currently selected file path. */
  readonly selectedPath?: string;
}

/** Internal tree node representing a file or directory. */
interface TreeNode {
  readonly name: string;
  readonly path: string;
  readonly isDir: boolean;
  children?: TreeNode[];
  expanded?: boolean;
}

/** Returns an icon character based on file extension. */
function fileIcon(name: string, isDir: boolean): string {
  if (isDir) return "\u{1F4C1}";
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  const icons: Record<string, string> = {
    ts: "\u{1F535}",
    tsx: "\u{1F535}",
    js: "\u{1F7E1}",
    jsx: "\u{1F7E1}",
    json: "\u{1F7E2}",
    md: "\u{1F4DD}",
    css: "\u{1F7E3}",
    html: "\u{1F7E0}",
    rs: "\u{1F9E1}",
    toml: "\u{26D3}\uFE0F",
  };
  return icons[ext] ?? "\u{1F4C4}";
}

/** Sorts entries: directories first, then alphabetically. */
function sortEntries(entries: DirEntry[]): DirEntry[] {
  return [...entries].sort((a, b) => {
    if (a.isDirectory && !b.isDirectory) return -1;
    if (!a.isDirectory && b.isDirectory) return 1;
    return a.name.localeCompare(b.name);
  });
}

interface FlatNode {
  readonly node: TreeNode;
  readonly depth: number;
}

function flattenTree(nodes: TreeNode[], depth = 0): FlatNode[] {
  const result: FlatNode[] = [];
  for (const node of nodes) {
    result.push({ node, depth });
    if (node.isDir && node.expanded && node.children) {
      result.push(...flattenTree(node.children, depth + 1));
    }
  }
  return result;
}

function TreeItem({
  node,
  depth,
  selectedPath,
  onSelect,
  onToggle,
}: {
  readonly node: TreeNode;
  readonly depth: number;
  readonly selectedPath?: string;
  readonly onSelect: (path: string) => void;
  readonly onToggle: (path: string) => void;
}): React.ReactElement {
  const isSelected = node.path === selectedPath;
  const paddingLeft = 12 + depth * 16;

  return (
    <button
      type="button"
      onClick={() => {
        if (node.isDir) {
          void onToggle(node.path);
        } else {
          onSelect(node.path);
        }
      }}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        width: "100%",
        padding: `4px 8px 4px ${paddingLeft}px`,
        background: isSelected ? "oklch(0.18 0.04 205 / 0.4)" : "oklch(0 0 0 / 0)",
        border: "none",
        borderRadius: 4,
        color: isSelected ? "oklch(0.92 0.02 220)" : "oklch(0.72 0.04 220)",
        fontFamily: "var(--font-body)",
        fontSize: "0.8125rem",
        textAlign: "left",
        cursor: "pointer",
        transition: "background 0.1s ease",
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
      }}
      onMouseEnter={(e) => {
        if (!isSelected) e.currentTarget.style.background = "oklch(0.14 0.03 220 / 0.5)";
      }}
      onMouseLeave={(e) => {
        if (!isSelected) e.currentTarget.style.background = "oklch(0 0 0 / 0)";
      }}
    >
      {node.isDir && (
        <span
          aria-hidden="true"
          style={{
            display: "inline-block",
            width: 12,
            fontSize: "0.625rem",
            color: "oklch(0.55 0.04 220)",
            transform: node.expanded ? "rotate(90deg)" : "rotate(0deg)",
            transition: "transform 0.15s ease",
          }}
        >
          {"\u25B6"}
        </span>
      )}
      {!node.isDir && <span style={{ width: 12 }} />}
      <span style={{ fontSize: "0.75rem" }}>{fileIcon(node.name, node.isDir)}</span>
      <span>{node.name}</span>
    </button>
  );
}

/**
 * Recursive file tree component for browsing project directories.
 *
 * Uses Tauri `readDir()` for directory listing. Supports expand/collapse,
 * file icons by extension, and click-to-open. OKLCH glass-panel styling.
 */
export function FileTree({
  rootPath,
  onSelectFile,
  selectedPath,
}: FileTreeProps): React.ReactElement {
  const [nodes, setNodes] = useState<TreeNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [scrollTop, setScrollTop] = useState(0);

  const { ref: containerRef, height: containerHeight = 0 } = useResizeObserver<HTMLDivElement>();

  // Load root directory entries
  useEffect(() => {
    const controller = new AbortController();

    async function loadRoot(): Promise<void> {
      setLoading(true);
      try {
        const entries = await readDir(rootPath);
        if (controller.signal.aborted) return;
        const sorted = sortEntries(entries);
        const treeNodes: TreeNode[] = sorted.map((entry) => ({
          name: entry.name,
          path: `${rootPath}/${entry.name}`,
          isDir: entry.isDirectory ?? false,
          expanded: false,
          children: undefined,
        }));
        setNodes(treeNodes);
      } catch {
        if (!controller.signal.aborted) setNodes([]);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }

    void loadRoot();
    return () => controller.abort();
  }, [rootPath]);

  // Toggle directory expansion
  const handleToggle = async (dirPath: string) => {
    setNodes((prev) => toggleNode(prev, dirPath));

    // Load children if not yet loaded
    const node = findNode(nodes, dirPath);
    if (node?.isDir && !node.children) {
      try {
        const entries = await readDir(dirPath);
        const sorted = sortEntries(entries);
        const children: TreeNode[] = sorted.map((entry) => ({
          name: entry.name,
          path: `${dirPath}/${entry.name}`,
          isDir: entry.isDirectory ?? false,
          expanded: false,
          children: undefined,
        }));
        setNodes((prev) => setNodeChildren(prev, dirPath, children));
      } catch {
        // Silently handle unreadable directories
      }
    }
  };

  if (loading) {
    return (
      <div
        style={{
          padding: 16,
          fontFamily: "var(--font-body)",
          fontSize: "0.8125rem",
          color: "oklch(0.55 0.04 220)",
        }}
      >
        Loading...
      </div>
    );
  }

  const flatNodes = flattenTree(nodes);
  const totalHeight = flatNodes.length * ROW_HEIGHT;
  const startIndex = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const endIndex = Math.min(
    flatNodes.length,
    Math.ceil((scrollTop + containerHeight) / ROW_HEIGHT) + OVERSCAN,
  );
  const visibleNodes = flatNodes.slice(startIndex, endIndex);

  return (
    <div
      ref={containerRef}
      style={{
        height: "100%",
        overflowY: "auto",
        padding: "8px 4px",
      }}
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
    >
      <div style={{ height: totalHeight, position: "relative" }}>
        {visibleNodes.map((flat, i) => (
          <div
            key={flat.node.path}
            style={{
              position: "absolute",
              top: (startIndex + i) * ROW_HEIGHT,
              height: ROW_HEIGHT,
              width: "100%",
            }}
          >
            <TreeItem
              node={flat.node}
              depth={flat.depth}
              selectedPath={selectedPath}
              onSelect={onSelectFile}
              onToggle={handleToggle}
            />
          </div>
        ))}
      </div>
      {nodes.length === 0 && (
        <div
          style={{
            padding: 16,
            fontFamily: "var(--font-body)",
            fontSize: "0.8125rem",
            color: "oklch(0.45 0.04 220)",
          }}
        >
          Empty Directory
        </div>
      )}
    </div>
  );
}

// ── Tree manipulation helpers ──────────────────────────

function findNode(nodes: TreeNode[], path: string): TreeNode | undefined {
  for (const node of nodes) {
    if (node.path === path) return node;
    if (node.children) {
      const found = findNode(node.children, path);
      if (found) return found;
    }
  }
  return undefined;
}

function toggleNode(nodes: TreeNode[], path: string): TreeNode[] {
  return nodes.map((node) => {
    if (node.path === path) {
      return { ...node, expanded: !node.expanded };
    }
    if (node.children) {
      return { ...node, children: toggleNode(node.children, path) };
    }
    return node;
  });
}

function setNodeChildren(nodes: TreeNode[], path: string, children: TreeNode[]): TreeNode[] {
  return nodes.map((node) => {
    if (node.path === path) {
      return { ...node, children, expanded: true };
    }
    if (node.children) {
      return { ...node, children: setNodeChildren(node.children, path, children) };
    }
    return node;
  });
}
