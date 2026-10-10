# ADR-0032: The React Compiler runs through the Oxc WASI binding

- **Status:** Accepted (supersedes the Babel fallback path)
- **Date:** 2026-10-10

## Context

Automatic memoisation comes from the React Compiler, run through the Oxc port
(`oxc-transform-react`) by `@vitejs/plugin-react` with `compiler: true`. On 2026-09-23 a Babel
fallback (`@babel/core` 7.29.7 with `babel-plugin-react-compiler`) covered hosts where Windows Smart App
Control refuses the native Oxc binding. It pinned Babel below 8 because on Babel 8 every
`babel-plugin-react-compiler` build skips components with destructured defaults
(facebook/react#36868), and it was the one hold that kept the whole dependency stack from being current.

## Decision

`oxc-transform-react` falls back to its WASI build when the native binding cannot load. With
`@oxc-transform-react/binding-wasm32-wasip1` installed, `NAPI_RS_FORCE_WASI=true pnpm check:compiler`
passes on a Smart App Control host with the same result as native (67 of 68 modules memoised, 137 cache
allocations, 5 of 5 required components). So:

- `vite.config.ts` is `react({ compiler: true })`; the Babel branch, its environment switch and the
  load-failure probe are gone.
- `@babel/core`, `@rolldown/plugin-babel` and `babel-plugin-react-compiler` are removed, together with
  the Babel hold.
- `pnpm check:compiler` reports which binding ran (native or `wasm32-wasip1`) and fails when `Button`,
  `Pill`, `Spinner`, `MetricCard` or `SplitPane` ship uncompiled. CI runs it with
  `NAPI_RS_FORCE_WASI=true`.
- The WASI binding's `emnapi` is lifted to `2.0.0-alpha.6` by a scoped override.

## Consequences

- Compilation on a blocked host is slower than native.
- The only remaining dependency hold is the Node nightly, whose newest builds lack a Windows x64
  artifact.
- Source must stay compiler-clean: no manual `useMemo` or `useCallback`, no `try` blocks in hooks the
  compiler cannot handle (the ship hook keeps its async work in module-level helpers for that reason).
