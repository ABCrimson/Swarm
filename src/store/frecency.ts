import * as z from "zod";
import { atomWithSettings } from "#store/persisted";

/** A single frecency record tracking usage count and recency. */
export interface FrecencyEntry {
  readonly uses: number;
  /** `Temporal.Instant` string of the last use. */
  readonly lastUsed: string;
}

const FrecencyEntrySchema = z.tuple([
  z.string(),
  z.object({
    uses: z.int().nonnegative(),
    lastUsed: z.string().refine((s) => {
      try {
        Temporal.Instant.from(s);
        return true;
      } catch {
        return false;
      }
    }, "Not A Temporal.Instant String"),
  }),
]);

/**
 * Persisted command-palette usage, keyed by command id — the backing
 * store of the palette's `modern-cmdk` frecency engine
 * (`#components/command/CommandPalette`), which computes the scores.
 * Stored as an array of `[commandId, FrecencyEntry]` tuples; a malformed
 * tuple is dropped on load without discarding the others, so a bad
 * `lastUsed` can never reach the palette's `Temporal.Instant.from`.
 */
export const frecencyAtom = atomWithSettings<Map<string, FrecencyEntry>>(
  "swarm:frecency",
  new Map(),
  {
    label: "Command Palette History",
    schema: z.array(z.unknown()).transform(
      (tuples) =>
        new Map(
          tuples.flatMap((tuple) => {
            const parsed = FrecencyEntrySchema.safeParse(tuple);
            return parsed.success ? [parsed.data] : [];
          }),
        ),
    ),
    serialize: (entries) => [...entries],
  },
);
