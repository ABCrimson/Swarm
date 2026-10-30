import { describe, expect, it } from "vitest";
import type { ChatMessageParam } from "#lib/anthropic";
import { estimateTokens, fitTranscript, stripThinking } from "#lib/context-manager";

const thinking = { type: "thinking", thinking: "hmm", signature: "sig" } as const;

const exchange = (n: number, pad = ""): ChatMessageParam[] => [
  { role: "user", content: `question ${n}${pad}` },
  {
    role: "assistant",
    content: [thinking, { type: "tool_use", id: `tu_${n}`, name: "get_metrics", input: {} }],
  },
  {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: `tu_${n}`, content: "ok" }],
  },
  { role: "assistant", content: [{ type: "text", text: `answer ${n}` }] },
];

describe("context-manager", () => {
  it("estimates conservatively at ~3 characters per token", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcdef")).toBe(2);
    expect(estimateTokens("abcdefg")).toBe(3);
  });

  it("returns the transcript untouched when it fits", () => {
    const transcript = [...exchange(1), ...exchange(2)];
    const fitted = fitTranscript(transcript, 1_000_000);
    expect(fitted).toEqual({ messages: transcript, droppedExchanges: 0 });
  });

  it("drops whole leading exchanges — never splitting a tool_use from its tool_result — and strips thinking from the rest", () => {
    const transcript = [...exchange(1, "x".repeat(3000)), ...exchange(2), ...exchange(3)];
    const fitted = fitTranscript(transcript, 400);

    expect(fitted.droppedExchanges).toBe(1);
    expect(fitted.messages[0]).toEqual({ role: "user", content: "question 2" });
    expect(fitted.messages).toHaveLength(8);
    const blocks = fitted.messages.flatMap((m) =>
      m.role === "system" || typeof m.content === "string" ? [] : m.content,
    );
    expect(blocks.some((b) => b.type === "thinking")).toBe(false);
    expect(blocks.filter((b) => b.type === "tool_use")).toHaveLength(2);
    expect(blocks.filter((b) => b.type === "tool_result")).toHaveLength(2);
  });

  it("always keeps the newest exchange, even over budget", () => {
    const transcript = [...exchange(1), ...exchange(2, "y".repeat(5000))];
    const fitted = fitTranscript(transcript, 10);
    expect(fitted.droppedExchanges).toBe(1);
    expect(fitted.messages[0]).toEqual({ role: "user", content: `question 2${"y".repeat(5000)}` });
  });

  it("stripThinking drops messages left empty", () => {
    const transcript: ChatMessageParam[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: [thinking] },
      { role: "assistant", content: [thinking, { type: "text", text: "yo" }] },
    ];
    expect(stripThinking(transcript)).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "text", text: "yo" }] },
    ]);
  });
});
