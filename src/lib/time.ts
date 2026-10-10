// ── Time Formatting Helpers ─────────────────────────
// Human-readable times on Temporal + Intl: no date library.
// Spans are measured on the local wall clock (`Temporal.Now.timeZoneId()`),
// so a calendar day is a day even across a DST change. WebKit has no
// native Temporal; `src/boot.ts` installs the polyfill before any of this
// runs. The `Intl` formatters below are built at module load, so they get
// epoch milliseconds or plain records, never Temporal objects.

const RELATIVE = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
const DURATION = new Intl.DurationFormat(undefined, { style: "short" });
/** {@link DURATION}, but an empty span reads "0 min" instead of "". */
const DURATION_ZERO = new Intl.DurationFormat(undefined, {
  style: "short",
  minutesDisplay: "always",
});
const DATE_TIME = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" });

/** Units a relative time is told in, largest first (calendar-aware via the zoned difference). */
const RELATIVE_UNITS = ["years", "months", "days", "hours", "minutes"] as const;

/**
 * How far `then` lies from `now`, in the largest whole unit, rounded:
 * "now", "5 minutes ago", "yesterday", "in 3 hours", "last month".
 * Rounding carries into the next unit, so 59.5 minutes reads "1 hour ago".
 */
export function formatRelativeTime(
  then: Temporal.Instant,
  now: Temporal.Instant = Temporal.Now.instant(),
): string {
  const timeZone = Temporal.Now.timeZoneId();
  const from = now.toZonedDateTimeISO(timeZone);
  const to = then.toZonedDateTimeISO(timeZone);
  const span = from.until(to, {
    largestUnit: "years",
    smallestUnit: "minutes",
    roundingMode: "trunc",
  });
  const unit = RELATIVE_UNITS.find((u) => span[u] !== 0);
  if (unit === undefined) return RELATIVE.format(0, "second");
  const rounded = from.until(to, {
    largestUnit: "years",
    smallestUnit: unit,
    roundingMode: "halfExpand",
  });
  const top = RELATIVE_UNITS.find((u) => rounded[u] !== 0) ?? unit;
  return RELATIVE.format(rounded[top], top);
}

/**
 * The time from `start` to `end` for a live readout such as an uptime:
 * "0 min", "42 min", "3 hr, 5 min", then whole hours from a day on
 * ("2 days, 4 hr"). Truncated, so it never runs ahead of the clock.
 */
export function formatElapsed(start: Temporal.Instant, end: Temporal.Instant): string {
  const timeZone = Temporal.Now.timeZoneId();
  const from = start.toZonedDateTimeISO(timeZone);
  const to = end.toZonedDateTimeISO(timeZone);
  let span = from.until(to, {
    largestUnit: "days",
    smallestUnit: "minutes",
    roundingMode: "trunc",
  });
  if (span.sign <= 0) return DURATION_ZERO.format({ minutes: 0 });
  if (span.days > 0) {
    span = from.until(to, { largestUnit: "days", smallestUnit: "hours", roundingMode: "trunc" });
  }
  return DURATION.format(span);
}

/** A localized date and time to the second, e.g. "Oct 10, 2026, 12:00:00 PM". */
export function formatDateTime(instant: Temporal.Instant): string {
  return DATE_TIME.format(instant.epochMilliseconds);
}

/** The local wall-clock time as a fixed 24-hour "HH:mm:ss", whatever the locale. */
export function formatClock(instant: Temporal.Instant): string {
  return instant
    .toZonedDateTimeISO(Temporal.Now.timeZoneId())
    .toPlainTime()
    .toString({ smallestUnit: "second" });
}
