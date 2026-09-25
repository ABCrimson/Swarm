import { atom } from "jotai";
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
 * Persisted command-palette usage, keyed by command id. Stored as an
 * array of `[commandId, FrecencyEntry]` tuples; a malformed tuple is
 * dropped on load without discarding the others, so a bad `lastUsed`
 * can never reach `Temporal.Instant.from` in {@link frecencyScoreAtom}.
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

/** Hours for a command's frecency weight to halve. */
const HALF_LIFE_HOURS = 72;

/** Derived atom that computes a frecency score for sorting commands. */
export const frecencyScoreAtom = atom((get) => {
  const entries = get(frecencyAtom);

  return (commandId: string): number => {
    const entry = entries.get(commandId);
    if (!entry) return 0;
    const hoursAgo = Temporal.Now.instant()
      .since(Temporal.Instant.from(entry.lastUsed))
      .total("hours");
    return entry.uses * 2 ** (-hoursAgo / HALF_LIFE_HOURS);
  };
});
