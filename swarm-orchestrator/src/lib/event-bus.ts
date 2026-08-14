import * as z from "zod";
import { invoke, listen } from "#lib/tauri";

/**
 * Ordered envelope for every backend event (mirrors Rust `DomainEvent`).
 *
 * `originWorker`/`causeSeq` are the causal-attribution fields Phase 2
 * added on the Rust side (`Provenance`, `skip_serializing_if`): absent
 * (not `null`) on the wire when unattributed, present when the engine
 * recorded a real cause. `originWorker` is the CAUSER; a payload's own
 * `workerId` is the SUBJECT — for a tool-driven spawn the two differ,
 * and that difference is the causal edge (see `docs/architecture.md`).
 */
export interface DomainEvent {
  readonly seq: number;
  readonly ts: number;
  readonly originWorker?: string;
  readonly causeSeq?: number;
  readonly type: string;
  readonly payload: unknown;
}

const DomainEventSchema = z.object({
  seq: z.number(),
  ts: z.number(),
  // MANDATORY, not cosmetic: this schema is non-strict (extra keys are
  // stripped by default), so a stamped envelope's originWorker/causeSeq
  // would be silently dropped before dispatch() ever saw them without
  // these two fields declared explicitly.
  originWorker: z.string().optional(),
  causeSeq: z.number().optional(),
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
  for (const h of handlers.get(e.type) ?? []) {
    try {
      h(e);
    } catch (err) {
      console.error("event-bus: handler threw", err);
    }
  }
  for (const h of wildcard) {
    try {
      h(e);
    } catch (err) {
      console.error("event-bus: handler threw", err);
    }
  }
}

/**
 * Gap check + dispatch/buffer — the single decision point for every
 * incoming event, live or replayed from a backfill flush. Keeping both
 * callers on this one path is what makes a gap discovered mid-flush (or
 * a gap left behind by a failed backfill) self-heal the same way a live
 * gap does.
 */
function handleIncoming(e: DomainEvent): void {
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
}

async function backfill(afterSeq: number): Promise<void> {
  if (backfilling) return;
  backfilling = true;
  // `true` only when a real (non-error) `events_since` call comes back
  // empty — i.e. persistence itself confirms nothing exists past
  // `cursor` right now. `events_since` is authoritative: it either
  // throws (handled below, and must NOT trigger the skip-ahead logic —
  // a failed call proves nothing) or returns the complete truth for
  // that range. An empty non-error result means the remaining gap is
  // ephemeral by design (e.g. an all-terminal-source `worker_input`
  // stretch, or metrics/log-only traffic) — nothing is being withheld,
  // there is simply nothing persisted to backfill.
  let confirmedNothingPersisted = false;
  try {
    let cursor = afterSeq;
    for (;;) {
      const page = await invoke<DomainEvent[]>("events_since", { afterSeq: cursor });
      if (page.length === 0) {
        confirmedNothingPersisted = true;
        break;
      }
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
    // Ephemeral-gap wedge fix: an empty page proved nothing is
    // persisted past `lastSeq`, but `lastSeq` itself never advances on
    // its own — without this, every subsequent live/flushed event would
    // re-detect "the same" already-confirmed-empty gap and re-trigger
    // backfill forever (a real, silent wedge — no crash, no error, just
    // an unbounded stream of futile events_since round-trips for the
    // life of the app). Jump lastSeq to just before the earliest event
    // we're about to flush — anchoring to a concrete, already-in-hand
    // seq (never a guess) so dispatch()'s own `e.seq <= lastSeq` dedup
    // check can't accidentally swallow it.
    if (confirmedNothingPersisted && toFlush.length > 0 && toFlush[0].seq > lastSeq + 1) {
      console.debug(
        `event-bus: gap after seq ${lastSeq} is entirely ephemeral — skipping ahead to seq ${toFlush[0].seq}`,
      );
      lastSeq = toFlush[0].seq - 1;
    }
    // Route flushed events through the same gap-check path as live events:
    // on success this catches a gap that opened during the backfill (and
    // re-triggers a follow-up backfill); on failure lastSeq was never
    // advanced past the gap, so the first pending event re-detects it and
    // retries — the failed attempt is never silently swallowed.
    for (const e of toFlush) handleIncoming(e);
  }
}

/**
 * Connects the single ordered event stream. Call exactly once at app
 * bootstrap. Gaps in seq trigger a persisted-event backfill; ephemeral
 * events (worker output, metrics, logs) are not persisted and are
 * accepted as lost across a gap. A failed backfill is retried when the
 * next event arrives (there is no independent retry timer), so a gap
 * can stay open while the app is fully idle.
 */
export async function connectEventBus(): Promise<() => void> {
  return listen<unknown>(EVENT_CHANNEL, (raw) => {
    const parsed = DomainEventSchema.safeParse(raw);
    if (!parsed.success) {
      console.error("event-bus: invalid envelope", parsed.error);
      return;
    }
    handleIncoming(parsed.data as DomainEvent);
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
