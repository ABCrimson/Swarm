import type { KeyboardEvent } from "react";

/**
 * Home and End for a `column-reverse` transcript scroller (`role="log"` in
 * AgentChat and AIChat), where scrollTop 0 is the newest row and the oldest
 * is at `-scrollHeight`. Chromium's native Home and End scroll by the
 * estimated height of `content-visibility: auto` rows that never rendered and
 * stop short of the end; one jump to the extreme reaches it in one press on
 * every engine. Alt, Shift and Meta combinations keep their native meaning.
 */
export function onTranscriptKeyDown(e: KeyboardEvent<HTMLDivElement>): void {
  if (e.altKey || e.shiftKey || e.metaKey) return;
  const el = e.currentTarget;
  if (e.key === "Home") {
    e.preventDefault();
    el.scrollTo({ top: -el.scrollHeight, behavior: "instant" });
  } else if (e.key === "End") {
    e.preventDefault();
    el.scrollTo({ top: 0, behavior: "instant" });
  }
}
