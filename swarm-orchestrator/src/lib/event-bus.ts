import * as z from "zod";
import { invoke, listen } from "#lib/tauri";

/** Ordered envelope for every backend event (mirrors Rust `DomainEvent`). */
export interface DomainEvent {
  readonly seq: number;
  readonly ts: number;
  readonly type: string;
  readonly payload: unknown;
}

const DomainEventSchema = z.object({
  seq: z.number(),
  ts: z.number(),
  type: z.string(),
  payload: z.unknown(),
});

const EVENT_CHANNEL = "swarm://events";
/** Server page size for events_since — a full page means "ask again". */
const PAGE_LIMIT = 5000;

type Handler = (e: DomainEvent) => void;

const handlers = new Map<string, Set<Handler>>();
const wildcard = new Set<Handler>();
let lastSeq = 0;
let backfilling = false;
/** Live events that arrive while a backfill is in flight — flushed seq-sorted after. */
let pending: DomainEvent[] = [];

/** Subscribe to one event type ("*" for all). Returns unsubscribe. */
export function onEvent(type: string, handler: Handler): () => void {
  const set = type === "*" ? wildcard : (handlers.get(type) ?? new Set<Handler>());
  if (type !== "*") handlers.set(type, set);
  set.add(handler);
  return () => set.delete(handler);
}

function dispatch(e: DomainEvent): void {
  if (e.seq <= lastSeq) return; // already seen (live/backfill race)
  lastSeq = e.seq;
  for (const h of handlers.get(e.type) ?? []) h(e);
  for (const h of wildcard) h(e);
}

async function backfill(afterSeq: number): Promise<void> {
  if (backfilling) return;
  backfilling = true;
  try {
    let cursor = afterSeq;
    for (;;) {
      const page = await invoke<DomainEvent[]>("events_since", { afterSeq: cursor });
      for (const raw of page) {
        const parsed = DomainEventSchema.safeParse(raw);
        if (parsed.success) dispatch(parsed.data as DomainEvent);
      }
      if (page.length < PAGE_LIMIT) break;
      cursor = page[page.length - 1]?.seq ?? cursor;
    }
  } catch (err) {
    console.error("event-bus backfill failed:", err);
  } finally {
    backfilling = false;
    const toFlush = pending.splice(0).sort((a, b) => a.seq - b.seq);
    for (const e of toFlush) dispatch(e);
  }
}

/**
 * Connects the single ordered event stream. Call exactly once at app
 * bootstrap. Gaps in seq trigger a persisted-event backfill; ephemeral
 * events (worker output, metrics, logs) are not persisted and are
 * accepted as lost across a gap.
 */
export async function connectEventBus(): Promise<() => void> {
  return listen<unknown>(EVENT_CHANNEL, (raw) => {
    const parsed = DomainEventSchema.safeParse(raw);
    if (!parsed.success) {
      console.error("event-bus: invalid envelope", parsed.error);
      return;
    }
    const e = parsed.data as DomainEvent;
    if (backfilling) {
      pending.push(e);
      return;
    }
    if (lastSeq > 0 && e.seq > lastSeq + 1) {
      pending.push(e);
      void backfill(lastSeq);
      return;
    }
    dispatch(e);
  });
}

/** Awaits the first event matching `predicate` — the receipt primitive. */
export function waitFor(
  predicate: (e: DomainEvent) => boolean,
  timeoutMs = 5000,
): Promise<DomainEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error(`waitFor timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    const off = onEvent("*", (e) => {
      if (predicate(e)) {
        clearTimeout(timer);
        off();
        resolve(e);
      }
    });
  });
}

/** Test-only: clears subscriptions and seq tracking. */
export function resetEventBus(): void {
  handlers.clear();
  wildcard.clear();
  lastSeq = 0;
  backfilling = false;
  pending = [];
}
