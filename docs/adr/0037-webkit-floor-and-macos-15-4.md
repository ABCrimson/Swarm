# ADR-0037: The webview floor is WebKit 18.4, so macOS 15.4

- **Status:** Accepted
- **Date:** 2026-10-10

## Context

The frontend builds for `esnext` with no syntax downleveling and calls recent platform APIs without
guards: iterator helpers, `Error.isError`, `RegExp.escape`. WebView2 on Windows is evergreen
Chromium, WebKitGTK follows the Linux distribution, and WKWebView on macOS is the system WebKit,
updated with the OS or a standalone Safari update. Safari 18.4 is the first WebKit with all three.
[ADR-0031](0031-temporal-polyfill-boot-entry.md) covers the one gap that is polyfilled, `Temporal`.

## Decision

The supported webview is WebKit 18.4 class or newer. `bundle.macOS.minimumSystemVersion` in
`tauri.conf.json` is `15.4`, the oldest macOS that ships it with the OS (Safari 18.4 also installs on
macOS 13 and 14, but `Info.plist` can only require an OS version). `vite.config.ts` records the same
floor.

Playwright runs Chromium by default and has opt-in `webkit` and `firefox` projects
(`default: false`); the suite passes on all three except one arrow-key focus-ring test marked `fixme` on WebKit (`e2e/settings.spec.ts`), and CI runs it with `--shuffle` so no spec depends
on order.

## Consequences

- macOS 13 and 14 users cannot install the app, even with a current standalone Safari.
- A new use of a recent API is checked against WebKit before it ships; the polyfill-or-avoid list
  grows only by decision.
- Playwright's WebKit is not WKWebView, so the opt-in project narrows the gap but does not close it.
