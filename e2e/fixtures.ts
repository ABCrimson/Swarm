import { test as base, expect, type Locator, type Page } from "@playwright/test";

/** Pages with an entry in the sidebar's "Page Navigation" landmark. */
export type SidebarPage =
  | "Dashboard"
  | "Workers"
  | "Sessions"
  | "Metrics"
  | "Logs"
  | "Tools"
  | "Workspace"
  | "Settings";

/**
 * The frontend shell as the specs drive it: landmarks, navigation and the
 * command palette, plus the one readiness rule every spec relies on.
 */
export class SwarmApp {
  readonly page: Page;
  readonly nav: Locator;
  readonly main: Locator;
  readonly palette: Locator;

  constructor(page: Page) {
    this.page = page;
    this.nav = page.getByRole("navigation", { name: "Page Navigation" });
    this.main = page.getByRole("main");
    this.palette = page.getByRole("dialog", { name: "SWARM Command Palette" });
  }

  /** The current page's own `<h1>`, inside `<main>` (the page area). */
  heading(name?: string): Locator {
    return this.main.getByRole("heading", { level: 1, ...(name ? { name } : {}) });
  }

  /** Loads the app and waits until it takes input ({@link waitUntilReady}). */
  async open(): Promise<void> {
    await this.page.goto("/");
    await this.waitUntilReady();
  }

  /**
   * The app-ready signal. The global shortcuts (Ctrl+K, the graph/list
   * toggle) attach their `keydown` listeners in effects of the shell's
   * first commit, and a key pressed before that is silently lost — the
   * old palette flake. Pages are lazy chunks, so a page `<h1>` inside
   * `<main>` only renders in a later commit, and React flushes the
   * shell's pending effects before it renders anything else. The
   * macrotask barrier then covers the one other ordering — page and shell
   * committing together — by letting React's already-queued effect flush
   * (a scheduler task posted at commit time) run before any input
   * arrives. It is a yield, not a sleep: nothing waits on the clock.
   */
  async waitUntilReady(): Promise<void> {
    await expect(this.heading()).toBeVisible();
    await this.page.evaluate(() => new Promise<void>((resolve) => setTimeout(resolve)));
  }

  /** Navigates through the sidebar and waits for the page's heading. */
  async goTo(name: SidebarPage): Promise<void> {
    await this.nav.getByRole("button", { name }).click();
    await expect(this.heading(name)).toBeVisible();
  }

  /** Opens the command palette with its default shortcut. */
  async openPalette(): Promise<Locator> {
    await this.page.keyboard.press("ControlOrMeta+k");
    await expect(this.palette).toBeVisible();
    return this.palette;
  }
}

/**
 * `test` with an `app` fixture that has already opened the app and waited
 * for it to be ready, so no spec presses a key into a half-mounted shell.
 */
export const test = base.extend<{ app: SwarmApp }>({
  app: async ({ page }, use) => {
    const app = new SwarmApp(page);
    await app.open();
    await use(app);
  },
});

export { expect };
