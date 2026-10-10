import { afterEach, describe, expect, it } from "vitest";
import { ensureTemporal } from "#lib/polyfills";
import { formatClock, formatDateTime, formatElapsed, formatRelativeTime } from "#lib/time";

// Node ships Temporal, so the rest of the suite runs on the native one.
// These tests delete it, as WebKit lacks it, and put back every global
// the polyfill replaces.
const native = globalThis.Temporal;
const saved = [
  [globalThis, "Temporal", Object.getOwnPropertyDescriptor(globalThis, "Temporal")],
  [Intl, "DateTimeFormat", Object.getOwnPropertyDescriptor(Intl, "DateTimeFormat")],
  [
    Date.prototype,
    "toTemporalInstant",
    Object.getOwnPropertyDescriptor(Date.prototype, "toTemporalInstant"),
  ],
] as const;

afterEach(() => {
  for (const [target, key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(target, key, descriptor);
    else Reflect.deleteProperty(target, key);
  }
});

/** The time helpers' output for fixed instants, on whichever `Temporal` is global. */
function sample(): string[] {
  const start = Temporal.Instant.from("2026-10-08T06:30:00Z");
  const end = Temporal.Instant.from("2026-10-10T11:47:31.250Z");
  return [
    formatRelativeTime(start, end),
    formatRelativeTime(Temporal.Instant.from("2026-10-10T09:00:00Z"), end),
    formatElapsed(start, end),
    formatElapsed(Temporal.Instant.from("2026-10-10T10:02:00Z"), end),
    formatDateTime(end),
    formatClock(end),
    end.toString(),
  ];
}

describe("ensureTemporal", () => {
  it("keeps a native Temporal", async () => {
    expect(native).toBeDefined();
    await ensureTemporal();
    expect(globalThis.Temporal).toBe(native);
  });

  it("installs the polyfill where Temporal is missing, and the app's time paths run on it", async () => {
    const expected = sample();
    Reflect.deleteProperty(globalThis, "Temporal");
    expect("Temporal" in globalThis).toBe(false);

    await ensureTemporal();

    expect(globalThis.Temporal).toBeDefined();
    expect(globalThis.Temporal).not.toBe(native);
    expect(new Date(0).toTemporalInstant().epochMilliseconds).toBe(0);
    expect(sample()).toEqual(expected);
  });
});
