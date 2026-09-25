import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// The global setup stubs sonner out; this suite exercises the real toaster.
vi.unmock("sonner");

const { SwarmToaster, toast } = await import("#components/ui/Toast");

/** The `<li data-sonner-toast>` that renders the toast titled `title`. */
async function findToast(title: string): Promise<HTMLElement> {
  const text = await screen.findByText(title);
  const item = text.closest<HTMLElement>("[data-sonner-toast]");
  if (!item) throw new Error(`no toast element around "${title}"`);
  return item;
}

describe("SwarmToaster", () => {
  afterEach(() => {
    act(() => {
      toast.dismiss();
    });
  });

  it.for([
    ["success", "Saved"],
    ["error", "Failed"],
    ["warning", "Careful"],
    ["info", "Heads Up"],
  ] as const)("renders the %s toast with rich colors on", async ([type, title]) => {
    render(<SwarmToaster />);

    act(() => {
      toast[type](title);
    });

    const item = await findToast(title);
    // Sonner only applies `--<type>-bg/-border/-text` under this attribute pair.
    expect(item).toHaveAttribute("data-rich-colors", "true");
    expect(item).toHaveAttribute("data-type", type);
    // An inline background would beat Sonner's rich-color rule and hide the tint.
    expect(item.style.background).toBe("");
    expect(item.style.backgroundColor).toBe("");
  });

  it("sets every typed color variable on the toaster from the theme tokens", async () => {
    render(<SwarmToaster />);

    act(() => {
      toast.success("Saved");
    });

    const toaster = (await findToast("Saved")).closest<HTMLElement>("[data-sonner-toaster]");
    expect(toaster).not.toBeNull();
    for (const type of ["success", "error", "warning", "info"]) {
      for (const part of ["bg", "border", "text"]) {
        expect(toaster?.style.getPropertyValue(`--${type}-${part}`), `--${type}-${part}`).toMatch(
          /var\(--color-/,
        );
      }
    }
  });
});
