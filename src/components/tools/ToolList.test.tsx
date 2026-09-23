import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ToolList } from "#components/tools/ToolList";
import type { CustomToolDef } from "#lib/custom-tools";

const CUSTOM: CustomToolDef = {
  id: "t1",
  name: "lookup_docs",
  description: "Searches docs.",
  params: [{ id: "p1", name: "query", type: "string", description: "" }],
  script: "",
};

describe("ToolList", () => {
  it("renders the Title Case uiDescription of built-ins, not the model-facing description", () => {
    render(<ToolList customTools={[]} onEdit={vi.fn()} onDelete={vi.fn()} onCreateNew={vi.fn()} />);

    expect(screen.getByText("Spawn A New Worker Process. Returns The Worker ID.")).toBeVisible();
    expect(
      screen.queryByText("Spawn a new worker process. Returns the worker ID."),
    ).not.toBeInTheDocument();
  });

  it("names each custom tool's actions after the tool and hands the whole tool to onDelete", async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn();
    const onEdit = vi.fn();
    render(
      <ToolList customTools={[CUSTOM]} onEdit={onEdit} onDelete={onDelete} onCreateNew={vi.fn()} />,
    );

    const card = screen.getByRole("article", { name: "lookup_docs" });
    await user.click(within(card).getByRole("button", { name: "Edit lookup_docs" }));
    await user.click(within(card).getByRole("button", { name: "Delete lookup_docs" }));

    expect(onEdit).toHaveBeenCalledWith(CUSTOM);
    expect(onDelete).toHaveBeenCalledWith(CUSTOM);
  });
});
