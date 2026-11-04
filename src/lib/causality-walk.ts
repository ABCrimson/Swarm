// Backward causality walk: follows each event's `causeSeq` from a starting
// seq, ring first, then a single-row `events_since` backfill. Lives apart
// from the CausalityPanel component so editing either keeps Fast Refresh.

import * as z from "zod";
import { type DomainEvent, DomainEventSchema } from "#lib/event-bus";
import { errorMessage } from "#lib/is-error";
import { invoke } from "#lib/tauri";

/**
 * Hard cap on backward hops. Forward traversal (following a `causeSeq`
 * forward to everything it caused) is deliberately out of scope for v1
 * — this cap only bounds the backward walk against a pathological
 * chain; the engine's own invariant (provenance is recorded, never
 * inferred — see `EventSink::emit_with`'s doc) means a real cycle
 * should never occur, but a UI-side cap costs nothing and never trusts
 * that invariant blindly.
 */
export const MAX_CAUSALITY_HOPS = 50;

/**
 * Validates one `events_since` page at this seam, reusing
 * `event-bus.ts`'s canonical envelope shape. A malformed page is a
 * contract fault, not a miss: {@link resolveEvent} throws, and the walk
 * reports it in `failure` instead of throwing into render.
 */
const EventsSincePageSchema = z.array(DomainEventSchema);

/**
 * Resolves the event at `seq`: the bySeq ring first (the inspector's
 * fast path — populated by every non-telemetry envelope that has
 * flowed through this session, see `#store/provenance`), falling back
 * to a single-row `events_since` backfill on a miss (`limit: 1` — see
 * `docs/api.md#events_since`). Returns `null` when nothing is found at
 * that exact seq (a seq that was never persisted, or was pruned).
 * Rejects with the backfill's own error when `events_since` itself
 * fails, and with an "Unexpected Shape" error when its page fails
 * {@link EventsSincePageSchema}; neither is a miss.
 */
async function resolveEvent(
  seq: number,
  ring: ReadonlyMap<number, DomainEvent>,
): Promise<DomainEvent | null> {
  const cached = ring.get(seq);
  if (cached) return cached;

  const raw = await invoke<unknown>("events_since", { afterSeq: seq - 1, limit: 1 });
  const parsed = EventsSincePageSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error("Events Since Returned An Unexpected Shape.", { cause: parsed.error });
  }
  const row = parsed.data[0];
  if (!row || row.seq !== seq) return null;
  return row;
}

export interface CausalityWalkResult {
  /** Root-first order — index 0 is the earliest cause found; the last entry is the event at the walk's starting seq. */
  readonly rows: DomainEvent[];
  /** `true` when the walk stopped at {@link MAX_CAUSALITY_HOPS} rather than reaching a real root. */
  readonly truncated: boolean;
  /**
   * `true` when the walk stopped early because a lookup genuinely
   * missed (neither the ring nor a live `events_since` backfill found
   * the cited seq) — distinct from {@link truncated} (hit the hop cap)
   * and distinct from a real root (an event whose own `causeSeq` is
   * absent). Without this flag the topmost RENDERED row is
   * indistinguishable from an actual root — causality-by-omission: the
   * trace looks complete when it isn't. Mutually exclusive with
   * `truncated` by construction (a miss can only occur before the hop
   * cap is reached).
   */
  readonly incomplete: boolean;
  /** Message of a backfill that rejected or returned a malformed page (not a miss); null otherwise. */
  readonly failure: string | null;
}

/**
 * Walks backward from `startSeq` via each event's own `causeSeq`,
 * terminating on an absent `causeSeq` (a real root — typically
 * `agent_turn_started`, which never carries one) or
 * {@link MAX_CAUSALITY_HOPS} hops, whichever comes first. A lookup miss
 * ends the walk early and sets {@link CausalityWalkResult.incomplete} —
 * the rows already collected are still true, just explicitly marked as
 * possibly short of the root rather than silently passed off as complete.
 * A backfill that rejects (daemon down, transport error) or returns a
 * malformed page also ends the walk, but is reported in
 * {@link CausalityWalkResult.failure}, not as a miss.
 *
 * `signal` stops the walk between hops (no further `events_since` calls)
 * once aborted; the pending promise then rejects with the abort reason.
 */
export async function walkCausalityChain(
  startSeq: number,
  ring: ReadonlyMap<number, DomainEvent>,
  signal?: AbortSignal,
): Promise<CausalityWalkResult> {
  const chain: DomainEvent[] = []; // collected most-recent-first
  let currentSeq: number | undefined = startSeq;
  let incomplete = false;
  let failure: string | null = null;

  while (currentSeq !== undefined && chain.length < MAX_CAUSALITY_HOPS) {
    signal?.throwIfAborted();
    let event: DomainEvent | null;
    try {
      event = await resolveEvent(currentSeq, ring);
    } catch (err) {
      signal?.throwIfAborted();
      failure = errorMessage(err);
      break;
    }
    if (!event) {
      incomplete = true; // genuine lookup miss -- stop with whatever's already collected
      break;
    }
    chain.push(event);
    currentSeq = event.causeSeq;
  }

  const truncated = !incomplete && currentSeq !== undefined && chain.length >= MAX_CAUSALITY_HOPS;
  return { rows: chain.toReversed(), truncated, incomplete, failure };
}
