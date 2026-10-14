import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TemplateSelector } from "#components/session/TemplateSelector";
import type { UserTemplatesResult } from "#lib/templates";
import { BUILT_IN_TEMPLATES, invalidateUserTemplates } from "#lib/templates";
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

/** `true` makes the active transport report no capabilities (the `build:web` page). */
const web = vi.hoisted(() => ({ on: false }));
vi.mock(import("#lib/tauri"), async (importOriginal) => ({
  ...(await importOriginal()),
  hasCapability: () => !web.on,
}));

// Reading the user templates is a plugin-store call: it needs the local-stores
// capability and the Tauri bridge itself.
beforeEach(() => {
  web.on = false;
  vi.stubGlobal("isTauri", true);
  mockResource.mockReset();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

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
  it("shows the desktop-only reason and never reads the store without the Tauri bridge", async () => {
    // A plain-browser preview of the desktop build: the capability is on, the bridge is not.
    vi.unstubAllGlobals();
    const onSelect = vi.fn();
    await act(async () => {
      render(<TemplateSelector onSelect={onSelect} onClose={vi.fn()} />);
    });

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    const yours = screen.getByRole("region", { name: "Your Templates" });
    expect(within(yours).getByText("Available In The Desktop App Only")).toBeVisible();
    expect(mockResource).not.toHaveBeenCalled();
    expect(screen.getByRole("region", { name: "Built-In Templates" })).toBeInTheDocument();
  });

  it("shows the desktop-only reason and never reads the store in the browser build", async () => {
    web.on = true;
    await act(async () => {
      render(<TemplateSelector onSelect={vi.fn()} onClose={vi.fn()} />);
    });

    const yours = screen.getByRole("region", { name: "Your Templates" });
    expect(within(yours).getByText("Available In The Desktop App Only")).toBeVisible();
    expect(mockResource).not.toHaveBeenCalled();
  });

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

  // It stays mounted inside a hidden <Activity> on the Sessions page, so a
  // template saved meanwhile must show up without a remount.
  it("re-reads the user templates after a template write, while staying mounted", async () => {
    await renderSelector({ templates: [], failed: false });
    expect(screen.queryByRole("region", { name: "Your Templates" })).not.toBeInTheDocument();

    mockResource.mockReturnValue(Promise.resolve({ templates: [USER_TEMPLATE], failed: false }));
    await act(async () => {
      invalidateUserTemplates();
    });

    expect(await screen.findByRole("button", { name: /My Review Crew/ })).toBeInTheDocument();
  });

  it("closes from its labelled close button", async () => {
    const user = userEvent.setup();
    const { onClose } = await renderSelector({ templates: [], failed: false });

    await user.click(screen.getByRole("button", { name: "Close Template Selector" }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe("TemplateSelector — browser build", () => {
  it("disables every template that spawns workers, with the reason, and selects nothing", async () => {
    web.on = true;
    const user = userEvent.setup();
    const { onSelect } = await renderSelector({ templates: [], failed: false });

    const builtIns = screen.getByRole("region", { name: "Built-In Templates" });
    const cards = within(builtIns).getAllByRole("button");
    expect(cards).toHaveLength(BUILT_IN_TEMPLATES.length);
    for (const card of cards) {
      expect(card).toBeDisabled();
      expect(card).toHaveAccessibleDescription("Available In The Desktop App Only");
      await user.click(card);
    }
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("leaves the cards enabled on the desktop", async () => {
    await renderSelector({ templates: [], failed: false });

    const builtIns = screen.getByRole("region", { name: "Built-In Templates" });
    for (const card of within(builtIns).getAllByRole("button")) expect(card).toBeEnabled();
    expect(
      within(builtIns).queryByText("Available In The Desktop App Only"),
    ).not.toBeInTheDocument();
  });
});

describe("TemplateSelector — Trojan Source", () => {
  it("shows a template name with a bidi override as escaped data", async () => {
    await renderSelector({
      templates: [{ ...USER_TEMPLATE, name: "a\u202Eb" }],
      failed: false,
    });

    expect(await screen.findByText(String.raw`a\u202Eb`)).toBeInTheDocument();
  });
});
