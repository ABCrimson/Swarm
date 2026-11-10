import { routeAnthropic } from "./anthropic-stream.ts";
import { expect, SwarmApp, test } from "./fixtures.ts";
import { emitEvents, installTauriIpc } from "./tauri-ipc.ts";
import {
  AGENT_WORKER,
  AGENT_WORKER_NAME,
  CHAT_WORKER_NAME,
  EventLog,
  openWorkerChat,
  sendChatMessage,
  sendChatMessages,
} from "./transcript.ts";

// The desktop bundle runs against a scripted IPC bridge (`tauri-ipc.ts`):
// workers, sessions and transcripts arrive as `swarm://events` frames in the
// shapes the Rust core emits, and the webview chat streams from a routed
// Anthropic API (`anthropic-stream.ts`). No test-only code runs in the app.

test.describe("Transcript fixture", () => {
  test("an agent worker's chat shows every row kind from the event stream", async ({ page }) => {
    await installTauriIpc(page);
    const app = new SwarmApp(page);
    await app.open();
    const events = new EventLog();
    await emitEvents(page, events.agentWorker());
    const log = await openWorkerChat(app, AGENT_WORKER_NAME);

    // The user row is the composer's own optimistic bubble, as in production.
    await page.getByRole("textbox", { name: "Message Claude Code" }).fill("Fix the lint errors");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await emitEvents(page, events.turn(AGENT_WORKER, "turn-1", 1));
    await emitEvents(page, [events.pendingApproval(AGENT_WORKER, "turn-2")]);

    await expect(log.getByText("Fix the lint errors")).toBeVisible();
    await expect(log.getByText("Turn 1: check the lint output before editing.")).toBeAttached();
    await expect(log.getByText(/Turn 1: the linter reports/)).toBeAttached();
    await expect(log.getByRole("button", { name: "Tool Call: Read, Complete" })).toBeAttached();
    await expect(log.getByRole("button", { name: "Tool Call: Bash, Error" })).toBeAttached();
    await expect(log.getByText("Turn Complete, 8.4s, 3 Turns, $0.0123")).toBeAttached();
    const approval = log.getByRole("group", { name: "Permission Request: Bash" });
    await expect(approval).toBeVisible();
    await expect(approval.getByRole("button", { name: "Allow" })).toBeEnabled();
  });

  test("a webview worker's chat shows a streamed conversation and a pending approval", async ({
    page,
  }) => {
    await installTauriIpc(page, {
      config: { anthropic_api_key: "sk-ant-e2e" },
      replies: { agent_turn_started: 1, get_metrics: { cpuPercent: 12, perWorker: [] } },
    });
    await routeAnthropic(page);
    const app = new SwarmApp(page);
    await app.open();
    await emitEvents(page, [new EventLog().webviewWorker()]);
    const log = await openWorkerChat(app, CHAT_WORKER_NAME);

    await sendChatMessages(app, log, ["Summarize the worker", "Show the metrics"]);
    await expect(log.getByText(/Reply 1: the worker finished its/)).toBeVisible();
    await expect(
      log.getByRole("button", { name: "Tool Call: get_metrics, Complete" }),
    ).toBeVisible();
    await expect(log.getByText(/The metrics show/)).toBeVisible();

    await sendChatMessage(app, "Now read the file");
    await expect(page.getByRole("group", { name: "Approve read_file" })).toBeVisible();
  });

  // The body's fade needs a start style (`starting:opacity-0`): a closed card's content is skipped
  // (`content-visibility`), so on Chromium the body would otherwise read 1 from its first frame.
  // The card must be scrolled into view first, because an off-screen row is skipped entirely.
  for (const reducedMotion of ["no-preference", "reduce"] as const) {
    test(`a tool card's body ${reducedMotion === "reduce" ? "appears at once" : "fades in"} as it opens (${reducedMotion})`, async ({
      page,
    }) => {
      await page.emulateMedia({ reducedMotion });
      await installTauriIpc(page);
      const app = new SwarmApp(page);
      await app.open();
      await emitEvents(page, new EventLog().agentWorker());
      const log = await openWorkerChat(app, AGENT_WORKER_NAME);
      await emitEvents(page, new EventLog().turn(AGENT_WORKER, "turn-1", 1));

      const card = log.getByRole("button", { name: "Tool Call: Read, Complete" });
      await card.scrollIntoViewIfNeeded();
      await expect(card).toBeVisible();
      const samples = await card.evaluate(async (element) => {
        const body = element.nextElementSibling;
        if (!(element instanceof HTMLElement && body instanceof HTMLElement)) {
          throw new Error("the tool card has no body");
        }
        const seen: number[] = [];
        element.click();
        for (let frame = 0; frame < 12; frame += 1) {
          await new Promise((resolve) => requestAnimationFrame(resolve));
          seen.push(Number(getComputedStyle(body).opacity));
        }
        return seen;
      });

      if (reducedMotion === "reduce") {
        expect(samples[0]).toBe(1);
      } else {
        // Frames before React commits the open state read 0; the fade then climbs through (0, 1).
        expect(
          samples.some((opacity) => opacity > 0 && opacity < 1),
          `opacity per frame: ${samples}`,
        ).toBe(true);
      }
    });
  }
});
