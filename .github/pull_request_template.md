<!--
Title: a Conventional Commit, e.g. `fix(ship): keep the preflight bound to its worker`.
Breaking changes: `feat!:` / `fix!:` in the title plus a `BREAKING CHANGE:` footer.
-->

## What And Why

<!-- What changed, and the problem it solves. Link issues: `Closes #123`. -->

## How It Was Verified

<!-- Commands you ran and what they printed; before/after screenshots for UI changes. -->

## Checklist

- [ ] Frontend gates pass: `pnpm typecheck`, `pnpm exec biome ci .`, `pnpm test`, `pnpm build`, `pnpm check:compiler`, `pnpm test:e2e`
- [ ] Rust gates pass: `cargo fmt --all --check`, `cargo clippy --workspace --all-targets --locked -- -D warnings`, `cargo test --workspace --locked`, `cargo deny check`
- [ ] New behavior and every bug fix come with a test
- [ ] New or changed Tauri commands, events or `swarmd` frames are documented in `docs/api.md`
- [ ] New public Rust items have `///` docs; lints are silenced only with `#[expect(..., reason = "...")]`
- [ ] House rules (`AGENTS.md`): exact pins, pnpm only, `parking_lot` locks, no blocking work on Tokio workers, no manual `useMemo`/`useCallback`/`memo`/`forwardRef`, `#` subpath imports, OKLCH colors, Title Case UI strings
- [ ] Docs and `CHANGELOG.md` are updated where behavior changed
