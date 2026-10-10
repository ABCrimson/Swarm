# ADR-0036: One model catalogue, priced per attempt

- **Status:** Accepted
- **Date:** 2026-10-10

## Context

The webview chat needs the same facts about each Claude model in several places: the picker, Settings,
request building, ship prose and cost accounting. Prices are not one ratio (cache reads cost 0.025x
input on Fable 5.1 and Mythos 5.1, 0.05x on Opus 5.5 and Sonnet 5.5, 0.1x on Haiku 5.5's short-prompt
tier), Haiku 5.5 has a long-prompt tier, and a request can be served by a different model than the
one asked for.

## Decision

`src/lib/models.ts` is the only list. It holds Fable 5.1, Mythos 5.1, Opus 5.5, Sonnet 5.5 and Haiku
5.5 under persisted keys (`fable`, `mythos`, `opus`, `sonnet`, `haiku`), which a newer model keeps; only
its id, label and prices change. Each entry carries its context window, output limit, rates and
capability flags (adaptive thinking, effort, refusal fallback, mid-conversation system messages, an
access gate).

- Only Haiku 5.5 has a `longPrompt` tier. A request whose input tokens, counting cache reads and
  cache writes, exceed 100K is billed at the long-prompt rates for every token of that request. Every
  other model bills its whole 1M window at one rate.
- Cost is estimated per attempt. With server-side refusal fallbacks (`fallbacks: "default"`, beta
  `server-side-fallback-2026-07-01`), `usage.iterations` is priced entry by entry by the model that
  served it. Fallback targets the picker never offers (`claude-opus-4-8`, `claude-opus-5`,
  `claude-sonnet-5`) have rows in a pricing-only table. An attempt served by a model with no row is priced at the requested model's rates (`priceUsage` in `src/lib/anthropic.ts`); only when the requested model has no rates either is the cost 0.
- Mythos 5.1 is gated: selecting it warns that access is needed but does not block.

## Consequences

- A price or limit change is one edit, checked against the pricing and models pages; the header
  comment records the verification date.
- Haiku 5.5 has no server-side fallback, so a declined request stays declined.
- Mythos 5.1's fallback targets are not published; an attempt served by a model without a row is
  priced at the requested model's rates.

See [AI chat paths](../architecture.md#ai-chat-paths).
