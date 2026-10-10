/**
 * The webview AI chat engine: runs one worker's chat turns — the agentic
 * tool loop — outside React, writing everything it produces into the
 * worker's thread in `#store/message-history`. A turn therefore keeps
 * running, and its transcript stays, while the chat component is
 * unmounted (tab switches); the component only renders the thread and
 * calls {@link sendChatMessage} / {@link cancelChatTurn}.
 *
 * Per turn:
 * 1. The effective model is resolved (the worker's template-pinned model,
 *    else the global selection) and the user message appended to the
 *    thread's API transcript — trimmed to the context budget first, and
 *    stripped of thinking blocks when the system prompt or tool set
 *    changed since they were produced (both would otherwise replay
 *    signatures bound to a different prefix).
 * 2. The turn enqueues on `useAiStore` and waits for a stream slot.
 * 3. Each round streams one request, appends the response's content
 *    blocks to the transcript **verbatim** (thinking and signatures
 *    included), then acts on `stop_reason`: `tool_use` validates and runs
 *    the calls and appends one `tool_result` message; `pause_turn`
 *    continues; `max_tokens` / `model_context_window_exceeded` end the
 *    turn with a notice; a refusal ends it with the refusal's category.
 * 4. The history is always left valid for the next request: a turn that
 *    produced nothing is rolled back; a refusal rolls back only the
 *    refused round (the whole turn when it was the first round), so
 *    earlier rounds' tool calls — whose side effects already happened —
 *    stay on record; results of calls that ran are always recorded, even
 *    when the turn is cancelled while they run; any `tool_use` left
 *    without a result gets an error `tool_result`; and injected `system`
 *    messages no assistant turn answered are folded into the preceding
 *    user message (a mid-conversation system message must be last or
 *    followed by an assistant turn). A cancelled turn also discards its
 *    queued injections: an instruction never outlives the turn it was
 *    meant for.
 *
 * @module ai-chat
 */

import { getDefaultStore } from "jotai";
import type { ChatMessageParam, ChatResponse, Effort, StreamDelta } from "#lib/anthropic";
import {
  AiRefusalError,
  replayableContent,
  streamMessage,
  toAiRequestError,
  toolUseBlocks,
} from "#lib/anthropic";
import { turns } from "#lib/chat-turns";
import { estimateTokens, fitTranscript, stripThinking } from "#lib/context-manager";
import { CLAUDE_MODELS, getModelById, type ModelInfo } from "#lib/models";
import { agentTurnStarted } from "#lib/tauri";
import {
  denyPendingToolApprovals,
  executeTool,
  getAllAnthropicTools,
  type ToolProvenance,
} from "#lib/tools";
import { acquireStreamSlot, registerQueueAbort, releaseStreamSlot, useAiStore } from "#store/ai";
import {
  type ChatMessage,
  type ChatNotice,
  type ChatThread,
  type LiveTurn,
  useMessageHistoryStore,
} from "#store/message-history";
import { selectedModelAtom } from "#store/ui";
import { useWorkerAgentStore } from "#store/worker-agents";

/**
 * Chat effort. Explicit because the defaults differ: Opus 5.5 and Haiku 5.5
 * default to `medium`, Fable 5.1, Mythos 5.1 and Sonnet 5.5 to `high`
 * (effort page and models overview, 2026-10-10). `medium` is the
 * documented starting point for Opus 5.5 and Haiku 5.5 and a sound
 * cost/quality balance for an interactive orchestration chat on every model.
 */
const CHAT_EFFORT: Effort = "medium";

/** Streaming `max_tokens` for a chat round — room for adaptive thinking plus the reply (clamped per model). */
export const CHAT_MAX_TOKENS = 64_000;

/** Tool rounds per turn before the loop stops handing results back to the model. */
const MAX_TOOL_ROUNDS = 10;

// ── Thread helpers ───────────────────────────────────

function update(workerId: string, recipe: (thread: ChatThread) => ChatThread): void {
  useMessageHistoryStore.getState().updateThread(workerId, recipe);
}

function thread(workerId: string): ChatThread | undefined {
  return useMessageHistoryStore.getState().threads.get(workerId);
}

function patchLive(workerId: string, recipe: (live: LiveTurn) => LiveTurn): void {
  update(workerId, (t) => (t.live ? { ...t, live: recipe(t.live) } : t));
}

function nowIso(): string {
  return Temporal.Now.instant().round({ smallestUnit: "millisecond" }).toString();
}

/** The model a worker's next turn uses: its template-pinned model, else the global selection. */
function resolveChatModel(workerId: string): ModelInfo {
  const pinned = useWorkerAgentStore.getState().metadata.get(workerId)?.model;
  return CLAUDE_MODELS[pinned ?? getDefaultStore().get(selectedModelAtom)];
}

// ── Transcript helpers ───────────────────────────────

/** `tool_use` ids in the last assistant message that have no `tool_result` after them. */
function openToolUses(transcript: readonly ChatMessageParam[]): string[] {
  const last = transcript.at(-1);
  if (last?.role !== "assistant" || typeof last.content === "string") return [];
  return last.content.flatMap((block) => (block.type === "tool_use" ? [block.id] : []));
}

/** Appends an error `tool_result` for every unanswered `tool_use`, keeping the history valid. */
function closeOpenToolUses(
  transcript: readonly ChatMessageParam[],
  reason: string,
): ChatMessageParam[] {
  const open = openToolUses(transcript);
  if (open.length === 0) return [...transcript];
  return [
    ...transcript,
    {
      role: "user",
      content: open.map((id) => ({
        type: "tool_result" as const,
        tool_use_id: id,
        content: reason,
        is_error: true,
      })),
    },
  ];
}

/** A `system` message's instruction as a user text block, for places a system message cannot go. */
function operatorText(message: ChatMessageParam): { type: "text"; text: string } {
  const body =
    typeof message.content === "string"
      ? message.content
      : message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
  return { type: "text", text: `[Operator Instruction] ${body}` };
}

/**
 * The messages actually sent: mid-conversation `system` messages become
 * user text for models that do not accept them (a model switch within a
 * thread), so a history written for one model stays sendable to another.
 */
function forModel(transcript: readonly ChatMessageParam[], model: ModelInfo): ChatMessageParam[] {
  if (model.systemMessages) return [...transcript];
  return transcript.map((message) =>
    message.role === "system" ? { role: "user", content: [operatorText(message)] } : message,
  );
}

/**
 * Folds trailing `system` messages — injections delivered with tool
 * results whose next round was cancelled or failed, so no assistant turn
 * answered them — into the preceding user message as trailing text. The
 * API rejects a mid-conversation system message followed by a user
 * message, which is exactly what the next send would otherwise produce.
 */
function foldTrailingSystem(transcript: readonly ChatMessageParam[]): ChatMessageParam[] {
  const start = transcript.findLastIndex((message) => message.role !== "system") + 1;
  if (start === transcript.length) return [...transcript];
  const folded = transcript.slice(start).map(operatorText);
  const head = transcript.slice(0, start);
  const previous = head.at(-1);
  if (previous?.role !== "user") return [...head, { role: "user", content: folded }];
  const content =
    typeof previous.content === "string"
      ? [{ type: "text" as const, text: previous.content }]
      : previous.content;
  return [...head.slice(0, -1), { role: "user", content: [...content, ...folded] }];
}

/** A tool input as a display record (`{}` for anything that is not a plain object). */
function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Serializes a tool's result for the model and the transcript display. */
function resultText(data: unknown): string {
  if (typeof data === "string") return data;
  try {
    return JSON.stringify(data ?? null) ?? "null";
  } catch {
    return String(data);
  }
}

// ── Live streaming buffer ────────────────────────────

/** Batches streamed text/thinking into at most one store update per animation frame. */
class LiveBuffer {
  #text = "";
  #thinking = "";
  #frame: number | undefined;
  readonly #workerId: string;

  constructor(workerId: string) {
    this.#workerId = workerId;
  }

  push(delta: { readonly text?: string; readonly thinking?: string }): void {
    this.#text += delta.text ?? "";
    this.#thinking += delta.thinking ?? "";
    this.#frame ??= requestAnimationFrame(() => this.flush());
  }

  flush(): void {
    if (this.#frame !== undefined) cancelAnimationFrame(this.#frame);
    this.#frame = undefined;
    if (!this.#text && !this.#thinking) return;
    const text = this.#text;
    const thinking = this.#thinking;
    this.#text = "";
    this.#thinking = "";
    patchLive(this.#workerId, (live) => ({
      ...live,
      text: live.text + text,
      thinking: live.thinking + thinking,
    }));
  }
}

// ── The turn ─────────────────────────────────────────

interface TurnOutcome {
  notice?: ChatNotice;
  /**
   * Transcript length to roll back to, or `null` to keep everything: the
   * turn's own user message while nothing usable was produced, the
   * refused round's start on a refusal.
   */
  rollbackTo: number | null;
  /** The turn was cancelled: its queued injections are dropped, never replayed by a later turn. */
  discardInjections?: boolean;
}

/**
 * Streams one round, feeding its deltas into the live turn, and returns
 * the final message.
 */
async function streamRound(
  workerId: string,
  model: ModelInfo,
  system: string | undefined,
  tools: ReturnType<typeof getAllAnthropicTools>,
  buffer: LiveBuffer,
  signal: AbortSignal,
): Promise<ChatResponse> {
  const stream = streamMessage(
    {
      model: model.id,
      maxTokens: CHAT_MAX_TOKENS,
      messages: forModel(thread(workerId)?.transcript ?? [], model),
      system,
      tools,
      effort: CHAT_EFFORT,
      cache: true,
    },
    signal,
  );
  for (;;) {
    const step = await stream.next();
    if (step.done) return step.value;
    applyDelta(workerId, step.value, buffer);
  }
}

function applyDelta(workerId: string, delta: StreamDelta, buffer: LiveBuffer): void {
  switch (delta.type) {
    case "text":
      buffer.push({ text: delta.content });
      break;
    case "thinking":
      buffer.push({ thinking: delta.thinking });
      break;
    case "fallback":
      buffer.flush();
      patchLive(workerId, (live) => ({ ...live, servedBy: delta.to }));
      break;
    case "tool_use": {
      const { id, toolName, partialInput, complete } = delta.toolUse;
      if (!complete && partialInput !== "") return;
      buffer.flush();
      patchLive(workerId, (live) => {
        const existing = live.toolCalls.find((call) => call.id === id);
        if (!complete) {
          return existing
            ? live
            : { ...live, toolCalls: [...live.toolCalls, { id, name: toolName, input: {} }] };
        }
        let input: Record<string, unknown> = {};
        try {
          input = asRecord(JSON.parse(partialInput || "{}"));
        } catch {
          // Shown as `{}` until the final message carries the SDK's parse.
        }
        return {
          ...live,
          toolCalls: live.toolCalls.map((call) => (call.id === id ? { ...call, input } : call)),
        };
      });
      break;
    }
  }
}

async function runTurn(workerId: string, userText: string): Promise<void> {
  const model = resolveChatModel(workerId);
  const itemId = crypto.randomUUID();
  const controller = new AbortController();
  const { signal } = controller;
  turns.set(workerId, { controller, itemId });
  const unregisterAbort = registerQueueAbort(itemId, controller);
  // Every way a turn ends early (Stop, a queue Cancel, a killed worker) aborts this signal. A tool
  // call parked on its approval prompt would otherwise keep the turn, and its stream slot, forever.
  signal.addEventListener("abort", () => denyPendingToolApprovals(workerId), { once: true });
  const buffer = new LiveBuffer(workerId);

  const system = useWorkerAgentStore.getState().metadata.get(workerId)?.systemPrompt || undefined;
  const tools = getAllAnthropicTools();
  const prefixKey = JSON.stringify([system ?? "", tools]);
  const reserve = Math.min(CHAT_MAX_TOKENS, model.maxOutputTokens) + estimateTokens(prefixKey);

  const userMessage: ChatMessage = {
    id: crypto.randomUUID(),
    role: "user",
    content: userText,
    timestamp: nowIso(),
  };

  // Index of this turn's user message: rolling back to it drops the turn.
  let turnBase = 0;
  update(workerId, (t) => {
    const previous =
      t.prefixKey !== null && t.prefixKey !== prefixKey
        ? stripThinking(t.transcript)
        : t.transcript;
    const fitted = fitTranscript(
      [...previous, { role: "user", content: userText }],
      model.contextWindow - reserve,
    );
    turnBase = fitted.messages.length - 1;
    return {
      ...t,
      messages: [...t.messages, userMessage],
      transcript: fitted.messages,
      prefixKey,
      error: null,
      live: { itemId, phase: "queued", text: "", thinking: "", toolCalls: [] },
    };
  });

  useAiStore.getState().enqueue({
    id: itemId,
    priority: "normal",
    workerId,
    messages: [],
    status: "pending",
  });

  const outcome: TurnOutcome = { rollbackTo: turnBase };
  let error: string | null = null;
  // Where the current round's output starts (its refusal rolls back to here).
  let roundStart = turnBase;

  try {
    await acquireStreamSlot(itemId, signal);
    patchLive(workerId, (live) => ({ ...live, phase: "streaming" }));

    // One agent_turn_started per turn: its seq is the causeSeq every
    // tool call in this turn cites. Without an IPC bridge the turn still
    // runs, attributed by worker id alone.
    let causeSeq: number | undefined;
    try {
      causeSeq = await agentTurnStarted(workerId, model.id, itemId);
    } catch (err) {
      console.warn(
        "ai-chat: agent_turn_started failed; this turn's tool calls carry no causeSeq",
        err,
      );
    }
    const provenance: ToolProvenance = { originWorker: workerId, causeSeq };

    for (let round = 0; ; round++) {
      signal.throwIfAborted();
      if (round > 0) roundStart = thread(workerId)?.transcript.length ?? roundStart;
      const message = await streamRound(workerId, model, system, tools, buffer, signal);
      buffer.flush();

      const content = replayableContent(message);
      if (content.length > 0) {
        update(workerId, (t) => ({
          ...t,
          transcript: [...t.transcript, { role: "assistant", content }],
        }));
        outcome.rollbackTo = null;
      }
      // A refusal fallback that served this round (sticky routing emits
      // no fallback block, only a fallback_message usage iteration).
      if (message.usage.iterations?.some((entry) => entry.type === "fallback_message")) {
        patchLive(workerId, (live) => ({ ...live, servedBy: message.model }));
      }

      if (message.stop_reason === "pause_turn") continue;

      if (message.stop_reason === "max_tokens") {
        outcome.notice = { tone: "warning", text: "Reply Cut Off At The Output Token Limit" };
        break;
      }
      if (message.stop_reason === "model_context_window_exceeded") {
        outcome.notice = {
          tone: "warning",
          text: "Context Window Full — Start A New Chat To Continue",
        };
        break;
      }
      if (message.stop_reason !== "tool_use") break;

      const calls = toolUseBlocks(message);
      if (round + 1 >= MAX_TOOL_ROUNDS) {
        outcome.notice = {
          tone: "warning",
          text: `Stopped After ${MAX_TOOL_ROUNDS} Tool Rounds`,
        };
        break;
      }

      // The final message's parsed inputs replace the streamed previews
      // (and add any call whose deltas never arrived).
      patchLive(workerId, (live) => ({
        ...live,
        phase: "tools",
        toolCalls: [
          ...live.toolCalls.filter((call) => !calls.some((block) => block.id === call.id)),
          ...calls.map((block) => ({
            id: block.id,
            name: block.name,
            input: asRecord(block.input),
          })),
        ],
      }));

      // The calls of one response are independent (parallel tool use), so
      // they run concurrently; their results go back in one message.
      const results = await Promise.all(
        calls.map(async (call) => {
          const result = await executeTool(call.name, call.input, provenance);
          const text = result.success ? resultText(result.data) : (result.error ?? "Unknown Error");
          patchLive(workerId, (live) => ({
            ...live,
            toolCalls: live.toolCalls.map((c) =>
              c.id === call.id ? { ...c, result: text, isError: !result.success } : c,
            ),
          }));
          return { id: call.id, text, isError: !result.success };
        }),
      );
      // The results are recorded even when the turn was cancelled while
      // the calls ran: they executed, and the model must know their side
      // effects happened. A cancelled turn's injections are not delivered
      // (finishTurn discards them).
      const aborted = signal.aborted;

      // Instructions injected mid-turn ride along with the tool results:
      // as a mid-conversation system message where the model accepts one
      // (operator authority, cache-friendly), else as trailing text.
      const injections = aborted ? [] : (thread(workerId)?.injections ?? []);
      update(workerId, (t) => {
        const toolResults: ChatMessageParam = {
          role: "user",
          content: [
            ...results.map((r) => ({
              type: "tool_result" as const,
              tool_use_id: r.id,
              content: r.text,
              is_error: r.isError,
            })),
            ...(model.systemMessages
              ? []
              : injections.map((text) => ({ type: "text" as const, text }))),
          ],
        };
        return {
          ...t,
          injections: aborted ? t.injections : [],
          transcript: [
            ...t.transcript,
            toolResults,
            ...(model.systemMessages
              ? injections.map((text): ChatMessageParam => ({ role: "system", content: text }))
              : []),
          ],
          live:
            t.live && !aborted
              ? { ...t.live, phase: "streaming", text: withGap(t.live.text) }
              : t.live,
        };
      });
      signal.throwIfAborted();
    }
  } catch (err) {
    buffer.flush();
    if (err instanceof AiRefusalError) {
      // Only the refused round goes: earlier rounds' tool calls ran.
      outcome.rollbackTo = roundStart;
      outcome.notice = {
        tone: "error",
        text: err.explanation ? `${err.message}: ${err.explanation}` : err.message,
      };
    } else if (signal.aborted) {
      outcome.notice = { tone: "info", text: "Cancelled" };
      outcome.discardInjections = true;
    } else {
      const failure = toAiRequestError(err);
      // A client-side failure has no request id to trace: its stack and cause survive only in the console.
      if (failure.kind === "unknown" || failure.kind === "stream") {
        console.error("ai-chat: turn failed", failure);
      }
      error = failure.message;
    }
  } finally {
    buffer.flush();
    finishTurn(workerId, itemId, model, outcome, error);
    unregisterAbort();
    releaseStreamSlot(itemId);
    useAiStore.getState().dequeue(itemId);
    if (turns.get(workerId)?.itemId === itemId) turns.delete(workerId);
  }

  // Injections that arrived too late for a tool round become the next turn
  // (a cancelled turn's were already discarded by finishTurn).
  const leftover = thread(workerId)?.injections ?? [];
  if (leftover.length > 0 && !signal.aborted) {
    update(workerId, (t) => ({ ...t, injections: [] }));
    sendChatMessage(workerId, leftover.join("\n\n"));
  }
}

/** Separates the next round's streamed text from the previous round's. */
function withGap(text: string): string {
  return text && !text.endsWith("\n\n") ? `${text}\n\n` : text;
}

/** Commits the live turn as an assistant message and leaves the transcript valid. */
function finishTurn(
  workerId: string,
  itemId: string,
  model: ModelInfo,
  outcome: TurnOutcome,
  error: string | null,
): void {
  update(workerId, (t) => {
    const live = t.live?.itemId === itemId ? t.live : null;
    const kept =
      outcome.rollbackTo === null ? t.transcript : t.transcript.slice(0, outcome.rollbackTo);
    const transcript = closeOpenToolUses(
      foldTrailingSystem(kept),
      "Not Run — The Turn Ended Before This Call Executed.",
    );
    const discarded = outcome.discardInjections ? t.injections.length : 0;
    const notice: ChatNotice | undefined =
      discarded > 0 && outcome.notice
        ? {
            ...outcome.notice,
            text: `${outcome.notice.text} — ${discarded === 1 ? "Queued Instruction" : `${discarded} Queued Instructions`} Discarded`,
          }
        : outcome.notice;

    const text = live?.text.trim() ?? "";
    const toolCalls = live?.toolCalls.length ? [...live.toolCalls] : undefined;
    const servedBy =
      live?.servedBy && live.servedBy !== model.id
        ? (getModelById(live.servedBy)?.label ?? live.servedBy)
        : undefined;
    const reply: ChatMessage | null =
      text || toolCalls || notice || live?.thinking
        ? {
            id: crypto.randomUUID(),
            role: "assistant",
            content: text,
            timestamp: nowIso(),
            ...(toolCalls ? { toolCalls } : {}),
            ...(live?.thinking ? { thinking: live.thinking.trim() } : {}),
            ...(notice ? { notice } : {}),
            ...(servedBy ? { servedBy } : {}),
          }
        : null;

    return {
      ...t,
      transcript,
      injections: discarded > 0 ? [] : t.injections,
      messages: reply ? [...t.messages, reply] : t.messages,
      live: live ? null : t.live,
      error,
    };
  });
}

// ── Public API ───────────────────────────────────────

/**
 * Starts a chat turn for `workerId` with `text` as the user message.
 * Returns `false` (and does nothing) when the text is blank or the
 * worker already has a turn in flight.
 */
export function sendChatMessage(workerId: string, text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || turns.has(workerId)) return false;
  void runTurn(workerId, trimmed);
  return true;
}

/**
 * Injects an operator instruction into `workerId`'s conversation. While a
 * turn is running it is delivered with that turn's next tool results
 * (the model sees it mid-loop); otherwise — or if the turn ends first —
 * it is sent as the next user turn. Cancelling the turn discards it.
 */
export function injectInstruction(workerId: string, text: string): "sent" | "queued" | "ignored" {
  const trimmed = text.trim();
  if (!trimmed) return "ignored";
  if (!turns.has(workerId)) return sendChatMessage(workerId, trimmed) ? "sent" : "ignored";
  update(workerId, (t) => ({ ...t, injections: [...t.injections, trimmed] }));
  return "queued";
}

export { cancelChatTurn, isChatTurnRunning } from "#lib/chat-turns";

/** Forgets an idle worker's conversation (starts a new chat). Returns `false` while a turn runs. */
export function clearChat(workerId: string): boolean {
  if (turns.has(workerId)) return false;
  useMessageHistoryStore.getState().clearWorker(workerId);
  return true;
}
