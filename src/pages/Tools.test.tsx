import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { Tools } from "#pages/Tools";
import { customToolsReady, useCustomToolsStore } from "#store/custom-tools";

beforeEach(() => {
  useCustomToolsStore.setState({ customTools: [] });
});

async function createTool(user: ReturnType<typeof userEvent.setup>, name: string): Promise<void> {
  await user.click(screen.getByRole("button", { name: "+ New Tool" }));
  await user.type(screen.getByLabelText("Tool Name"), name);
  await user.click(screen.getByRole("button", { name: "Save Tool" }));
  await act(() => customToolsReady());
}

describe("Tools page focus management", () => {
  it("focuses the name field when New Tool opens the builder", async () => {
    const user = userEvent.setup();
    render(<Tools />);
    await user.click(screen.getByRole("button", { name: "+ New Tool" }));
    expect(screen.getByLabelText("Tool Name")).toHaveFocus();
  });

  it("focuses the saved tool's Edit button after saving a new tool", async () => {
    const user = userEvent.setup();
    render(<Tools />);
    await createTool(user, "my_tool");
    expect(screen.getByRole("button", { name: "Edit my_tool" })).toHaveFocus();
  });

  it("focuses the renamed tool's Edit button after a rename", async () => {
    const user = userEvent.setup();
    render(<Tools />);
    await createTool(user, "my_tool");
    await user.click(screen.getByRole("button", { name: "Edit my_tool" }));
    const name = screen.getByLabelText("Tool Name");
    await user.clear(name);
    await user.type(name, "renamed");
    await user.click(screen.getByRole("button", { name: "Save Tool" }));
    await act(() => customToolsReady());
    expect(screen.getByRole("button", { name: "Edit renamed" })).toHaveFocus();
  });

  it("returns focus to the edited tool's Edit button on Cancel", async () => {
    const user = userEvent.setup();
    render(<Tools />);
    await createTool(user, "my_tool");
    await user.click(screen.getByRole("button", { name: "Edit my_tool" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Edit my_tool" })).toHaveFocus();
  });
});
