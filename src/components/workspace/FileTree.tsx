import { useResizeObserver } from "@crimson_dev/use-resize-observer";
import { type DirEntry, readDir } from "@tauri-apps/plugin-fs";
import { use, useId, useRef, useState } from "react";
import { Reveal } from "#components/ui/Reveal";
import { escapeForDisplay } from "#lib/display-escape";
import { childPath } from "#lib/file-preview";
import { errorMessage } from "#lib/is-error";

/** Row height in CSS pixels; rows are absolutely positioned at index × this. */
export const ROW_HEIGHT = 28;
/** Extra rows rendered above and below the visible window. */
const OVERSCAN = 10;

interface FileTreeProps {
  /** Absolute path to the root directory. */
  readonly rootPath: string;
  /** Called when a file is opened. */
  readonly onSelectFile: (path: string) => void;
  /** Currently open file path. */
  readonly selectedPath?: string;
}

/**
 * A file-system entry. `kind: "link"` is a symlink whose target type is
 * not known until it is opened: `readDir` reports `isSymlink` without
 * following the link, so the target is probed by trying to list it.
 */
interface TreeNode {
  readonly name: string;
  readonly path: string;
  readonly kind: "dir" | "file" | "link";
  readonly expanded: boolean;
  /** Loaded children; `undefined` until the directory was listed. */
  readonly children?: readonly TreeNode[];
  /** Why listing this directory failed, if it did. */
  readonly error?: string;
}

interface FlatRow {
  readonly node: TreeNode;
  readonly depth: number;
  readonly parentPath: string | null;
  readonly setSize: number;
  readonly posInSet: number;
}

/** Emoji icon for an entry (decorative: hidden from assistive technology). */
function fileIcon(node: TreeNode): string {
  if (node.kind === "dir") return "\u{1F4C1}";
  if (node.kind === "link") return "\u{1F517}";
  const ext = node.name.split(".").pop()?.toLowerCase() ?? "";
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
    toml: "\u{1F527}",
  };
  return icons[ext] ?? "\u{1F4C4}";
}

/** Directory entries as nodes: directories first, then by name. */
function toNodes(dirPath: string, entries: readonly DirEntry[]): TreeNode[] {
  return entries
    .map(
      (entry): TreeNode => ({
        name: entry.name,
        path: childPath(dirPath, entry.name),
        kind: entry.isDirectory ? "dir" : entry.isSymlink ? "link" : "file",
        expanded: false,
      }),
    )
    .toSorted((a, b) => {
      if ((a.kind === "dir") !== (b.kind === "dir")) return a.kind === "dir" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
}

function flatten(
  nodes: readonly TreeNode[],
  depth = 0,
  parentPath: string | null = null,
  out: FlatRow[] = [],
): FlatRow[] {
  for (const [i, node] of nodes.entries()) {
    out.push({ node, depth, parentPath, setSize: nodes.length, posInSet: i + 1 });
    if (node.expanded && node.children) flatten(node.children, depth + 1, node.path, out);
  }
  return out;
}

/** Returns `nodes` with the node at `path` replaced by `update(node)`. */
function updateNode(
  nodes: readonly TreeNode[],
  path: string,
  update: (node: TreeNode) => TreeNode,
): readonly TreeNode[] {
  return nodes.map((node) => {
    if (node.path === path) return update(node);
    if (node.children && path.startsWith(node.path)) {
      return { ...node, children: updateNode(node.children, path, update) };
    }
    return node;
  });
}

/** A root listing as it settles: it never rejects, so a failure renders in place of the tree. */
type RootListing =
  | { readonly status: "ready"; readonly nodes: readonly TreeNode[] }
  | { readonly status: "error"; readonly message: string };

/**
 * Root listings in flight, keyed by root path. Each mount pins the promise
 * it was handed (see {@link FileTree}); a settled listing leaves the cache,
 * so the next mount (a new root, or the panel mounting again) lists
 * afresh, while reads of one root that overlap — Strict Mode's double
 * mount — share a single `readDir`.
 */
const rootListings = new Map<string, Promise<RootListing>>();

function listRoot(rootPath: string): Promise<RootListing> {
  const cached = rootListings.get(rootPath);
  if (cached !== undefined) return cached;
  const listing = readDir(rootPath).then(
    (entries): RootListing => ({ status: "ready", nodes: toNodes(rootPath, entries) }),
    (err: unknown): RootListing => ({ status: "error", message: errorMessage(err) }),
  );
  rootListings.set(rootPath, listing);
  void listing.then(() => {
    if (rootListings.get(rootPath) === listing) rootListings.delete(rootPath);
  });
  return listing;
}

/** The scroll box the tree draws into, owned by {@link FileTree} so it is measured before any rows exist. */
interface Viewport {
  readonly containerRef: React.RefObject<HTMLDivElement | null>;
  readonly height: number;
  readonly firstRow: number;
  readonly setFirstRow: (row: number) => void;
}

/**
 * Virtualized file tree for browsing a project directory, following the
 * WAI-ARIA tree pattern: the tree is one Tab stop and tracks the active
 * row with `aria-activedescendant`; Up/Down move, Right expands (or
 * steps into) a folder, Left collapses (or steps out), Home/End jump,
 * Enter/Space opens. Rows carry level, set size, position, expanded and
 * selected state.
 *
 * Only the rows in view (plus {@link OVERSCAN}) are in the DOM. The
 * scroll container renders from the first commit — also while the root
 * is loading — so its height is measured before any rows are laid out.
 * The root listing is read with `use()` under a {@link Reveal} boundary
 * inside that container; directory listings below it load lazily on first
 * expand. A failed listing is shown under its folder (or instead of the
 * tree for the root), never swallowed. Key it by `rootPath` so a new root
 * starts fresh.
 */
export function FileTree({
  rootPath,
  onSelectFile,
  selectedPath,
}: FileTreeProps): React.ReactElement {
  // Pinned for this mount; the parent's `rootPath` key mounts a new root afresh.
  const [listing] = useState(() => listRoot(rootPath));
  const [firstRow, setFirstRow] = useState(0);
  const { ref: containerRef, height = 0 } = useResizeObserver<HTMLDivElement>();

  return (
    <div
      ref={containerRef}
      className="scroll-area h-full overflow-y-auto px-1 py-2"
      onScroll={(e) => setFirstRow(Math.floor(e.currentTarget.scrollTop / ROW_HEIGHT))}
    >
      <Reveal
        fallback={
          <p role="status" className="p-4 text-fg-muted text-md">
            Loading…
          </p>
        }
      >
        <ListedTree
          listing={listing}
          viewport={{ containerRef, height, firstRow, setFirstRow }}
          onSelectFile={onSelectFile}
          selectedPath={selectedPath}
        />
      </Reveal>
    </div>
  );
}

interface TreeProps {
  readonly viewport: Viewport;
  readonly onSelectFile: (path: string) => void;
  readonly selectedPath: string | undefined;
}

/** Suspends on the root listing; a failure takes the tree's place. */
function ListedTree({
  listing,
  ...props
}: TreeProps & { readonly listing: Promise<RootListing> }): React.ReactElement {
  const root = use(listing);
  if (root.status === "error") {
    return (
      <p role="alert" className="p-4 text-md text-rose">
        Could Not Read This Folder: {root.message}
      </p>
    );
  }
  return <Tree rootNodes={root.nodes} {...props} />;
}

function Tree({
  rootNodes,
  viewport,
  onSelectFile,
  selectedPath,
}: TreeProps & { readonly rootNodes: readonly TreeNode[] }): React.ReactElement {
  const [nodes, setNodes] = useState(rootNodes);
  const [activePath, setActivePath] = useState<string | null>(null);
  /** Directories with a listing in flight, so a double click never lists twice. */
  const inFlightRef = useRef(new Set<string>());
  const idPrefix = useId();
  const { containerRef, height: viewportHeight, firstRow, setFirstRow } = viewport;

  const rows = flatten(nodes);
  const activeIndex = Math.max(
    0,
    rows.findIndex((row) => row.node.path === activePath),
  );

  const patch = (path: string, update: (node: TreeNode) => TreeNode): void =>
    setNodes((prev) => updateNode(prev, path, update));

  /** Lists a directory once; the result keeps whatever expanded state the user has set since. */
  const loadChildren = (path: string): void => {
    if (inFlightRef.current.has(path)) return;
    inFlightRef.current.add(path);
    readDir(path)
      .then(
        (entries) =>
          patch(path, (node) => ({
            ...node,
            kind: "dir",
            children: toNodes(path, entries),
            error: undefined,
          })),
        (err: unknown) => patch(path, (node) => ({ ...node, error: errorMessage(err) })),
      )
      .finally(() => inFlightRef.current.delete(path));
  };

  const setExpanded = (node: TreeNode, expanded: boolean): void => {
    patch(node.path, (n) => ({ ...n, expanded }));
    if (expanded && !node.children) loadChildren(node.path);
  };

  /** Opens a file; a symlink is probed by listing it, and opened as a file if that fails. */
  const open = (node: TreeNode): void => {
    if (node.kind === "dir") {
      setExpanded(node, !node.expanded);
      return;
    }
    if (node.kind === "file") {
      onSelectFile(node.path);
      return;
    }
    readDir(node.path).then(
      (entries) =>
        patch(node.path, (n) => ({
          ...n,
          kind: "dir",
          expanded: true,
          children: toNodes(node.path, entries),
        })),
      () => {
        patch(node.path, (n) => ({ ...n, kind: "file" }));
        onSelectFile(node.path);
      },
    );
  };

  /** Makes `index` the active row and scrolls it into the rendered window. */
  const activate = (index: number): void => {
    const row = rows[index];
    const container = containerRef.current;
    if (!row || !container) return;
    setActivePath(row.node.path);
    const top = index * ROW_HEIGHT;
    if (top < container.scrollTop) container.scrollTop = top;
    else if (top + ROW_HEIGHT > container.scrollTop + container.clientHeight) {
      container.scrollTop = top + ROW_HEIGHT - container.clientHeight;
    }
    setFirstRow(Math.floor(container.scrollTop / ROW_HEIGHT));
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    const row = rows[activeIndex];
    if (!row) return;
    const { node } = row;
    switch (e.key) {
      case "ArrowDown":
        activate(Math.min(rows.length - 1, activeIndex + 1));
        break;
      case "ArrowUp":
        activate(Math.max(0, activeIndex - 1));
        break;
      case "Home":
        activate(0);
        break;
      case "End":
        activate(rows.length - 1);
        break;
      case "ArrowRight":
        if (node.kind === "dir" && !node.expanded) setExpanded(node, true);
        else if (node.kind === "dir" && node.children?.length) activate(activeIndex + 1);
        break;
      case "ArrowLeft":
        if (node.kind === "dir" && node.expanded) setExpanded(node, false);
        else if (row.parentPath !== null) {
          activate(rows.findIndex((r) => r.node.path === row.parentPath));
        }
        break;
      case "Enter":
      case " ":
        open(node);
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  const startIndex = Math.max(0, firstRow - OVERSCAN);
  const endIndex = Math.min(
    rows.length,
    firstRow + Math.ceil(viewportHeight / ROW_HEIGHT) + 1 + OVERSCAN,
  );
  const rowId = (index: number): string => `${idPrefix}-row-${index}`;
  // The window, plus the active row wherever it is: aria-activedescendant
  // must always point at an element in the DOM.
  const rendered = Array.from({ length: endIndex - startIndex }, (_, i) => startIndex + i);
  if (rows.length > 0 && (activeIndex < startIndex || activeIndex >= endIndex)) {
    rendered.push(activeIndex);
  }

  if (rows.length === 0) return <p className="p-4 text-fg-dim text-md">Empty Directory</p>;

  return (
    <div
      role="tree"
      aria-label="Project Files"
      tabIndex={0}
      aria-activedescendant={rowId(activeIndex)}
      onKeyDown={handleKeyDown}
      className="group relative outline-hidden"
      style={{ height: rows.length * ROW_HEIGHT }}
    >
      {rendered.map((index) => {
        const row = rows[index];
        if (!row) return null;
        const { node, depth } = row;
        return (
          // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard is handled on the tree (aria-activedescendant pattern)
          <div
            key={node.path}
            id={rowId(index)}
            role="treeitem"
            aria-level={depth + 1}
            aria-setsize={row.setSize}
            aria-posinset={row.posInSet}
            aria-expanded={node.kind === "dir" ? node.expanded : undefined}
            aria-selected={node.path === selectedPath}
            data-active={index === activeIndex || undefined}
            // Focusable only programmatically; a click hands focus back to
            // the tree, which owns keyboard handling and the active row.
            tabIndex={-1}
            onClick={(e) => {
              e.currentTarget.closest<HTMLElement>("[role=tree]")?.focus();
              setActivePath(node.path);
              open(node);
            }}
            className="absolute inset-x-0 flex cursor-pointer items-center gap-1.5 truncate rounded pr-2 text-fg-muted text-md hover:bg-surface-2/50 aria-selected:bg-plasma/15 aria-selected:text-fg-bright group-focus-visible:data-active:outline-2 group-focus-visible:data-active:outline-plasma group-focus-visible:data-active:-outline-offset-2"
            style={{
              top: index * ROW_HEIGHT,
              height: ROW_HEIGHT,
              paddingLeft: 12 + depth * 16,
            }}
          >
            <span
              aria-hidden="true"
              className={`inline-block w-3 text-2xs text-fg-dim transition-transform duration-150 ${node.expanded ? "rotate-90" : ""}`}
            >
              {node.kind === "dir" ? "▶" : ""}
            </span>
            <span aria-hidden="true" className="text-sm">
              {fileIcon(node)}
            </span>
            <span className="truncate">{escapeForDisplay(node.name)}</span>
            {node.error && (
              <span className="truncate text-rose text-sm" title={escapeForDisplay(node.error)}>
                — Could Not Read Folder
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
