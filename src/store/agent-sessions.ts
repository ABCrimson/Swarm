/**
 * Live provider-adapter agent sessions (Claude Code, Codex) and their
 * chat transcripts, fed by the `agent_*` event family through
 * `#hooks/useAgentSessionEvents` (mounted once at the app root).
 *
 * - `sessions`: one entry per worker with a live session, from
 *   `agent_session_started` / `agent_session_exited`. An entry's
 *   presence is what makes `WorkerAIPanel` render `AgentChat` (turns go
 *   to the session via `agent_send_turn`) instead of the webview
 *   `AIChat`; a worker's PTY and its agent session are independent
 *   resources.
 * - `transcripts`: each session's chat, reduced from its events here
 *   rather than inside `AgentChat`, so it survives the chat unmounting
 *   (tab switches) and is rebuilt from the backfilled event log.
 *
 * Every transcript item traces to a real `agent_*` event, except the
 * caller's own optimistic outgoing message — nothing is fabricated.
 *
 * @module agent-sessions
 */

import { type Draft, enableMapSet } from "immer";
import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import type {
  AgentBlockPayload,
  AgentPermissionRequestPayload,
  AgentSessionStartedPayload,
  AgentToolCallPayload,
  AgentToolResultPayload,
  AgentTurnDeltaPayload,
  AgentTurnSettledPayload,
  PermissionDecision,
} from "#lib/agent-events";

// Required for immer producers that mutate native Map instances (below).
enableMapSet();

/**
 * Where a permission request stands. `report`: the provider already
 * decided (the request carries a `suggestedDecision`, e.g. a denial
 * Claude Code reports after the fact); `pending`: the provider is
 * blocked waiting for an answer (`interactivePermissions`, no
 * `suggestedDecision`);
 * `answering`: an answer is in flight; `allow`/`deny`: answered;
 * `expired`: the turn settled before it was answered.
 */
export type PermissionState = "report" | "pending" | "answering" | PermissionDecision | "expired";

/** One row of an agent chat transcript. */
export type AgentTranscriptItem =
  | { readonly id: string; readonly kind: "user"; readonly text: string; readonly failed: boolean }
  | { readonly id: string; readonly kind: "block"; readonly payload: AgentBlockPayload }
  | {
      readonly id: string;
      readonly kind: "tool_call";
      readonly payload: AgentToolCallPayload;
      /** `null` until the matching `agent_tool_result` (same `toolUseId`) arrives. */
      readonly result: AgentToolResultPayload | null;
    }
  | {
      readonly id: string;
      readonly kind: "permission";
      readonly payload: AgentPermissionRequestPayload;
      readonly state: PermissionState;
    }
  | { readonly id: string; readonly kind: "settled"; readonly payload: AgentTurnSettledPayload };

/** Live, not-yet-finalized text of one `(turnId, blockIndex)` block, from `agent_turn_delta`. */
interface StreamingBlock {
  readonly turnId: string;
  readonly kind: string;
  readonly text: string;
}

/** One worker's agent chat. */
export interface AgentTranscript {
  readonly items: readonly AgentTranscriptItem[];
  /** In-progress blocks keyed `turnId:blockIndex`, replaced by their `agent_block` when finalized. */
  readonly streaming: ReadonlyMap<string, StreamingBlock>;
  /**
   * Turns admitted but not yet settled — a count, not a flag: queued
   * sends each await their own `agent_turn_settled`.
   */
  readonly pendingTurns: number;
  /**
   * The turn currently producing events — what Cancel targets.
   * `agent_send_turn` returns no turn id, but a session runs its turns
   * strictly in order, so the latest event's `turnId` is the running one.
   */
  readonly currentTurnId: string | null;
  /**
   * Optimistic user bubbles still waiting for their turn's first event,
   * oldest first: turns run in submission order, so the first event
   * with an unmapped `turnId` belongs to the oldest bubble here.
   */
  readonly unmappedBubbles: readonly string[];
  /** `turnId` → the user bubble that started it (to mark it failed on an error settle). */
  readonly turnBubbles: ReadonlyMap<string, string>;
}

/** The empty transcript every session starts from. */
const EMPTY_TRANSCRIPT: AgentTranscript = {
  items: [],
  streaming: new Map(),
  pendingTurns: 0,
  currentTurnId: null,
  unmappedBubbles: [],
  turnBubbles: new Map(),
};

/** An `agent_*` transcript event, as the bus delivers it (`seq` is its stable row id). */
export type AgentTranscriptEvent =
  | {
      readonly type: "agent_turn_delta";
      readonly seq: number;
      readonly payload: AgentTurnDeltaPayload;
    }
  | { readonly type: "agent_block"; readonly seq: number; readonly payload: AgentBlockPayload }
  | {
      readonly type: "agent_tool_call";
      readonly seq: number;
      readonly payload: AgentToolCallPayload;
    }
  | {
      readonly type: "agent_tool_result";
      readonly seq: number;
      readonly payload: AgentToolResultPayload;
    }
  | {
      readonly type: "agent_permission_request";
      readonly seq: number;
      readonly payload: AgentPermissionRequestPayload;
    }
  | {
      readonly type: "agent_turn_settled";
      readonly seq: number;
      readonly payload: AgentTurnSettledPayload;
    };

interface AgentSessionStoreState {
  readonly sessions: Map<string, AgentSessionStartedPayload>;
  readonly transcripts: Map<string, AgentTranscript>;
}

interface AgentSessionStoreActions {
  readonly setSession: (workerId: string, info: AgentSessionStartedPayload) => void;
  /** Drops a worker's session and its transcript (the chat falls back to the webview `AIChat`). */
  readonly removeSession: (workerId: string) => void;
  /** Reduces one `agent_*` event into its worker's transcript. */
  readonly applyEvent: (event: AgentTranscriptEvent) => void;
  /** Appends the caller's own message as an optimistic bubble and counts its turn as pending. */
  readonly addUserTurn: (workerId: string, bubbleId: string, text: string) => void;
  /** Reconciles a send the backend never admitted: no settle will come, so the bubble fails now. */
  readonly failUserTurn: (workerId: string, bubbleId: string) => void;
  /**
   * Moves a permission request (by `requestId`) to `state`. With `from`,
   * only a request still in that state moves — so an answer resolving
   * after the turn settled cannot overwrite `expired`. Returns whether
   * the request moved.
   */
  readonly setPermissionState: (
    workerId: string,
    requestId: string,
    state: PermissionState,
    from?: PermissionState,
  ) => boolean;
}

type TranscriptDraft = Draft<AgentTranscript>;

function streamKey(turnId: string, blockIndex: number): string {
  return `${turnId}:${blockIndex}`;
}

/** Maps `turnId` to the oldest unmapped bubble, once. */
function mapTurn(t: TranscriptDraft, turnId: string): void {
  if (t.turnBubbles.has(turnId)) return;
  const bubbleId = t.unmappedBubbles.shift();
  if (bubbleId) t.turnBubbles.set(turnId, bubbleId);
}

function reduce(
  t: TranscriptDraft,
  event: AgentTranscriptEvent,
  interactivePermissions: boolean,
): void {
  const id = `${event.seq}`;
  switch (event.type) {
    case "agent_turn_delta": {
      const { turnId, blockIndex, kind, text } = event.payload;
      t.currentTurnId = turnId;
      mapTurn(t, turnId);
      const key = streamKey(turnId, blockIndex);
      t.streaming.set(key, { turnId, kind, text: (t.streaming.get(key)?.text ?? "") + text });
      return;
    }
    case "agent_block": {
      const { turnId, blockIndex } = event.payload;
      t.currentTurnId = turnId;
      mapTurn(t, turnId);
      t.streaming.delete(streamKey(turnId, blockIndex));
      t.items.push({ id, kind: "block", payload: event.payload });
      return;
    }
    case "agent_tool_call":
      t.currentTurnId = event.payload.turnId;
      mapTurn(t, event.payload.turnId);
      t.items.push({ id, kind: "tool_call", payload: event.payload, result: null });
      return;
    case "agent_tool_result": {
      const result = event.payload;
      const index = t.items.findIndex(
        (item) => item.kind === "tool_call" && item.payload.toolUseId === result.toolUseId,
      );
      const target = t.items[index];
      if (target?.kind === "tool_call") {
        t.items[index] = { ...target, result };
      } else {
        // No matching call in this transcript (e.g. it predates the
        // backfill window): show the result honestly under an unknown
        // tool rather than dropping it or guessing a name.
        t.items.push({
          id,
          kind: "tool_call",
          payload: {
            workerId: result.workerId,
            turnId: result.turnId,
            toolUseId: result.toolUseId,
            name: "Unknown Tool",
            input: {},
          },
          result,
        });
      }
      return;
    }
    case "agent_permission_request": {
      const request = event.payload;
      mapTurn(t, request.turnId);
      // A request that carries a suggested decision reports one the
      // provider already made (a Claude Code denial, classified or not);
      // one without it, from a session with interactive permissions, is a
      // question the provider is blocked on until it is answered.
      const state: PermissionState =
        interactivePermissions && request.suggestedDecision == null ? "pending" : "report";
      t.items.push({ id, kind: "permission", payload: request, state });
      return;
    }
    case "agent_turn_settled": {
      const { turnId, status } = event.payload;
      mapTurn(t, turnId);
      t.items.push({ id, kind: "settled", payload: event.payload });
      // A settled (or cancelled) turn's unfinalized blocks are dead.
      for (const [key, block] of t.streaming) {
        if (block.turnId === turnId) t.streaming.delete(key);
      }
      // Its unanswered permission questions can no longer be answered.
      t.items = t.items.map((item) =>
        item.kind === "permission" &&
        item.payload.turnId === turnId &&
        (item.state === "pending" || item.state === "answering")
          ? { ...item, state: "expired" }
          : item,
      );
      t.pendingTurns = Math.max(0, t.pendingTurns - 1);
      t.currentTurnId = null;
      const bubbleId = t.turnBubbles.get(turnId);
      if (status === "error" && bubbleId) {
        t.items = t.items.map((item) =>
          item.id === bubbleId && item.kind === "user" ? { ...item, failed: true } : item,
        );
      }
      t.turnBubbles.delete(turnId);
      return;
    }
  }
}

function transcriptOf(
  transcripts: Map<string, TranscriptDraft>,
  workerId: string,
): TranscriptDraft {
  let t = transcripts.get(workerId);
  if (!t) {
    t = structuredClone(EMPTY_TRANSCRIPT) as TranscriptDraft;
    transcripts.set(workerId, t);
  }
  return t;
}

export const useAgentSessionStore = create<AgentSessionStoreState & AgentSessionStoreActions>()(
  immer((set) => ({
    sessions: new Map(),
    transcripts: new Map(),

    setSession(workerId, info) {
      set((s) => {
        s.sessions.set(workerId, info);
      });
    },

    removeSession(workerId) {
      set((s) => {
        s.sessions.delete(workerId);
        s.transcripts.delete(workerId);
      });
    },

    applyEvent(event) {
      set((s) => {
        const { workerId } = event.payload;
        const interactive = s.sessions.get(workerId)?.capabilities.interactivePermissions ?? false;
        reduce(transcriptOf(s.transcripts, workerId), event, interactive);
      });
    },

    addUserTurn(workerId, bubbleId, text) {
      set((s) => {
        const t = transcriptOf(s.transcripts, workerId);
        t.items.push({ id: bubbleId, kind: "user", text, failed: false });
        t.unmappedBubbles.push(bubbleId);
        t.pendingTurns += 1;
      });
    },

    failUserTurn(workerId, bubbleId) {
      set((s) => {
        const t = transcriptOf(s.transcripts, workerId);
        // Removed by id, never by position, so an earlier turn still
        // waiting for its first event keeps its own bubble.
        t.unmappedBubbles = t.unmappedBubbles.filter((id) => id !== bubbleId);
        t.pendingTurns = Math.max(0, t.pendingTurns - 1);
        t.items = t.items.map((item) =>
          item.id === bubbleId && item.kind === "user" ? { ...item, failed: true } : item,
        );
      });
    },

    setPermissionState(workerId, requestId, state, from) {
      let moved = false;
      set((s) => {
        const t = s.transcripts.get(workerId);
        if (!t) return;
        t.items = t.items.map((item) => {
          if (item.kind !== "permission" || item.payload.requestId !== requestId) return item;
          if (from !== undefined && item.state !== from) return item;
          moved = true;
          return { ...item, state };
        });
      });
      return moved;
    },
  })),
);

/** Subscribes a component to one worker's agent transcript. */
export function useAgentTranscript(workerId: string): AgentTranscript {
  return useAgentSessionStore((s) => s.transcripts.get(workerId)) ?? EMPTY_TRANSCRIPT;
}
