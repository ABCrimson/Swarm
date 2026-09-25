import { describe, expect, it } from "vitest";
import {
  bindingFromEvent,
  DEFAULT_KEYBINDINGS,
  formatBinding,
  matchesBinding,
} from "#lib/keybindings";

function keyEvent(init: KeyboardEventInit): KeyboardEvent {
  return new KeyboardEvent("keydown", init);
}

describe("matchesBinding", () => {
  it("matches the default palette binding on Ctrl+K", () => {
    expect(matchesBinding(keyEvent({ key: "k", ctrlKey: true }), "ctrl+k")).toBe(true);
  });

  it("treats Cmd as Ctrl (mac palette behavior preserved)", () => {
    expect(matchesBinding(keyEvent({ key: "k", metaKey: true }), "ctrl+k")).toBe(true);
  });

  it("matches shifted letters case-insensitively (Ctrl+Shift+G produces key 'G')", () => {
    expect(
      matchesBinding(keyEvent({ key: "G", ctrlKey: true, shiftKey: true }), "ctrl+shift+g"),
    ).toBe(true);
  });

  it("rejects when a required modifier is missing", () => {
    expect(matchesBinding(keyEvent({ key: "g", ctrlKey: true }), "ctrl+shift+g")).toBe(false);
  });

  it("rejects when an extra modifier is held", () => {
    expect(matchesBinding(keyEvent({ key: "k", ctrlKey: true, shiftKey: true }), "ctrl+k")).toBe(
      false,
    );
  });

  it("rejects a bare key against a modified binding", () => {
    expect(matchesBinding(keyEvent({ key: "k" }), "ctrl+k")).toBe(false);
  });

  it("matches the physical key on a non-Latin layout (Ctrl+K types 'л' on ЙЦУКЕН)", () => {
    expect(matchesBinding(keyEvent({ key: "л", code: "KeyK", ctrlKey: true }), "ctrl+k")).toBe(
      true,
    );
  });

  it("keeps the typed Latin letter on a Latin layout that moves keys (AZERTY 'a' sits on KeyQ)", () => {
    expect(matchesBinding(keyEvent({ key: "a", code: "KeyQ", ctrlKey: true }), "ctrl+a")).toBe(
      true,
    );
    expect(matchesBinding(keyEvent({ key: "a", code: "KeyQ", ctrlKey: true }), "ctrl+q")).toBe(
      false,
    );
  });

  it("never fires during an IME composition", () => {
    expect(
      matchesBinding(
        keyEvent({ key: "k", code: "KeyK", ctrlKey: true, isComposing: true }),
        "ctrl+k",
      ),
    ).toBe(false);
  });
});

describe("bindingFromEvent", () => {
  it("builds a normalized binding from a modified keypress", () => {
    expect(bindingFromEvent(keyEvent({ key: "G", ctrlKey: true, shiftKey: true }))).toBe(
      "ctrl+shift+g",
    );
  });

  it("returns null for a pure modifier press", () => {
    expect(bindingFromEvent(keyEvent({ key: "Control", ctrlKey: true }))).toBeNull();
    expect(bindingFromEvent(keyEvent({ key: "Shift", shiftKey: true }))).toBeNull();
  });

  it("returns null for an unmodified letter (would hijack typing)", () => {
    expect(bindingFromEvent(keyEvent({ key: "g" }))).toBeNull();
  });

  it("allows unmodified function keys", () => {
    expect(bindingFromEvent(keyEvent({ key: "F5" }))).toBe("f5");
  });

  it("rejects '+' and space terminal keys (can't round-trip the '+'-joined format)", () => {
    expect(bindingFromEvent(keyEvent({ key: "+", ctrlKey: true }))).toBeNull();
    expect(bindingFromEvent(keyEvent({ key: " ", ctrlKey: true }))).toBeNull();
  });

  it("treats AltGraph as a modifier, not a terminal key", () => {
    expect(bindingFromEvent(keyEvent({ key: "AltGraph" }))).toBeNull();
  });

  it("records the physical letter when the layout types a symbol (macOS Option+G types '©')", () => {
    expect(bindingFromEvent(keyEvent({ key: "©", code: "KeyG", altKey: true }))).toBe("alt+g");
  });

  it("records the digit for Shift+digit, not the shifted symbol", () => {
    expect(
      bindingFromEvent(keyEvent({ key: "!", code: "Digit1", ctrlKey: true, shiftKey: true })),
    ).toBe("ctrl+shift+1");
  });

  it("returns null for a keystroke inside an IME composition", () => {
    expect(bindingFromEvent(keyEvent({ key: "k", ctrlKey: true, isComposing: true }))).toBeNull();
  });

  it("includes alt in the normalized order", () => {
    expect(bindingFromEvent(keyEvent({ key: "p", ctrlKey: true, altKey: true }))).toBe(
      "ctrl+alt+p",
    );
  });
});

describe("formatBinding", () => {
  it("Title-Cases each part for display", () => {
    expect(formatBinding("ctrl+shift+g")).toBe("Ctrl+Shift+G");
    expect(formatBinding("ctrl+k")).toBe("Ctrl+K");
  });

  it("renders multi-word named keys properly", () => {
    expect(formatBinding("ctrl+arrowup")).toBe("Ctrl+ArrowUp");
    expect(formatBinding("ctrl+pagedown")).toBe("Ctrl+PageDown");
  });

  it("never crashes on malformed bindings with empty parts", () => {
    expect(formatBinding("ctrl++")).toBe("Ctrl");
    expect(formatBinding("")).toBe("");
  });

  it("round-trips every default binding", () => {
    for (const binding of Object.values(DEFAULT_KEYBINDINGS)) {
      expect(formatBinding(binding).toLowerCase()).toBe(binding);
    }
  });
});
