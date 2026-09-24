/**
 * Minimal jsdom stand-ins for platform APIs jsdom 30 does not implement
 * yet — `HTMLDialogElement.showModal()/close()` and the Popover API
 * (`showPopover`/`hidePopover`/`togglePopover`, `popovertarget` buttons,
 * `toggle`/`beforetoggle` events, light dismiss on Escape and outside
 * clicks), plus layout-free `ResizeObserver` and `scrollIntoView`
 * no-ops. Import it from test files that exercise native dialogs,
 * popovers or layout-observing widgets; each shim installs only where
 * jsdom lacks the API, so a future jsdom that ships it takes over.
 */

const proto = HTMLElement.prototype as HTMLElement & Record<string, unknown>;

// ── <dialog> ─────────────────────────────────────────

if (typeof HTMLDialogElement.prototype.showModal !== "function") {
  Object.assign(HTMLDialogElement.prototype, {
    showModal(this: HTMLDialogElement) {
      if (this.hasAttribute("open")) return;
      this.setAttribute("open", "");
      this.dataset.modal = "true";
      document.addEventListener("keydown", escapeHandlerFor(this), true);
    },
    show(this: HTMLDialogElement) {
      this.setAttribute("open", "");
    },
    close(this: HTMLDialogElement, returnValue?: string) {
      if (!this.hasAttribute("open")) return;
      this.removeAttribute("open");
      delete this.dataset.modal;
      if (returnValue !== undefined) this.returnValue = returnValue;
      document.removeEventListener("keydown", escapeHandlerFor(this), true);
      this.dispatchEvent(new Event("close"));
    },
  });
}

const escapeHandlers = new WeakMap<HTMLDialogElement, (e: KeyboardEvent) => void>();

/** Escape on a modal dialog fires a cancelable `cancel`, then closes unless prevented. */
function escapeHandlerFor(dialog: HTMLDialogElement): (e: KeyboardEvent) => void {
  let handler = escapeHandlers.get(dialog);
  if (!handler) {
    handler = (e) => {
      if (e.key !== "Escape" || !dialog.hasAttribute("open")) return;
      const cancel = new Event("cancel", { cancelable: true });
      if (dialog.dispatchEvent(cancel)) dialog.close();
    };
    escapeHandlers.set(dialog, handler);
  }
  return handler;
}

// ── Popover API ──────────────────────────────────────

const openPopovers = new Set<HTMLElement>();

function firePopoverToggle(el: HTMLElement, oldState: string, newState: string): void {
  const init = { oldState, newState } as const;
  const make = (type: string) =>
    typeof ToggleEvent === "function"
      ? new ToggleEvent(type, init)
      : Object.assign(new Event(type), init);
  el.dispatchEvent(make("beforetoggle"));
  el.dispatchEvent(make("toggle"));
}

if (typeof proto.showPopover !== "function") {
  Object.defineProperty(HTMLElement.prototype, "popover", {
    configurable: true,
    get(this: HTMLElement) {
      return this.getAttribute("popover");
    },
    set(this: HTMLElement, value: string | null) {
      if (value === null) this.removeAttribute("popover");
      else this.setAttribute("popover", value);
    },
  });

  Object.assign(HTMLElement.prototype, {
    showPopover(this: HTMLElement) {
      if (openPopovers.has(this)) return;
      openPopovers.add(this);
      this.dataset.popoverOpen = "true";
      firePopoverToggle(this, "closed", "open");
    },
    hidePopover(this: HTMLElement) {
      if (!openPopovers.delete(this)) return;
      delete this.dataset.popoverOpen;
      firePopoverToggle(this, "open", "closed");
    },
    togglePopover(this: HTMLElement, force?: boolean) {
      const open = force ?? !openPopovers.has(this);
      if (open) (this as HTMLElement & { showPopover(): void }).showPopover();
      else (this as HTMLElement & { hidePopover(): void }).hidePopover();
      return open;
    },
  });

  const matches = Element.prototype.matches;
  Object.defineProperty(Element.prototype, "matches", {
    configurable: true,
    writable: true,
    value(this: Element, selector: string): boolean {
      if (selector === ":popover-open") return openPopovers.has(this as HTMLElement);
      return matches.call(this, selector);
    },
  });

  // `popovertarget` buttons toggle their target; light dismiss for `auto`.
  document.addEventListener("click", (e) => {
    const invoker = (e.target as Element | null)?.closest?.("[popovertarget]");
    if (invoker) {
      const target = document.getElementById(invoker.getAttribute("popovertarget") ?? "");
      if (target) {
        const action = invoker.getAttribute("popovertargetaction") ?? "toggle";
        const el = target as HTMLElement & {
          showPopover(): void;
          hidePopover(): void;
          togglePopover(): boolean;
        };
        if (action === "show") el.showPopover();
        else if (action === "hide") el.hidePopover();
        else el.togglePopover();
      }
      return;
    }
    for (const open of [...openPopovers]) {
      if (open.getAttribute("popover") === "auto" && !open.contains(e.target as Node)) {
        (open as HTMLElement & { hidePopover(): void }).hidePopover();
      }
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    for (const open of [...openPopovers]) {
      if (open.getAttribute("popover") === "auto") {
        (open as HTMLElement & { hidePopover(): void }).hidePopover();
      }
    }
  });
}

// ── ResizeObserver ───────────────────────────────────

// jsdom does no layout, so an observer that never fires is faithful.
globalThis.ResizeObserver ??= class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
};

// ── Element.scrollIntoView ───────────────────────────

Element.prototype.scrollIntoView ??= function scrollIntoView(): void {};
