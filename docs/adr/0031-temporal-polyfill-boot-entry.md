# ADR-0031: Temporal is polyfilled by a boot entry module

- **Status:** Accepted
- **Date:** 2026-10-10

## Context

The app uses `Temporal` for timestamps, chart axes, the palette's frecency and workflow names. WKWebView
(macOS), WebKitGTK (Linux) and Safari ship no `Temporal`, and the app called it unguarded in seven
places, so those paths threw `ReferenceError` on every non-Windows desktop build and on Safari clients
of `swarmd --serve-ui`. `date-fns` was also in the tree for formatting.

## Decision

- `index.html` loads `src/boot.ts`, which awaits `ensureTemporal()` and only then `import()`s
  `main.tsx`. A static first import cannot guarantee ordering: a sibling module without top-level
  `await` runs before an async sibling settles. With the dynamic import, no module that touches
  `Temporal` evaluates before it exists.
- `ensureTemporal()` (`src/lib/polyfills.ts`) installs the `temporal-polyfill` implementation (ISO 8601
  and Gregorian calendars) as the global only when `globalThis.Temporal` is missing. It is its own
  on-demand chunk (about 20 kB gzip) that Chromium and WebView2 never fetch. Like the polyfill's
  `global` entry it installs the Temporal-aware `Intl.DateTimeFormat` and
  `Date.prototype.toTemporalInstant`.
- `date-fns` is removed. `src/lib/time.ts` formats relative times, elapsed spans, date-times and 24-hour
  clocks on `Temporal` plus `Intl.RelativeTimeFormat`, `Intl.DurationFormat` and `Intl.DateTimeFormat`.
  Spans are measured on the local wall clock so a day is a day across a DST change.
- Tests: the time helpers (locale- and zone-independent expectations), a unit test that deletes
  `Temporal` and checks the helpers give the same output on the polyfill, and a Playwright spec that
  boots the app with `Temporal` deleted.

## Consequences

- Every new use of a recent platform API must be checked against WebKit, not only Chromium; the same
  question applies to `Intl.DurationFormat`, `Error.isError` and iterator helpers.
- The app's first paint waits one extra module hop on engines without `Temporal`.
