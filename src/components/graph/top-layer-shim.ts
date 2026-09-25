/**
 * Test-only stand-ins for the top-layer APIs jsdom 30 does not implement:
 * `HTMLDialogElement.showModal()/close()` (Escape fires `cancel`, then
 * closes) and the Popover API (`showPopover`/`hidePopover`,
 * `:popover-open`, `toggle` events with `newState`, and light dismiss of
 * `popover="auto"` on Escape or an outside pointer press). As in
 * browsers, `close` and `toggle` arrive as queued tasks, not
 * synchronously, and pending toggles coalesce. Import it from
 * a test file that renders a native dialog or popover. Each shim installs
 * only where jsdom lacks the API, so a jsdom that ships it takes over.
 */

type Popover = HTMLElement & { showPopover(): void; hidePopover(): void };

if (typeof HTMLDialogElement.prototype.showModal !== "function") {
  const onEscape = new WeakMap<HTMLDialogElement, (event: KeyboardEvent) => void>();

  Object.assign(HTMLDialogElement.prototype, {
    showModal(this: HTMLDialogElement): void {
      if (this.open) return;
      this.open = true;
      const handler = (event: KeyboardEvent): void => {
        if (event.key !== "Escape" || !this.open) return;
        if (this.dispatchEvent(new Event("cancel", { cancelable: true }))) this.close();
      };
      onEscape.set(this, handler);
      document.addEventListener("keydown", handler, true);
    },
    close(this: HTMLDialogElement): void {
      if (!this.open) return;
      this.open = false;
      const handler = onEscape.get(this);
      if (handler) document.removeEventListener("keydown", handler, true);
      // Browsers queue the close event as a task; so does the shim.
      setTimeout(() => this.dispatchEvent(new Event("close")));
    },
  });
}

if (typeof (HTMLElement.prototype as Partial<Popover>).showPopover !== "function") {
  const open = new Set<HTMLElement>();

  // Like browsers, `toggle` is a queued task, and a toggle queued while
  // another is pending replaces it (keeping the first oldState).
  const pending = new Map<
    HTMLElement,
    { oldState: string; timer: ReturnType<typeof setTimeout> }
  >();
  const toggle = (element: HTMLElement, oldState: string, newState: string): void => {
    const queued = pending.get(element);
    if (queued) clearTimeout(queued.timer);
    const first = queued?.oldState ?? oldState;
    const timer = setTimeout(() => {
      pending.delete(element);
      element.dispatchEvent(Object.assign(new Event("toggle"), { oldState: first, newState }));
    });
    pending.set(element, { oldState: first, timer });
  };

  // jsdom's UA sheet hides `[popover]:not(:popover-open)`, and its
  // selector engine never matches `:popover-open`: re-show open ones.
  const sheet = document.createElement("style");
  sheet.textContent = "[popover][data-shim-popover-open] { display: block !important; }";
  document.head.append(sheet);

  Object.assign(HTMLElement.prototype, {
    showPopover(this: HTMLElement): void {
      if (open.has(this)) return;
      open.add(this);
      this.dataset.shimPopoverOpen = "";
      toggle(this, "closed", "open");
    },
    hidePopover(this: HTMLElement): void {
      if (!open.delete(this)) return;
      delete this.dataset.shimPopoverOpen;
      toggle(this, "open", "closed");
    },
  });

  const matches = Element.prototype.matches;
  Object.defineProperty(Element.prototype, "matches", {
    configurable: true,
    writable: true,
    value(this: Element, selector: string): boolean {
      return selector === ":popover-open"
        ? open.has(this as HTMLElement)
        : matches.call(this, selector);
    },
  });

  const lightDismiss = (keep: (popover: HTMLElement) => boolean): void => {
    for (const popover of [...open]) {
      if (popover.getAttribute("popover") === "auto" && !keep(popover)) {
        (popover as Popover).hidePopover();
      }
    }
  };
  document.addEventListener("pointerdown", (event) =>
    lightDismiss((popover) => popover.contains(event.target as Node)),
  );
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") lightDismiss(() => false);
  });
}
