import * as z from "zod";
import {
  EVENT_PAYLOAD_SCHEMAS,
  type EventPayload,
  type EventType,
  isEventType,
} from "#lib/event-payloads";
import { invoke, listen } from "#lib/tauri";

export type { EventPayload, EventType } from "#lib/event-payloads";

/**
 * The ordered envelope of every backend event (Rust `DomainEvent`).
 * Exported so other seams (e.g. `CausalityPanel`'s single-row
 * `events_since` lookups) validate against the same shape.
 *
 * `originWorker`/`causeSeq` are causal attribution (Rust `Provenance`,
 * `skip_serializing_if`): absent, not `null`, when unattributed.
 * `originWorker` is the causer; a payload's own `workerId` is the
 * subject, and for a tool-driven spawn the two differ (that difference
 * is the causal edge, see `docs/architecture.md`). Both must be declared
 * here: a zod object strips undeclared keys.
 */
export const DomainEventSchema = z.object({
  seq: z.number(),
  ts: z.number(),
  originWorker: z.string().optional(),
  causeSeq: z.number().optional(),
  type: z.string(),
  payload: z.unknown(),
});

/** An event envelope whose payload has not been validated (wildcard subscribers, backfill rows). */
export type DomainEvent = Readonly<z.output<typeof DomainEventSchema>>;

/** An event of type `K` whose payload passed that type's schema (`#lib/event-payloads`). */
export type TypedDomainEvent<K extends EventType> = Readonly<
  Omit<DomainEvent, "type" | "payload"> & { type: K; payload: EventPayload<K> }
>;

const EVENT_CHANNEL = "swarm://events";
/** Server page size for `events_since`: a full page means "ask again". */
const PAGE_LIMIT = 5000;
/** First retry delay after a failed backfill; doubles per consecutive failure. */
const BACKFILL_RETRY_BASE_MS = 250;
/**
 * Failed backfills in a row before the gap is given up: the first
 * attempt plus five retries, waiting 0.25, 0.5, 1, 2 and 4 s after each
 * failure (7.75 s of waiting in all). Until then every live event stays
 * buffered, in order; after it, the buffered events are delivered and
 * the missing range is logged, so a backend that cannot serve
 * `events_since` does not freeze the UI.
 */
const MAX_BACKFILL_ATTEMPTS = 6;
/** Just enough of a backfill row to page past it. */
const PageCursorSchema = z.object({ seq: z.number() });

type Handler = (e: DomainEvent) => void;

const handlers = new Map<string, Set<Handler>>();
const wildcard = new Set<Handler>();
let lastSeq = 0;
let backfilling = false;
/** Live events that arrive while a backfill is in flight or waiting to retry, flushed seq-sorted after. */
let pending: DomainEvent[] = [];
let failedBackfills = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * The highest seq dispatched so far: the cursor `dispatch()` dedups
 * against, including after an ephemeral-gap skip-ahead. `wsTransport`
 * (`#lib/transport`) sends it as `hello{lastSeq}` on every reconnect, so
 * the daemon replays exactly what this tab has not processed.
 *
 * A function, not an exported `let`: it is only called from function
 * bodies, which keeps the `transport` → `event-bus` → `tauri` import
 * cycle safe whatever the module evaluation order.
 */
export function getLastSeq(): number {
  return lastSeq;
}

/**
 * Subscribes to one event type. The handler receives only events whose
 * payload passed that type's schema, already parsed. Returns the
 * unsubscribe function.
 */
export function onEvent<K extends EventType>(
  type: K,
  handler: (e: TypedDomainEvent<K>) => void,
): () => void;
/** Subscribes to every event, with the raw (unvalidated) payload. */
export function onEvent(type: "*", handler: Handler): () => void;
export function onEvent(type: string, handler: Handler): () => void {
  return subscribe(type, handler);
}

function subscribe(type: string, handler: Handler): () => void {
  let set = type === "*" ? wildcard : handlers.get(type);
  if (set === undefined) {
    set = new Set();
    handlers.set(type, set);
  }
  set.add(handler);
  return () => {
    set.delete(handler);
  };
}

function deliver(subscribers: Iterable<Handler>, e: DomainEvent): void {
  for (const h of subscribers) {
    try {
      h(e);
    } catch (err) {
      console.error("event-bus: handler threw", err);
    }
  }
}

function dispatch(e: DomainEvent): void {
  if (e.seq <= lastSeq) return; // already seen (live/backfill race)
  lastSeq = e.seq;

  const typed = handlers.get(e.type);
  if (typed?.size && isEventType(e.type)) {
    // Parsed once per event, and only when someone is listening.
    const parsed = EVENT_PAYLOAD_SCHEMAS[e.type].safeParse(e.payload);
    if (parsed.success) deliver(typed, { ...e, payload: parsed.data });
    else console.error(`event-bus: invalid ${e.type} payload at seq ${e.seq}`, parsed.error.issues);
  }
  deliver(wildcard, e);
}

/**
 * Gap check, then dispatch or buffer: the one decision point for every
 * event, live or flushed after a backfill, so a gap found mid-flush is
 * handled exactly like a live one.
 */
function handleIncoming(e: DomainEvent): void {
  if (backfilling || retryTimer !== null) {
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

/**
 * Advances `lastSeq` to just before the earliest buffered event when the
 * gap in front of it cannot be filled, so the flush does not re-detect
 * it. Anchored to a seq already in hand, never a guess, so `dispatch`'s
 * dedup cannot swallow that event.
 */
function skipGap(buffered: readonly DomainEvent[], why: string): void {
  const first = buffered[0];
  if (first === undefined || first.seq <= lastSeq + 1) return;
  console.debug(`event-bus: gap after seq ${lastSeq} ${why}; skipping ahead to seq ${first.seq}`);
  lastSeq = first.seq - 1;
}

async function backfill(afterSeq: number): Promise<void> {
  if (backfilling) return;
  backfilling = true;
  // `events_since` is authoritative: it throws (proves nothing) or returns
  // everything persisted past the cursor. An empty page therefore means
  // the rest of the gap is ephemeral by design (terminal-source
  // `worker_input`, metrics or log traffic): nothing is being withheld.
  let outcome: "filled" | "ephemeral" | "failed" = "filled";
  try {
    let cursor = afterSeq;
    for (;;) {
      const page = z.array(z.unknown()).parse(await invoke("events_since", { afterSeq: cursor }));
      if (page.length === 0) {
        outcome = "ephemeral";
        break;
      }
      for (const raw of page) {
        const parsed = DomainEventSchema.safeParse(raw);
        if (parsed.success) dispatch(parsed.data);
        else console.error("event-bus: skipped an invalid backfill row", parsed.error.issues);
      }
      if (page.length < PAGE_LIMIT) break;
      // The next page starts after this page's last row, valid or not.
      const last = PageCursorSchema.safeParse(page.at(-1));
      if (!last.success || last.data.seq <= cursor) break;
      cursor = last.data.seq;
    }
  } catch (err) {
    outcome = "failed";
    console.error("event-bus: backfill failed:", err);
  }
  backfilling = false;

  if (outcome === "failed") {
    failedBackfills++;
    if (failedBackfills < MAX_BACKFILL_ATTEMPTS) {
      // Keep buffering; a retry storm against a backend that is down helps nobody.
      retryTimer = setTimeout(
        () => {
          retryTimer = null;
          void backfill(lastSeq);
        },
        BACKFILL_RETRY_BASE_MS * 2 ** (failedBackfills - 1),
      );
      return;
    }
  }
  const toFlush = pending.splice(0).sort((a, b) => a.seq - b.seq);
  if (outcome === "failed") {
    console.error(
      `event-bus: backfill after seq ${lastSeq} failed ${failedBackfills} times; giving up on the missing events`,
    );
    skipGap(toFlush, "could not be backfilled");
  } else if (outcome === "ephemeral") {
    skipGap(toFlush, "is entirely ephemeral");
  }
  failedBackfills = 0;
  // Through the gap check again: a gap that opened during the backfill
  // triggers a follow-up backfill instead of being dispatched over.
  for (const e of toFlush) handleIncoming(e);
}

/**
 * Connects the single ordered event stream; call once at app bootstrap.
 * A gap in `seq` triggers a backfill of persisted events through
 * `events_since` while later events wait, in order. Ephemeral events
 * (worker output, metrics, logs) are never persisted and are accepted as
 * lost across a gap. A failed backfill is retried with exponential
 * backoff and given up after {@link MAX_BACKFILL_ATTEMPTS} attempts.
 */
export async function connectEventBus(): Promise<() => void> {
  return listen<unknown>(EVENT_CHANNEL, (raw) => {
    const parsed = DomainEventSchema.safeParse(raw);
    if (!parsed.success) {
      console.error("event-bus: invalid envelope", parsed.error.issues);
      return;
    }
    handleIncoming(parsed.data);
  });
}

/**
 * Resolves with the first event matching `predicate` (the receipt
 * primitive), or rejects after `timeoutMs`.
 */
export function waitFor(
  predicate: (e: DomainEvent) => boolean,
  timeoutMs?: number,
): Promise<DomainEvent>;
/** Resolves with the first valid `type` event matching `predicate`, or rejects after `timeoutMs`. */
export function waitFor<K extends EventType>(
  type: K,
  predicate?: (e: TypedDomainEvent<K>) => boolean,
  timeoutMs?: number,
): Promise<TypedDomainEvent<K>>;
export function waitFor(
  typeOrPredicate: string | ((e: DomainEvent) => boolean),
  predicateOrTimeout?: number | ((e: DomainEvent) => boolean),
  typedTimeout?: number,
): Promise<DomainEvent> {
  const type = typeof typeOrPredicate === "string" ? typeOrPredicate : "*";
  const predicate =
    typeof typeOrPredicate === "function"
      ? typeOrPredicate
      : typeof predicateOrTimeout === "function"
        ? predicateOrTimeout
        : () => true;
  const timeoutMs =
    (typeof predicateOrTimeout === "number" ? predicateOrTimeout : typedTimeout) ?? 5000;
  const { promise, resolve, reject } = Promise.withResolvers<DomainEvent>();
  const timer = setTimeout(() => {
    off();
    reject(new Error(`waitFor timeout after ${timeoutMs}ms`));
  }, timeoutMs);
  const off = subscribe(type, (e) => {
    if (!predicate(e)) return;
    clearTimeout(timer);
    off();
    resolve(e);
  });
  return promise;
}

/** Test-only: clears subscriptions, seq tracking and any pending backfill retry. */
export function resetEventBus(): void {
  handlers.clear();
  wildcard.clear();
  lastSeq = 0;
  backfilling = false;
  pending = [];
  failedBackfills = 0;
  if (retryTimer !== null) clearTimeout(retryTimer);
  retryTimer = null;
}
