/**
 * The registry of in-flight webview chat turns, kept apart from the chat
 * engine (`#lib/ai-chat`) so the startup worker-event hook can cancel a turn
 * without loading the chat engine and the Anthropic SDK. A turn exists only
 * after `#lib/ai-chat` has loaded and registered it here.
 */

/** In-flight turns by worker id. */
export const turns = new Map<
  string,
  { readonly controller: AbortController; readonly itemId: string }
>();

/** Cancels `workerId`'s in-flight turn, whether it is queued, streaming or running tools. */
export function cancelChatTurn(workerId: string): void {
  turns.get(workerId)?.controller.abort();
}

/** Whether `workerId` has a turn in flight. */
export function isChatTurnRunning(workerId: string): boolean {
  return turns.has(workerId);
}
