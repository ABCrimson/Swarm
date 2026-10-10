import { describe, expect, it } from "vitest";
import { formatClock, formatDateTime, formatElapsed, formatRelativeTime } from "#lib/time";

// Expected strings come from Intl itself, so the tests hold in any locale;
// instants are built from local wall-clock times, so they hold in any zone.
const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
const duration = new Intl.DurationFormat(undefined, { style: "short" });

const at = (wallClock: string): Temporal.Instant =>
  Temporal.PlainDateTime.from(wallClock).toZonedDateTime(Temporal.Now.timeZoneId()).toInstant();

describe("formatRelativeTime", () => {
  const now = at("2026-10-10T12:00:00");

  it("says now under a minute", () => {
    expect(formatRelativeTime(at("2026-10-10T11:59:20"), now)).toBe(relative.format(0, "second"));
  });

  it("uses the largest unit, rounded", () => {
    expect(formatRelativeTime(at("2026-10-10T11:55:00"), now)).toBe(relative.format(-5, "minutes"));
    expect(formatRelativeTime(at("2026-10-10T10:10:00"), now)).toBe(relative.format(-2, "hours"));
    expect(formatRelativeTime(at("2026-10-09T09:00:00"), now)).toBe(relative.format(-1, "days"));
    expect(formatRelativeTime(at("2026-08-01T12:00:00"), now)).toBe(relative.format(-2, "months"));
    expect(formatRelativeTime(at("2024-09-01T12:00:00"), now)).toBe(relative.format(-2, "years"));
  });

  it("carries rounding into the next unit", () => {
    expect(formatRelativeTime(at("2026-10-10T11:00:20"), now)).toBe(relative.format(-1, "hours"));
  });

  it("tells a future instant as such", () => {
    expect(formatRelativeTime(at("2026-10-10T15:00:00"), now)).toBe(relative.format(3, "hours"));
  });

  it("defaults to the current time", () => {
    expect(formatRelativeTime(Temporal.Now.instant())).toBe(relative.format(0, "second"));
  });
});

describe("formatElapsed", () => {
  const start = at("2026-10-10T08:00:00");

  it("reads 0 min before the first minute and for a clock behind the start", () => {
    const zero = new Intl.DurationFormat(undefined, { style: "short", minutesDisplay: "always" });
    expect(formatElapsed(start, at("2026-10-10T08:00:59"))).toBe(zero.format({ minutes: 0 }));
    expect(formatElapsed(start, at("2026-10-10T07:59:00"))).toBe(zero.format({ minutes: 0 }));
  });

  it("truncates to minutes within a day", () => {
    expect(formatElapsed(start, at("2026-10-10T11:05:59"))).toBe(
      duration.format({ hours: 3, minutes: 5 }),
    );
  });

  it("drops to whole hours from a day on", () => {
    expect(formatElapsed(start, at("2026-10-12T12:45:00"))).toBe(
      duration.format({ days: 2, hours: 4 }),
    );
  });
});

describe("formatDateTime", () => {
  it("formats the local date and time to the second", () => {
    const instant = at("2026-10-10T08:05:09");
    const expected = new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "medium",
    }).format(instant.epochMilliseconds);
    expect(formatDateTime(instant)).toBe(expected);
  });
});

describe("formatClock", () => {
  it("is a 24-hour HH:mm:ss of the local wall clock", () => {
    expect(formatClock(at("2026-10-10T08:05:09.987"))).toBe("08:05:09");
    expect(formatClock(at("2026-10-10T23:59:00"))).toBe("23:59:00");
  });
});
