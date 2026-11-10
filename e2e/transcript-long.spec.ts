/// <reference lib="dom" />
// `evaluate` callbacks run in the browser: type them against the DOM lib.

import type { Locator, Page } from "@playwright/test";
import { routeAnthropic } from "./anthropic-stream.ts";
import { expect, SwarmApp, test } from "./fixtures.ts";
import { emitEvents, installTauriIpc } from "./tauri-ipc.ts";
import {
  AGENT_WORKER,
  AGENT_WORKER_NAME,
  CHAT_WORKER_NAME,
  EventLog,
  openWorkerChat,
  sendChatMessages,
} from "./transcript.ts";

// Long transcripts: every AgentChat row and AIChat message carries
// `content-visibility: auto`, so the browser skips rendering the rows that
// are off-screen while they stay in the DOM, in the accessibility tree and
// in find-in-page. The column-reverse scroller must still keep the view on
// the newest row as rows arrive.

const ROWS = 200;
const BATCH = 20;

/** The scroller is pinned to its end: `column-reverse` puts the end at scrollTop 0. */
async function expectPinnedToEnd(log: Locator): Promise<void> {
  await expect.poll(() => log.evaluate((el) => Math.abs(el.scrollTop))).toBeLessThanOrEqual(1);
}

/** Whether `locator`'s element is rendered, counting a skipped `content-visibility: auto` subtree as not. */
function isRendered(locator: Locator): Promise<boolean> {
  return locator.evaluate((el) => el.checkVisibility({ contentVisibilityAuto: true }));
}

/**
 * Find-in-page from script: `window.find` (non-standard, in Chromium and
 * WebKit; not in lib.dom) selects the next match, and, as the browser's find
 * bar does, the match is then scrolled into view (`window.find` itself
 * scrolls only the document, not the transcript's scroller).
 */
async function findInPage(page: Page, text: string): Promise<boolean> {
  return page.evaluate((needle) => {
    type Find = (
      text: string,
      caseSensitive: boolean,
      backwards: boolean,
      wrap: boolean,
    ) => boolean;
    // Case-sensitive, forwards, wrapping past the end as the find bar does.
    if (!(window as unknown as { find: Find }).find(needle, true, false, true)) return false;
    getSelection()?.getRangeAt(0).startContainer.parentElement?.scrollIntoView({ block: "center" });
    return true;
  }, text);
}

test.describe("Long transcripts", () => {
  // The size the row-height estimates were measured at.
  test.use({ viewport: { width: 1440, height: 900 } });

  test("AgentChat stays pinned to the newest of 200 appended rows; off-screen rows skip rendering but stay findable", async ({
    page,
  }) => {
    await installTauriIpc(page);
    const app = new SwarmApp(page);
    await app.open();
    const events = new EventLog();
    await emitEvents(page, events.agentWorker());
    const log = await openWorkerChat(app, AGENT_WORKER_NAME);

    for (let start = 1; start <= ROWS; start += BATCH) {
      await emitEvents(
        page,
        Array.from({ length: BATCH }, (_, i) =>
          events.text(AGENT_WORKER, "turn-long", start + i, `Row ${start + i} of ${ROWS}.`),
        ),
      );
      const newest = log.getByText(`Row ${start + BATCH - 1} of ${ROWS}.`, { exact: true });
      await expect(newest).toBeInViewport();
      await expectPinnedToEnd(log);
    }

    const first = log.getByText(`Row 1 of ${ROWS}.`, { exact: true });
    // Off-screen: in the DOM and the accessibility tree, but not rendered.
    await expect(first).toBeAttached();
    await expect(first).not.toBeInViewport();
    expect(await isRendered(first)).toBe(false);
    expect(await log.ariaSnapshot()).toContain(`Row 1 of ${ROWS}.`);

    // Find-in-page reaches the skipped row and scrolls it into view.
    expect(await findInPage(page, `Row 1 of ${ROWS}.`)).toBe(true);
    await expect(first).toBeInViewport();
    expect(await isRendered(first)).toBe(true);
  });

  test("a pending approval scrolled out of view by 200 rows is reachable from the keyboard and answerable", async ({
    page,
  }) => {
    await installTauriIpc(page);
    const app = new SwarmApp(page);
    await app.open();
    const events = new EventLog();
    await emitEvents(page, [
      ...events.agentWorker(),
      events.pendingApproval(AGENT_WORKER, "turn-ask"),
    ]);
    const log = await openWorkerChat(app, AGENT_WORKER_NAME);
    await emitEvents(
      page,
      Array.from({ length: ROWS }, (_, i) =>
        events.text(AGENT_WORKER, "turn-long", i, `Row ${i + 1} of ${ROWS}.`),
      ),
    );
    await expectPinnedToEnd(log);

    const approval = log.getByRole("group", { name: "Permission Request: Bash" });
    await expect(approval).not.toBeInViewport();
    // Tab from the transcript reaches the oldest row's first control, and
    // focusing it renders the skipped row and scrolls it into view.
    await log.focus();
    await page.keyboard.press("Tab");
    const allow = approval.getByRole("button", { name: "Allow" });
    await expect(allow).toBeFocused();
    await expect(approval).toBeInViewport();
    await expect(approval).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(approval.getByText("Allowed", { exact: true })).toBeVisible();
  });

  test("AIChat keeps the newest message in view; off-screen messages skip rendering but stay findable", async ({
    page,
  }) => {
    await installTauriIpc(page, {
      config: { anthropic_api_key: "sk-ant-e2e" },
      replies: { agent_turn_started: 1 },
    });
    await routeAnthropic(page);
    const app = new SwarmApp(page);
    await app.open();
    await emitEvents(page, [new EventLog().webviewWorker()]);
    const log = await openWorkerChat(app, CHAT_WORKER_NAME);

    // Enough messages that the oldest is past the margin around the viewport
    // within which the browser renders `content-visibility: auto` content.
    const sends = Array.from({ length: 12 }, (_, i) => `Summary request ${i + 1}`);
    await sendChatMessages(app, log, sends);
    await expect(log.getByText(/ship the branch/).last()).toBeInViewport();
    await expectPinnedToEnd(log);

    const first = log.getByText(sends[0] ?? "", { exact: true });
    await expect(first).not.toBeInViewport();
    expect(await isRendered(first)).toBe(false);
    expect(await log.ariaSnapshot()).toContain(sends[0]);
    expect(await findInPage(page, sends[0] ?? "")).toBe(true);
    await expect(first).toBeInViewport();
  });
});
