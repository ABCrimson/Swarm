// ModelSelector in real Chromium and WebKit (vitest.config.ts, project
// `browser`). jsdom has no top layer and no light dismiss, so the popover
// contract the component leans on (open from popovertarget, Escape and an
// outside click close it, focus returns to the trigger) is proved here. The
// viewport is wide and the outside target sits in a corner because the suite
// loads no CSS: the centered fallback panel (WebKit 18.4 floor) must not cover it.

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import { ModelSelector } from "#components/ai/ModelSelector";

let root: Root | undefined;
let host: HTMLElement | undefined;

function mount() {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const mounted = root;
  flushSync(() => {
    mounted.render(
      <>
        <ModelSelector />
        <button type="button" style={{ position: "fixed", right: 0, bottom: 0 }}>
          Elsewhere
        </button>
      </>,
    );
  });
}

const listbox = () => document.querySelector<HTMLElement>("[role='listbox']");
const isOpen = () => listbox()?.matches(":popover-open") ?? false;

afterEach(() => {
  root?.unmount();
  host?.remove();
  root = undefined;
  host = undefined;
});

describe("ModelSelector (real browser)", () => {
  it("opens the popover from the trigger and focuses the selected option", async () => {
    mount();
    await userEvent.click(page.getByRole("button", { name: /^AI Model: / }));

    await expect.poll(isOpen).toBe(true);
    await expect.element(page.getByRole("option", { selected: true })).toHaveFocus();
  });

  it("closes on Escape and returns focus to the trigger", async () => {
    mount();
    const trigger = page.getByRole("button", { name: /^AI Model: / });
    // Focus the trigger first, as a keyboard user does: the popover restores
    // focus to what held it when it opened, and WebKit does not focus a
    // button on a mouse click.
    trigger.element().focus();
    await userEvent.keyboard("{Enter}");
    await expect.poll(isOpen).toBe(true);

    await userEvent.keyboard("{Escape}");

    await expect.poll(isOpen).toBe(false);
    await expect.element(trigger).toHaveFocus();
  });

  it("closes on a click outside the listbox", async () => {
    mount();
    await userEvent.click(page.getByRole("button", { name: /^AI Model: / }));
    await expect.poll(isOpen).toBe(true);

    await userEvent.click(page.getByRole("button", { name: "Elsewhere" }));

    await expect.poll(isOpen).toBe(false);
  });
});
