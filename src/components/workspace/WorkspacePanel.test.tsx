import { open } from "@tauri-apps/plugin-dialog";
import { readDir, readTextFile, stat } from "@tauri-apps/plugin-fs";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspacePanel } from "#components/workspace/WorkspacePanel";

/** `true` makes the active transport report no workspace browsing (the `build:web` page). */
const web = vi.hoisted(() => ({ on: false }));
vi.mock(import("#lib/tauri"), async (importOriginal) => ({
  ...(await importOriginal()),
  hasCapability: () => !web.on,
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("@tauri-apps/plugin-fs", () => ({
  readDir: vi.fn(),
  readTextFile: vi.fn(),
  stat: vi.fn(),
}));

beforeEach(() => {
  web.on = false;
  vi.mocked(open).mockResolvedValue("D:\\code\\app");
  vi.mocked(readDir).mockResolvedValue([
    { name: "README.md", isFile: true, isDirectory: false, isSymlink: false },
  ]);
  vi.mocked(stat).mockRejectedValue("stat not allowed");
  vi.mocked(readTextFile).mockResolvedValue("# App\n");
  HTMLElement.prototype.setPointerCapture = vi.fn();
  // jsdom has no ResizeObserver; the tree only needs one to exist here.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  );
});

async function openProject() {
  const user = userEvent.setup();
  render(<WorkspacePanel />);
  await user.click(screen.getByRole("button", { name: "Open Project" }));
  await screen.findByRole("tree", { name: "Project Files" });
  return user;
}

describe("WorkspacePanel", () => {
  it("disables Open Project and says why when the transport cannot browse files", async () => {
    web.on = true;
    const user = userEvent.setup();
    render(<WorkspacePanel />);

    const button = screen.getByRole("button", { name: "Open Project" });
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription("Available In The Desktop App Only");
    await user.click(button);
    expect(open).not.toHaveBeenCalled();
  });

  // Regression: without `recursive`, only the picked folder entered the fs
  // scope, so subfolders of a project outside $HOME could not be listed.
  it("opens the project directory recursively", async () => {
    await openProject();

    expect(open).toHaveBeenCalledExactlyOnceWith({
      title: "Open Project Directory",
      directory: true,
      multiple: false,
      recursive: true,
    });
    expect(readDir).toHaveBeenCalledWith("D:\\code\\app");
  });

  it("shows a file after it is opened from the tree", async () => {
    await openProject();

    // The read suspends the viewer (use()); an awaited act lets it resolve.
    await act(async () => fireEvent.click(screen.getByRole("treeitem", { name: /README\.md/ })));

    expect(await screen.findByText("# App")).toBeInTheDocument();
    expect(readTextFile).toHaveBeenCalledWith("D:\\code\\app\\README.md");
    expect(screen.getByRole("treeitem", { name: /README\.md/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  // The separator's widened hit area overlaps the viewer's left edge, so wheel
  // events over it are forwarded to the viewer's scroller.
  it("forwards a wheel over the separator to the file viewer", async () => {
    await openProject();
    await act(async () => fireEvent.click(screen.getByRole("treeitem", { name: /README\.md/ })));
    await screen.findByText("# App");
    const scrollBy = vi.fn();
    HTMLElement.prototype.scrollBy = scrollBy;

    fireEvent.wheel(screen.getByRole("separator", { name: "Resize File Tree" }), { deltaY: 100 });

    expect(scrollBy).toHaveBeenCalledWith(0, 100);
  });

  it("resizes the tree with the keyboard and a pointer drag, within limits", async () => {
    await openProject();
    const handle = screen.getByRole("separator", { name: "Resize File Tree" });

    fireEvent.keyDown(handle, { key: "End" });
    expect(handle).toHaveAttribute("aria-valuenow", "480");
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(handle).toHaveAttribute("aria-valuenow", "464");

    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 500 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 100 });
    expect(handle).toHaveAttribute("aria-valuenow", "180");
    fireEvent.lostPointerCapture(handle, { pointerId: 1 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 400 });
    expect(handle).toHaveAttribute("aria-valuenow", "180");
  });
});
