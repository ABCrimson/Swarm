/**
 * Claude model catalog — the single source of truth for model IDs,
 * labels, limits, prices and per-model request capabilities on the
 * webview AI path (Settings, ModelSelector, the chat engine in
 * `#lib/ai-chat`, ship prose, cost accounting). No other module keeps
 * its own model list: widen this catalog and everything else derives
 * from it.
 *
 * Figures verified 2026-10-10 against platform.claude.com: the models
 * overview (https://platform.claude.com/docs/en/models/overview), the
 * Sonnet 5.5 and Haiku 5.5 model pages
 * (https://platform.claude.com/docs/en/models/sonnet-5-5/overview,
 * https://platform.claude.com/docs/en/models/haiku-5-5/overview), the
 * pricing page (https://platform.claude.com/docs/en/about-claude/pricing),
 * the prompt-caching page (mid-conversation system messages) and the
 * refusals-and-fallback page
 * (https://platform.claude.com/docs/en/build-with-claude/refusals-and-fallback).
 * Current lineup: Fable 5.1, Mythos 5.1 (verified organizations only, via Anthropic's verification programs such as the Cyber Verification Program: Mythos 5.1 overview, 2026-10-10),
 * Opus 5.5, Sonnet 5.5 (released 2026-09-28) and Haiku 5.5 (released
 * 2026-10-07). Every model has a 1M context window and 128K max output;
 * all take adaptive thinking and `effort`. Claude 4.6 and later models
 * except Haiku 5.5 bill the whole 1M window at the standard rate; Haiku
 * 5.5 alone is priced by prompt length ({@link LongPromptPricing}).
 *
 * The {@link ModelKey} names are persisted (`selectedModelAtom`, worker
 * agent metadata, session templates), so a newer model replaces an
 * entry's `id`/`label`/prices, never its key.
 *
 * @module models
 */

import { toast } from "sonner";

/** Stable catalog keys, in display order. Persisted — never rename one. */
export const MODEL_KEYS = ["fable", "mythos", "opus", "sonnet", "haiku"] as const;

/** Stable identifier for a catalog entry. */
export type ModelKey = (typeof MODEL_KEYS)[number];

/** An access gate a model requires beyond a valid API key. */
export type ModelGate = "glasswing";

/**
 * The long-prompt price tier. A request whose prompt is longer than
 * {@link LongPromptPricing.thresholdTokens} pays these rates for every
 * token of that request. "A request's prompt length counts all of its
 * input tokens, including cache reads and cache writes", and each
 * request is priced on its own (pricing page, 2026-10-10).
 */
export interface LongPromptPricing {
  /** Prompts strictly longer than this many input tokens are billed at the long-prompt rates. */
  readonly thresholdTokens: number;
  /** USD per million uncached input tokens (5-minute cache writes bill at 1.25x this). */
  readonly inputPerMTok: number;
  /** USD per million cache-read input tokens. */
  readonly cacheReadPerMTok: number;
  /** USD per million output tokens. */
  readonly outputPerMTok: number;
}

/** Metadata for a single Claude model. */
export interface ModelInfo {
  /** The Claude API model ID to pass as `model` in requests. */
  readonly id: string;
  /** Human-readable display label. */
  readonly label: string;
  /** Short Title Case description for the model picker UI. */
  readonly description: string;
  /** Context window size in tokens. */
  readonly contextWindow: number;
  /** Maximum output tokens per response (thinking included). */
  readonly maxOutputTokens: number;
  /** USD per million uncached input tokens (5-minute cache writes bill at 1.25x this). */
  readonly inputPerMTok: number;
  /** USD per million cache-read input tokens — not a fixed ratio: 0.025x on Fable 5.1 and Mythos 5.1, 0.05x on Opus 5.5 and Sonnet 5.5, 0.1x on Haiku 5.5's short-prompt tier. */
  readonly cacheReadPerMTok: number;
  /** USD per million output tokens (thinking tokens bill as output). */
  readonly outputPerMTok: number;
  /**
   * Higher rates for requests whose prompt exceeds a token threshold.
   * Only Haiku 5.5 has one; absent means one flat rate at any length.
   */
  readonly longPrompt?: LongPromptPricing;
  /**
   * Takes `thinking: { type: "adaptive" }`. Every current model does
   * (Fable/Mythos 5.1 and Opus 5.5 cannot turn thinking off at all).
   */
  readonly adaptiveThinking: boolean;
  /** Accepts `output_config.effort` (every current model does). */
  readonly effort: boolean;
  /**
   * Runs safety classifiers whose false positives the server-side
   * `fallbacks: "default"` opt-in (beta `server-side-fallback-2026-07-01`)
   * rescues by re-running a declined request on a recommended model.
   * Haiku 5.5 has classifiers but no server-side fallback: with
   * `"default"` a declined request stays declined.
   */
  readonly refusalFallback: boolean;
  /** Accepts mid-conversation `role: "system"` messages (every current model; legacy Sonnet 5 did not). */
  readonly systemMessages: boolean;
  /** Access gate required beyond a valid API key, if any (Mythos 5.1 → Anthropic verification programs; `glasswing` is a persisted legacy key). */
  readonly gated?: ModelGate;
}

/** The current Claude model catalog, keyed by a stable short name. */
export const CLAUDE_MODELS: Readonly<Record<ModelKey, ModelInfo>> = {
  fable: {
    id: "claude-fable-5-1",
    label: "Claude Fable 5.1",
    description: "Most Capable — Long-Horizon Reasoning And Agentic Work",
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    inputPerMTok: 10,
    cacheReadPerMTok: 0.25,
    outputPerMTok: 50,
    adaptiveThinking: true,
    effort: true,
    refusalFallback: true,
    systemMessages: true,
  },
  mythos: {
    id: "claude-mythos-5-1",
    label: "Claude Mythos 5.1",
    description: "Most Capable — Available Exclusively Through Project Glasswing",
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    inputPerMTok: 10,
    // 0.025x cache reads, same as Fable 5.1 (pricing page, 2026-10-10).
    cacheReadPerMTok: 0.25,
    outputPerMTok: 50,
    adaptiveThinking: true,
    effort: true,
    refusalFallback: true,
    systemMessages: true,
    gated: "glasswing",
  },
  opus: {
    id: "claude-opus-5-5",
    label: "Claude Opus 5.5",
    description: "Highly Capable — Long-Running Agentic Coding And Deep Analysis",
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    inputPerMTok: 4,
    cacheReadPerMTok: 0.2,
    outputPerMTok: 20,
    adaptiveThinking: true,
    effort: true,
    refusalFallback: true,
    systemMessages: true,
  },
  sonnet: {
    id: "claude-sonnet-5-5",
    label: "Claude Sonnet 5.5",
    description: "Balanced — Fast Reasoning For Everyday Orchestration",
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    inputPerMTok: 2,
    cacheReadPerMTok: 0.1,
    outputPerMTok: 10,
    adaptiveThinking: true,
    effort: true,
    refusalFallback: true,
    systemMessages: true,
  },
  haiku: {
    id: "claude-haiku-5-5",
    label: "Claude Haiku 5.5",
    description: "Fastest — Lightweight Tasks At The Lowest Cost",
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    inputPerMTok: 0.1,
    cacheReadPerMTok: 0.01,
    outputPerMTok: 0.5,
    longPrompt: {
      thresholdTokens: 100_000,
      inputPerMTok: 0.5,
      cacheReadPerMTok: 0.05,
      outputPerMTok: 2.5,
    },
    adaptiveThinking: true,
    effort: true,
    refusalFallback: false,
    systemMessages: true,
  },
};

const MODELS_BY_ID: ReadonlyMap<string, ModelInfo> = new Map(
  MODEL_KEYS.map((key) => [CLAUDE_MODELS[key].id, CLAUDE_MODELS[key]]),
);

/** The rate fields of {@link ModelInfo}, for a model priced but not offered. */
type PricingOnly = Pick<ModelInfo, "inputPerMTok" | "cacheReadPerMTok" | "outputPerMTok"> &
  Partial<Pick<ModelInfo, "longPrompt">>;

/**
 * Pricing-only rates for models the app never requests but the API can
 * serve as a server-side refusal-fallback target, so per-attempt usage
 * (`usage.iterations`) is priced by the model that actually served each
 * attempt instead of the requested model's rates. Kept out of the picker
 * catalog. Permitted targets per catalog model with `refusalFallback`
 * (fallback-credit page,
 * https://platform.claude.com/docs/en/build-with-claude/fallback-credit,
 * and the Fable 5.1 what's-new page, 2026-10-10):
 * - Fable 5.1 and Opus 5.5: `claude-opus-4-8` and `claude-opus-5`.
 * - Sonnet 5.5: `claude-sonnet-5`.
 * - Mythos 5.1: its targets are not listed on those pages; the Models API
 *   reports them as `allowed_fallback_models` under the
 *   `server-side-fallback-2026-07-01` beta header (needs Mythos access,
 *   not checked here). An attempt served by a model with no row here is
 *   priced at the requested model's rates, which for Mythos equal Fable 5.1's.
 * - Haiku 5.5 has no server-side fallback.
 * Rates from the pricing page
 * (https://platform.claude.com/docs/en/about-claude/pricing, 2026-10-10):
 * Opus 5 and Opus 4.8 are $5 input / $0.50 cache read / $25 output;
 * Sonnet 5 is $2 / $0.20 / $10.
 */
const FALLBACK_PRICING: ReadonlyMap<string, PricingOnly> = new Map([
  ["claude-opus-4-8", { inputPerMTok: 5, cacheReadPerMTok: 0.5, outputPerMTok: 25 }],
  ["claude-opus-5", { inputPerMTok: 5, cacheReadPerMTok: 0.5, outputPerMTok: 25 }],
  ["claude-sonnet-5", { inputPerMTok: 2, cacheReadPerMTok: 0.2, outputPerMTok: 10 }],
]);

/** Looks up a model's catalog entry by its Claude API model ID. Returns `undefined` if unknown. */
export function getModelById(id: string): ModelInfo | undefined {
  return MODELS_BY_ID.get(id);
}

/** Whether {@link estimateCostUsd} has rates for this model (catalog or fallback target). */
export function hasPricing(id: string): boolean {
  return MODELS_BY_ID.has(id) || FALLBACK_PRICING.has(id);
}

/** Token counts from a response's `usage` block (cache fields are `null` when absent). */
export interface UsageTokens {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cache_creation_input_tokens?: number | null;
  readonly cache_read_input_tokens?: number | null;
}

/**
 * Estimates the USD cost of one response from its `usage` block, priced
 * at the catalog rates of `modelId`: uncached input at the input rate,
 * 5-minute cache writes at 1.25x it, cache reads at the model's own
 * cache-read rate, output (thinking included) at the output rate. A
 * model with a {@link LongPromptPricing} tier (Haiku 5.5) prices the
 * whole request at the long-prompt rates once input + cache reads +
 * cache writes exceed its threshold.
 * Returns `0` for a model with no rates (outside the catalog and the
 * fallback-target table) rather than guessing.
 */
export function estimateCostUsd(modelId: string, usage: UsageTokens): number {
  const model: PricingOnly | undefined = getModelById(modelId) ?? FALLBACK_PRICING.get(modelId);
  if (!model) return 0;
  const cacheWrites = usage.cache_creation_input_tokens ?? 0;
  const cacheReads = usage.cache_read_input_tokens ?? 0;
  const { longPrompt } = model;
  const rates =
    longPrompt && usage.input_tokens + cacheWrites + cacheReads > longPrompt.thresholdTokens
      ? longPrompt
      : model;
  const microDollars =
    usage.input_tokens * rates.inputPerMTok +
    cacheWrites * rates.inputPerMTok * 1.25 +
    cacheReads * rates.cacheReadPerMTok +
    usage.output_tokens * rates.outputPerMTok;
  return microDollars / 1_000_000;
}

/** Formats a token count as a compact label, e.g. `1M` / `200K`. */
function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${tokens / 1_000_000}M`;
  return `${Math.round(tokens / 1000)}K`;
}

/** Formats a model's context window as a compact, Title Case label, e.g. "1M Context". */
export function formatContextLabel(contextWindow: number): string {
  return `${formatTokenCount(contextWindow)} Context`;
}

/** Formats a model's max output as a compact, Title Case label, e.g. "128K Max Output". */
export function formatMaxOutputLabel(maxOutputTokens: number): string {
  return `${formatTokenCount(maxOutputTokens)} Max Output`;
}

/**
 * Fires the access-gate warning toast for a gated model selection
 * (currently just Mythos) — selection itself is still allowed, this is a
 * notice, not a block. No-ops (and returns `false`) for non-gated models.
 *
 * Shared by both selection paths — the `ModelSelector` listbox and the
 * Settings model cards — so the gating check and copy live once. Callers
 * with their own default "selected" toast (e.g. Settings' "Switched To
 * X") should skip it when this returns `true`: one toast per selection,
 * never two.
 */
export function warnIfModelGated(model: ModelInfo): boolean {
  if (!model.gated) return false;
  toast.warning(`${model.label} Requires Project Glasswing Access`);
  return true;
}
