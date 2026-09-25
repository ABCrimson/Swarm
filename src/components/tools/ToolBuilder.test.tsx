import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ToolBuilder } from "#components/tools/ToolBuilder";

const TAKEN = new Set(["spawn_worker", "other_tool"]);

function renderBuilder() {
  const onSave = vi.fn();
  render(<ToolBuilder takenNames={TAKEN} onSave={onSave} onCancel={vi.fn()} />);
  return { onSave, user: userEvent.setup() };
}

describe("ToolBuilder", () => {
  it("blocks saving a name another tool already owns", async () => {
    const { user } = renderBuilder();

    await user.type(screen.getByLabelText("Tool Name"), "spawn_worker");

    expect(screen.getByLabelText("Tool Name")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText("Name Already In Use By Another Tool.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save Tool" })).toBeDisabled();
  });

  it("blocks saving an API-invalid parameter name and explains why, per row", async () => {
    const { user, onSave } = renderBuilder();
    await user.type(screen.getByLabelText("Tool Name"), "lookup_docs");
    await user.click(screen.getByRole("button", { name: "+ Add Parameter" }));

    const paramName = screen.getByLabelText("Parameter 1 Name");
    await user.type(paramName, "file path");

    expect(paramName).toHaveAttribute("aria-invalid", "true");
    expect(paramName).toHaveAccessibleDescription(/The API Rejects Anything Else/);
    expect(screen.getByRole("button", { name: "Save Tool" })).toBeDisabled();

    await user.clear(paramName);
    await user.type(paramName, "file.path");
    await user.click(screen.getByRole("button", { name: "Save Tool" }));

    expect(onSave).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        name: "lookup_docs",
        params: [expect.objectContaining({ name: "file.path", type: "string" })],
      }),
    );
  });

  it("flags duplicate parameter names", async () => {
    const { user } = renderBuilder();
    await user.type(screen.getByLabelText("Tool Name"), "lookup_docs");
    await user.click(screen.getByRole("button", { name: "+ Add Parameter" }));
    await user.click(screen.getByRole("button", { name: "+ Add Parameter" }));
    await user.type(screen.getByLabelText("Parameter 1 Name"), "q");
    await user.type(screen.getByLabelText("Parameter 2 Name"), "q");

    expect(screen.getAllByText("Duplicate Parameter Name.")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Save Tool" })).toBeDisabled();
  });

  it("previews exactly the tool JSON that is sent, including an empty description", async () => {
    const { user } = renderBuilder();
    await user.type(screen.getByLabelText("Tool Name"), "lookup_docs");

    const preview = screen.getByRole("region", { name: "Anthropic Tool Preview" });
    expect(JSON.parse(preview.querySelector("pre")?.textContent ?? "")).toEqual({
      name: "lookup_docs",
      description: "",
      input_schema: { type: "object", properties: {}, required: [] },
    });
  });
});
