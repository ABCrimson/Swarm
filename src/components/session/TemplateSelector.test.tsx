import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TemplateSelector } from "#components/session/TemplateSelector";
import type { UserTemplatesResult } from "#lib/templates";
import { BUILT_IN_TEMPLATES } from "#lib/templates";
import type { SessionTemplate } from "#store/types";

const mockResource = vi.fn<() => Promise<UserTemplatesResult>>();
vi.mock(import("#lib/templates"), async (importOriginal) => ({
  ...(await importOriginal()),
  userTemplatesResource: () => mockResource(),
}));

const USER_TEMPLATE: SessionTemplate = {
  id: "5f1d7c3e-8a2b-4c6d-9e0f-1a2b3c4d5e6f",
  name: "My Review Crew",
  description: "Two Reviewers",
  workerConfigs: [{ name: "Reviewer" }, { name: "Second Reviewer" }],
  builtIn: false,
};

afterEach(cleanup);

/** Renders with the user-template read resolving to `result`, inside act() so the suspended section can reveal. */
async function renderSelector(result: UserTemplatesResult) {
  // One promise for every call, like the real cached resource.
  mockResource.mockReturnValue(Promise.resolve(result));
  const onSelect = vi.fn();
  const onClose = vi.fn();
  await act(async () => {
    render(<TemplateSelector onSelect={onSelect} onClose={onClose} />);
  });
  return { onSelect, onClose };
}

describe("TemplateSelector", () => {
  it("lists the built-in templates and the user's own, each selectable", async () => {
    const user = userEvent.setup();
    const { onSelect } = await renderSelector({ templates: [USER_TEMPLATE], failed: false });

    const builtIns = screen.getByRole("region", { name: "Built-In Templates" });
    expect(within(builtIns).getAllByRole("button")).toHaveLength(BUILT_IN_TEMPLATES.length);

    const yours = await screen.findByRole("region", { name: "Your Templates" });
    await user.click(within(yours).getByRole("button", { name: /My Review Crew/ }));
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(USER_TEMPLATE);
    expect(within(yours).getByText("2 Workers")).toBeInTheDocument();
  });

  it("says so when the user's templates cannot be read, instead of silently showing only the built-ins", async () => {
    await renderSelector({ templates: [], failed: true });

    expect(await screen.findByRole("alert")).toHaveTextContent("Could Not Load Your Templates.");
    expect(screen.getByRole("region", { name: "Built-In Templates" })).toBeInTheDocument();
  });

  it("shows no user section when there are no user templates", async () => {
    await renderSelector({ templates: [], failed: false });

    await vi.waitFor(() => {
      expect(screen.queryByText("Loading Your Templates…")).not.toBeInTheDocument();
    });
    expect(screen.queryByRole("region", { name: "Your Templates" })).not.toBeInTheDocument();
  });

  it("closes from its labelled close button", async () => {
    const user = userEvent.setup();
    const { onClose } = await renderSelector({ templates: [], failed: false });

    await user.click(screen.getByRole("button", { name: "Close Template Selector" }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
