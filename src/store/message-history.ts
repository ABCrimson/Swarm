/**
 * Per-worker AI chat threads — the webview chat's source of truth, kept
 * outside React so a conversation (and a turn still running) survives
 * the chat unmounting on a tab switch.
 *
 * A thread holds two views of one conversation:
 * - `messages`: the display/export transcript (`ChatMessage`, a superset
 *   of `AiMessage`, so session export keeps working through
 *   {@link MessageHistoryActions.getMessages});
 * - `transcript`: the Messages API history, replayed verbatim each
 *   request — full content blocks, thinking signatures included — and
 *   only ever appended to, except where `#lib/ai-chat` deliberately
 *   trims it (context budget, rolled-back turns).
 *
 * Threads are LRU-evicted beyond `maxWorkers` (the Chat History Worker
 * Cap setting, default `DEFAULT_APP_SETTINGS.historyMaxWorkers`); a thread
 * with a turn in flight is never evicted.
 *
 * @module message-history
 */

import { create } from "zustand";
import type { ChatMessageParam } from "#lib/anthropic";
import type { AiMessage } from "#store/types";
import { DEFAULT_APP_SETTINGS } from "#store/ui";

/** Display messages kept per worker; older ones scroll out of the visible history. */
const MAX_MESSAGES_PER_WORKER = 200;

/** One tool call as displayed: its input, and its result once it ran. */
export interface ChatToolCall {
  readonly id: string;
  readonly name: string;
  readonly input: Record<string, unknown>;
  readonly result?: string;
  readonly isError?: boolean;
}

/** A status line attached to an assistant message (cut off, declined, cancelled, …). */
export interface ChatNotice {
  readonly tone: "info" | "warning" | "error";
  readonly text: string;
}

/** A display message: an `AiMessage` plus the chat's own presentation fields. */
export interface ChatMessage extends Omit<AiMessage, "toolCalls"> {
  readonly toolCalls?: ChatToolCall[];
  /** The model's summarized thinking for this reply, when it streamed any. */
  readonly thinking?: string;
  readonly notice?: ChatNotice;
  /** The model that actually answered, when it differs from the one requested (refusal fallback). */
  readonly servedBy?: string;
}

/** The in-flight turn's live, not-yet-committed output. */
export interface LiveTurn {
  /** The turn's `useAiStore` queue item. */
  readonly itemId: string;
  /** `queued`: waiting for a stream slot; `streaming`: the model is writing; `tools`: running tool calls. */
  readonly phase: "queued" | "streaming" | "tools";
  readonly text: string;
  readonly thinking: string;
  readonly toolCalls: readonly ChatToolCall[];
  readonly servedBy?: string;
}

/** One worker's chat. */
export interface ChatThread {
  readonly messages: readonly ChatMessage[];
  readonly transcript: readonly ChatMessageParam[];
  /**
   * Fingerprint of the `system` prompt and `tools` the transcript's
   * thinking blocks were produced under — a change means those blocks no
   * longer match their prefix and must be stripped before replay.
   */
  readonly prefixKey: string | null;
  readonly live: LiveTurn | null;
  readonly error: string | null;
  /** Instructions injected while a turn runs, delivered after its next tool round. */
  readonly injections: readonly string[];
}

/** The empty thread every worker starts from. */
export const EMPTY_THREAD: ChatThread = {
  messages: [],
  transcript: [],
  prefixKey: null,
  live: null,
  error: null,
  injections: [],
};

const NO_MESSAGES: readonly AiMessage[] = [];

interface MessageHistoryState {
  readonly threads: ReadonlyMap<string, ChatThread>;
  /** Most recently used worker first. */
  readonly lruOrder: readonly string[];
  /** Live LRU cap — driven by the Chat History Worker Cap setting. */
  readonly maxWorkers: number;
}

interface MessageHistoryActions {
  /** A worker's display messages (a stable empty array when it has none). */
  readonly getMessages: (workerId: string) => readonly AiMessage[];
  /** Applies `recipe` to a worker's thread (created on first use) and marks it most recently used. */
  readonly updateThread: (workerId: string, recipe: (thread: ChatThread) => ChatThread) => void;
  /** Drops one worker's thread. */
  readonly clearWorker: (workerId: string) => void;
  /** Drops every thread. */
  readonly clearAll: () => void;
  /** Updates the LRU cap, evicting least-recently-used idle threads if it shrank. */
  readonly setMaxWorkers: (max: number) => void;
}

/** Evicts least-recently-used idle threads until at most `max` remain. */
function evict(
  threads: Map<string, ChatThread>,
  lruOrder: readonly string[],
  max: number,
): string[] {
  const order = [...lruOrder];
  for (let i = order.length - 1; i >= 0 && order.length > max; i--) {
    const id = order[i];
    if (id !== undefined && !threads.get(id)?.live) {
      threads.delete(id);
      order.splice(i, 1);
    }
  }
  return order;
}

export const useMessageHistoryStore = create<MessageHistoryState & MessageHistoryActions>()(
  (set, get) => ({
    threads: new Map(),
    lruOrder: [],
    maxWorkers: DEFAULT_APP_SETTINGS.historyMaxWorkers,

    getMessages(workerId) {
      return get().threads.get(workerId)?.messages ?? NO_MESSAGES;
    },

    updateThread(workerId, recipe) {
      set((s) => {
        const threads = new Map(s.threads);
        const next = recipe(threads.get(workerId) ?? EMPTY_THREAD);
        threads.set(
          workerId,
          next.messages.length > MAX_MESSAGES_PER_WORKER
            ? { ...next, messages: next.messages.slice(-MAX_MESSAGES_PER_WORKER) }
            : next,
        );
        const touched = [workerId, ...s.lruOrder.filter((id) => id !== workerId)];
        return { threads, lruOrder: evict(threads, touched, s.maxWorkers) };
      });
    },

    clearWorker(workerId) {
      set((s) => {
        const threads = new Map(s.threads);
        threads.delete(workerId);
        return { threads, lruOrder: s.lruOrder.filter((id) => id !== workerId) };
      });
    },

    clearAll() {
      set({ threads: new Map(), lruOrder: [] });
    },

    setMaxWorkers(max) {
      set((s) => {
        const threads = new Map(s.threads);
        return { maxWorkers: max, threads, lruOrder: evict(threads, s.lruOrder, max) };
      });
    },
  }),
);

/** Subscribes a component to one worker's chat thread. */
export function useChatThread(workerId: string): ChatThread {
  return useMessageHistoryStore((s) => s.threads.get(workerId)) ?? EMPTY_THREAD;
}
