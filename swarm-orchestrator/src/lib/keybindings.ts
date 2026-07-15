// ── Keybindings ─────────────────────────────────────
// One normalized format ("ctrl+shift+g") for the app's remappable
// shortcuts, replacing the hardcoded key comparisons that used to be
// duplicated across CommandPalette, Workers, and PerformanceOverlay.
// "ctrl" matches either Ctrl or Cmd (the palette has always accepted
// both; remapping preserves that).

/** The app's remappable shortcuts. */
export interface Keybindings {
  /** Open the command palette. */
  readonly commandPalette: string;
  /** Toggle the Workers page between graph and list view. */
  readonly graphToggle: string;
  /** Toggle the performance overlay. */
  readonly perfOverlay: string;
}

export const DEFAULT_KEYBINDINGS: Keybindings = {
  commandPalette: "ctrl+k",
  graphToggle: "ctrl+shift+g",
  perfOverlay: "ctrl+shift+p",
};

/** Keys that are pure modifiers — never a binding's terminal key. */
const MODIFIER_KEYS = new Set(["control", "shift", "alt", "meta", "altgraph"]);

/**
 * Builds a normalized binding string from a keydown event, or `null`
 * when the event can't form a complete binding: a bare modifier press,
 * a bare letter/digit with no modifier (would hijack typing), or a
 * terminal key that can't round-trip through the "+"-joined format
 * ("+" itself and space).
 */
export function bindingFromEvent(e: KeyboardEvent): string | null {
  const key = e.key.toLowerCase();
  if (MODIFIER_KEYS.has(key)) return null;
  if (key === "+" || key === " ") return null;

  const hasModifier = e.ctrlKey || e.metaKey || e.altKey;
  const isFunctionKey = /^f\d{1,2}$/.test(key);
  if (!hasModifier && !isFunctionKey) return null;

  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push("ctrl");
  if (e.altKey) parts.push("alt");
  if (e.shiftKey) parts.push("shift");
  parts.push(key);
  return parts.join("+");
}

/** Tests whether a keydown event matches a normalized binding string. */
export function matchesBinding(e: KeyboardEvent, binding: string): boolean {
  const parts = binding.toLowerCase().split("+");
  const key = parts.at(-1) ?? "";
  const wantsCtrl = parts.includes("ctrl");
  const wantsAlt = parts.includes("alt");
  const wantsShift = parts.includes("shift");

  return (
    e.key.toLowerCase() === key &&
    (e.ctrlKey || e.metaKey) === wantsCtrl &&
    e.altKey === wantsAlt &&
    e.shiftKey === wantsShift
  );
}

/** Display names for multi-word named keys that plain capitalization would mangle. */
const KEY_DISPLAY_NAMES: Record<string, string> = {
  arrowup: "ArrowUp",
  arrowdown: "ArrowDown",
  arrowleft: "ArrowLeft",
  arrowright: "ArrowRight",
  pageup: "PageUp",
  pagedown: "PageDown",
  capslock: "CapsLock",
  numlock: "NumLock",
  scrolllock: "ScrollLock",
  contextmenu: "ContextMenu",
  printscreen: "PrintScreen",
};

/** Formats a normalized binding for display: "ctrl+shift+g" → "Ctrl+Shift+G". */
export function formatBinding(binding: string): string {
  return binding
    .split("+")
    .filter((part) => part.length > 0)
    .map(
      (part) =>
        KEY_DISPLAY_NAMES[part] ??
        (part.length === 1 ? part.toUpperCase() : part[0].toUpperCase() + part.slice(1)),
    )
    .join("+");
}
