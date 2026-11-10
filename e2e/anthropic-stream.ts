import type { Page, Route } from "@playwright/test";

/**
 * A scripted Anthropic Messages API for the webview chat (`#lib/anthropic`
 * streams straight from the page to `api.anthropic.com`). Each request is
 * answered with a Server-Sent Events body in the documented streaming
 * shape (`message_start`, content blocks, `message_delta`,
 * `message_stop`), so the SDK's own stream parser and `#lib/ai-chat`
 * commit the turn exactly as they do against the real API.
 */

type Block =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "thinking"; readonly thinking: string }
  | {
      readonly type: "tool_use";
      readonly id: string;
      readonly name: string;
      readonly input: Record<string, unknown>;
    };

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "*",
  "access-control-allow-methods": "POST, OPTIONS",
};

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** One assistant message as the event stream the SDK parses. */
function messageStream(id: string, blocks: readonly Block[]): string {
  const toolUse = blocks.some((block) => block.type === "tool_use");
  const frames = [
    sse("message_start", {
      type: "message_start",
      message: {
        id,
        type: "message",
        role: "assistant",
        model: "claude-fable-5-2",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 120, output_tokens: 1 },
      },
    }),
  ];
  blocks.forEach((block, index) => {
    switch (block.type) {
      case "text":
        frames.push(
          sse("content_block_start", {
            type: "content_block_start",
            index,
            content_block: { type: "text", text: "" },
          }),
          sse("content_block_delta", {
            type: "content_block_delta",
            index,
            delta: { type: "text_delta", text: block.text },
          }),
        );
        break;
      case "thinking":
        frames.push(
          sse("content_block_start", {
            type: "content_block_start",
            index,
            content_block: { type: "thinking", thinking: "", signature: "" },
          }),
          sse("content_block_delta", {
            type: "content_block_delta",
            index,
            delta: { type: "thinking_delta", thinking: block.thinking },
          }),
          sse("content_block_delta", {
            type: "content_block_delta",
            index,
            delta: { type: "signature_delta", signature: "c2lnbmF0dXJl" },
          }),
        );
        break;
      case "tool_use":
        frames.push(
          sse("content_block_start", {
            type: "content_block_start",
            index,
            content_block: { type: "tool_use", id: block.id, name: block.name, input: {} },
          }),
          sse("content_block_delta", {
            type: "content_block_delta",
            index,
            delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) },
          }),
        );
        break;
    }
    frames.push(sse("content_block_stop", { type: "content_block_stop", index }));
  });
  frames.push(
    sse("message_delta", {
      type: "message_delta",
      delta: { stop_reason: toolUse ? "tool_use" : "end_turn", stop_sequence: null },
      usage: { output_tokens: 48 },
    }),
    sse("message_stop", { type: "message_stop" }),
  );
  return frames.join("");
}

/** The last message of a request body: what the turn is answering. */
function lastMessage(body: unknown): { role: string; content: unknown } | undefined {
  const messages = (body as { messages?: Array<{ role: string; content: unknown }> }).messages;
  return messages?.at(-1);
}

/**
 * Routes `api.anthropic.com` to a deterministic responder. A user message
 * containing "metrics" gets a `get_metrics` tool call (no approval: it
 * runs at once) and a message containing "read" gets a `read_file` call
 * (which waits on the approval prompt); the follow-up request carrying the
 * tool result, and every other message, get a short markdown answer.
 */
export async function routeAnthropic(page: Page): Promise<void> {
  let n = 0;
  await page.route("https://api.anthropic.com/**", async (route: Route) => {
    if (route.request().method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: CORS });
      return;
    }
    n += 1;
    const last = lastMessage(route.request().postDataJSON());
    const text = typeof last?.content === "string" ? last.content : JSON.stringify(last?.content);
    const isToolResult = text.includes('"tool_result"');
    const blocks: Block[] = isToolResult
      ? [{ type: "text", text: "The metrics show **2 workers** running; nothing is over budget." }]
      : text.includes("metrics")
        ? [
            { type: "text", text: "Checking the system metrics." },
            { type: "tool_use", id: `toolu_${n}`, name: "get_metrics", input: {} },
          ]
        : text.includes("read")
          ? [
              { type: "text", text: "I need to read the file first." },
              {
                type: "tool_use",
                id: `toolu_${n}`,
                name: "read_file",
                input: { path: "/work/repo/src/lib/format.ts" },
              },
            ]
          : [
              { type: "thinking", thinking: `Reply ${n}: answer briefly.` },
              {
                type: "text",
                text: `Reply ${n}: the worker finished its **lint pass**. Next step:\n\n- run \`pnpm test\`\n- ship the branch`,
              },
            ];
    await route.fulfill({
      status: 200,
      headers: { ...CORS, "content-type": "text/event-stream", "request-id": `req_${n}` },
      body: messageStream(`msg_${n}`, blocks),
    });
  });
}
