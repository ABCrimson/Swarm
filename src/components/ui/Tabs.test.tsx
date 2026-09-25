import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { type TabItem, TabList, TabPanel } from "#components/ui/Tabs";

type Id = "one" | "two" | "three";

function Counter(): React.ReactElement {
  const [count, setCount] = useState(0);
  return (
    <button type="button" onClick={() => setCount((c) => c + 1)}>
      Count {count}
    </button>
  );
}

function Harness({ disabledTwo = false }: { readonly disabledTwo?: boolean }): React.ReactElement {
  const [value, setValue] = useState<Id>("one");
  const items: ReadonlyArray<TabItem<Id>> = [
    { id: "one", label: "One" },
    { id: "two", label: "Two", disabled: disabledTwo },
    { id: "three", label: "Three" },
  ];
  return (
    <>
      <TabList label="Things" idBase="t" items={items} value={value} onChange={setValue} />
      <TabPanel idBase="t" id="one" selected={value === "one"}>
        <Counter />
      </TabPanel>
      <TabPanel idBase="t" id="two" selected={value === "two"}>
        Panel Two
      </TabPanel>
      <TabPanel idBase="t" id="three" selected={value === "three"} mounted={false}>
        Panel Three
      </TabPanel>
    </>
  );
}

describe("Tabs", () => {
  it("links each tab to its panel and has one Tab stop", () => {
    render(<Harness />);

    const tablist = screen.getByRole("tablist", { name: "Things" });
    const tabs = screen.getAllByRole("tab");
    expect(tablist).toContainElement(tabs[0] ?? null);
    expect(tabs.map((tab) => tab.tabIndex)).toEqual([0, -1, -1]);

    const one = screen.getByRole("tab", { name: "One" });
    const panel = screen.getByRole("tabpanel", { name: "One" });
    expect(one).toHaveAttribute("aria-controls", panel.id);
    expect(one).toHaveAttribute("aria-selected", "true");
  });

  it("moves and selects with Arrow keys, Home and End, wrapping around", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole("tab", { name: "One" }));
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "Two" })).toHaveFocus();
    expect(screen.getByRole("tab", { name: "Two" })).toHaveAttribute("aria-selected", "true");

    await user.keyboard("{End}");
    expect(screen.getByRole("tab", { name: "Three" })).toHaveFocus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "One" })).toHaveFocus();
    await user.keyboard("{ArrowLeft}");
    expect(screen.getByRole("tab", { name: "Three" })).toHaveFocus();
    await user.keyboard("{Home}");
    expect(screen.getByRole("tab", { name: "One" })).toHaveAttribute("aria-selected", "true");
  });

  it("skips disabled tabs", async () => {
    const user = userEvent.setup();
    render(<Harness disabledTwo />);

    await user.click(screen.getByRole("tab", { name: "One" }));
    await user.keyboard("{ArrowRight}");

    expect(screen.getByRole("tab", { name: "Three" })).toHaveFocus();
  });

  it("points every tab's aria-controls at an existing panel, even a never-shown one", () => {
    const { container } = render(<Harness />);

    for (const tab of screen.getAllByRole("tab")) {
      const controls = tab.getAttribute("aria-controls");
      expect(controls, tab.textContent ?? "").toBeTruthy();
      expect(container.ownerDocument.getElementById(controls ?? "")).not.toBeNull();
    }
    const three = screen.getByRole("tab", { name: "Three" });
    const shell = container.ownerDocument.getElementById(three.getAttribute("aria-controls") ?? "");
    expect(shell).toHaveAttribute("role", "tabpanel");
    expect(shell).toHaveAttribute("aria-labelledby", three.id);
    expect(shell).not.toBeVisible();
    expect(shell).toBeEmptyDOMElement();
  });

  it("keeps a hidden panel's state and skips never-shown panels", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    expect(screen.queryByText("Panel Three")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Count 0" }));
    await user.click(screen.getByRole("tab", { name: "Two" }));
    expect(screen.queryByRole("button", { name: /Count/ })).toBeNull();

    await user.click(screen.getByRole("tab", { name: "One" }));
    expect(screen.getByRole("button", { name: "Count 1" })).toBeVisible();
  });
});
