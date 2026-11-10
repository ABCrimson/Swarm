import { ResizeObserverContext } from "@crimson_dev/use-resize-observer";
import { type DirEntry, readDir } from "@tauri-apps/plugin-fs";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FileTree, ROW_HEIGHT } from "#components/workspace/FileTree";

vi.mock("@tauri-apps/plugin-fs", () => ({ readDir: vi.fn() }));

const VIEWPORT_HEIGHT = 600;

/** A ResizeObserver that reports every observed element as 300×600. */
class FakeResizeObserver {
  readonly #callback: ResizeObserverCallback;
  constructor(callback: ResizeObserverCallback) {
    this.#callback = callback;
  }
  observe(target: Element): void {
    const size = [{ inlineSize: 300, blockSize: VIEWPORT_HEIGHT }];
    queueMicrotask(() =>
      this.#callback(
        [
          {
            target,
            contentRect: DOMRectReadOnly.fromRect({ width: 300, height: VIEWPORT_HEIGHT }),
            contentBoxSize: size,
            borderBoxSize: size,
            devicePixelContentBoxSize: size,
          },
        ],
        this as unknown as ResizeObserver,
      ),
    );
  }
  unobserve(): void {}
  disconnect(): void {}
}

const file = (name: string): DirEntry => ({
  name,
  isFile: true,
  isDirectory: false,
  isSymlink: false,
});
const dir = (name: string): DirEntry => ({ ...file(name), isFile: false, isDirectory: true });
const link = (name: string): DirEntry => ({ ...file(name), isFile: false, isSymlink: true });

/** Renders inside an awaited act(), so the root listing `use()` suspends on can reveal. */
async function renderTree(rootPath = "C:\\proj", onSelectFile = vi.fn()) {
  await act(async () =>
    render(
      <ResizeObserverContext value={FakeResizeObserver as unknown as typeof ResizeObserver}>
        <FileTree rootPath={rootPath} onSelectFile={onSelectFile} />
      </ResizeObserverContext>,
    ),
  );
  return { onSelectFile };
}

beforeEach(() => {
  vi.mocked(readDir).mockReset();
});

describe("FileTree", () => {
  // Regression: the scroll box was only mounted after loading, so it was
  // never measured and only ~10 rows (the overscan) were ever drawn.
  it("renders every row that fits the measured viewport", async () => {
    vi.mocked(readDir).mockResolvedValue(Array.from({ length: 50 }, (_, i) => file(`f${i}.ts`)));
    await renderTree();

    const visible = Math.ceil(VIEWPORT_HEIGHT / ROW_HEIGHT);
    await waitFor(() =>
      expect(screen.getAllByRole("treeitem").length).toBeGreaterThanOrEqual(visible),
    );
    expect(screen.getAllByRole("treeitem").length).toBeLessThan(50);
  });

  it("sorts folders first and exposes tree semantics", async () => {
    vi.mocked(readDir).mockResolvedValue([file("b.ts"), dir("src"), file("a.md")]);
    await renderTree();

    const items = await screen.findAllByRole("treeitem");
    expect(items.map((i) => i.textContent)).toEqual([
      expect.stringContaining("src"),
      expect.stringContaining("a.md"),
      expect.stringContaining("b.ts"),
    ]);
    expect(items[0]).toHaveAttribute("aria-expanded", "false");
    expect(items[1]).not.toHaveAttribute("aria-expanded");
    expect(items[2]).toHaveAttribute("aria-level", "1");
    expect(items[2]).toHaveAttribute("aria-posinset", "3");
    expect(items[2]).toHaveAttribute("aria-setsize", "3");
    expect(screen.getByRole("tree", { name: "Project Files" })).toBeInTheDocument();
  });

  it("shows a root listing failure instead of an empty tree", async () => {
    vi.mocked(readDir).mockRejectedValue("forbidden path: D:\\code");
    await renderTree("D:\\code");

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could Not Read This Folder: forbidden path: D:\\code",
    );
    expect(screen.queryByText("Empty Directory")).not.toBeInTheDocument();
  });

  it("shows a loading status until the root listing answers, then the tree", async () => {
    const listing = Promise.withResolvers<DirEntry[]>();
    vi.mocked(readDir).mockReturnValue(listing.promise);
    await renderTree("C:\\pending");

    expect(screen.getByRole("status")).toHaveTextContent("Loading…");
    expect(screen.queryByRole("tree")).not.toBeInTheDocument();

    await act(async () => listing.resolve([file("a.ts")]));
    expect(screen.getByRole("treeitem")).toHaveTextContent("a.ts");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("lists the root once, even when Strict Mode mounts it twice", async () => {
    vi.mocked(readDir).mockResolvedValue([file("a.ts")]);
    await act(async () =>
      render(
        <StrictMode>
          <ResizeObserverContext value={FakeResizeObserver as unknown as typeof ResizeObserver}>
            <FileTree rootPath="C:\strict" onSelectFile={vi.fn()} />
          </ResizeObserverContext>
        </StrictMode>,
      ),
    );

    expect(await screen.findByRole("treeitem")).toHaveTextContent("a.ts");
    expect(readDir).toHaveBeenCalledTimes(1);
  });

  it("lists the new root when it is keyed by another rootPath", async () => {
    vi.mocked(readDir).mockImplementation(async (path) =>
      path === "C:\\one" ? [file("one.ts")] : [file("two.ts")],
    );
    const tree = (rootPath: string) => (
      <ResizeObserverContext value={FakeResizeObserver as unknown as typeof ResizeObserver}>
        <FileTree key={rootPath} rootPath={rootPath} onSelectFile={vi.fn()} />
      </ResizeObserverContext>
    );
    const { rerender } = await act(async () => render(tree("C:\\one")));
    expect(await screen.findByRole("treeitem")).toHaveTextContent("one.ts");

    await act(async () => rerender(tree("C:\\two")));

    await waitFor(() => expect(screen.getByRole("treeitem")).toHaveTextContent("two.ts"));
    expect(readDir).toHaveBeenLastCalledWith("C:\\two");
  });

  it("joins child paths with the root's own separator", async () => {
    vi.mocked(readDir)
      .mockResolvedValueOnce([dir("src")])
      .mockResolvedValueOnce([]);
    await renderTree("C:\\proj");

    fireEvent.click(await screen.findByRole("treeitem"));

    await waitFor(() => expect(readDir).toHaveBeenLastCalledWith("C:\\proj\\src"));
  });

  // Regression: a second click while the listing was in flight started a
  // second readDir, and its result force-expanded the folder again.
  it("lists a folder once and respects a collapse made while it loads", async () => {
    const children = Promise.withResolvers<DirEntry[]>();
    vi.mocked(readDir)
      .mockResolvedValueOnce([dir("src")])
      .mockReturnValueOnce(children.promise);
    await renderTree();

    const folder = await screen.findByRole("treeitem");
    fireEvent.click(folder);
    fireEvent.click(folder);
    fireEvent.click(folder);
    fireEvent.click(folder);
    await act(async () => children.resolve([file("main.ts")]));

    expect(readDir).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("treeitem", { name: /src/ })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("main.ts")).not.toBeInTheDocument();
  });

  it("marks a folder whose listing failed", async () => {
    vi.mocked(readDir)
      .mockResolvedValueOnce([dir("secret")])
      .mockRejectedValueOnce("denied");
    await renderTree();

    fireEvent.click(await screen.findByRole("treeitem"));

    expect(await screen.findByText("— Could Not Read Folder")).toHaveAttribute("title", "denied");
  });

  it("is keyboard operable through aria-activedescendant", async () => {
    vi.mocked(readDir)
      .mockResolvedValueOnce([dir("src"), file("README.md")])
      .mockResolvedValueOnce([file("main.ts")]);
    const { onSelectFile } = await renderTree("/proj");
    const tree = await screen.findByRole("tree");
    const active = () => document.getElementById(tree.getAttribute("aria-activedescendant") ?? "");

    tree.focus();
    expect(active()).toHaveTextContent("src");

    fireEvent.keyDown(tree, { key: "ArrowRight" });
    await screen.findByText("main.ts");
    fireEvent.keyDown(tree, { key: "ArrowRight" });
    expect(active()).toHaveTextContent("main.ts");
    expect(active()).toHaveAttribute("aria-level", "2");

    fireEvent.keyDown(tree, { key: "ArrowLeft" });
    expect(active()).toHaveTextContent("src");
    fireEvent.keyDown(tree, { key: "End" });
    fireEvent.keyDown(tree, { key: "Enter" });
    expect(onSelectFile).toHaveBeenCalledExactlyOnceWith("/proj/README.md");
  });

  it("opens a symlink that is not a directory as a file", async () => {
    vi.mocked(readDir)
      .mockResolvedValueOnce([link("latest.log")])
      .mockRejectedValueOnce("not a dir");
    const { onSelectFile } = await renderTree("/proj");

    fireEvent.click(await screen.findByRole("treeitem"));

    await waitFor(() => expect(onSelectFile).toHaveBeenCalledWith("/proj/latest.log"));
  });
});

describe("FileTree — Trojan Source", () => {
  it("shows a file name with a bidi override as escaped data", async () => {
    vi.mocked(readDir).mockResolvedValue([file("evil\u202Etxt.exe")]);
    const { onSelectFile } = await renderTree();

    const row = await screen.findByRole("treeitem");
    expect(screen.getByText(String.raw`evil\u202Etxt.exe`)).toBeInTheDocument();
    expect(row.textContent).not.toContain("\u202E");
    // The raw name still reaches the callback: escaping is display only.
    fireEvent.click(row);
    expect(onSelectFile).toHaveBeenCalledWith(expect.stringContaining("evil\u202Etxt.exe"));
  });
});
